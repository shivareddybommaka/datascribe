/**
 * Stage 5 — normalise and code (REQUIREMENTS.md §7, §8). Diagnoses → ICD-10-CM, procedures → HCPCS,
 * medications → RxNorm (+ openFDA label), each code + a MedlinePlus definition when there is one.
 *
 * Every term goes through deidentifyTerm() with the case's known identifiers before any adapter
 * call (§8.4); the adapters de-identify again. A failed lookup leaves that term uncoded rather than
 * failing the case (D-078): the summarizer still sees the event and can code it by hand.
 */
import {
  deidentifyTerm,
  type CodeMatch,
  type ConsumerHealthInfo,
  type DiagnosisCoder,
  type DrugInfoProvider,
  type MedicationNormalizer,
  type ProcedureCoder,
} from '@datascribe/medical-data';
import type { ExtractedTerms } from './extract-events';

export interface Coders {
  diagnosis: DiagnosisCoder;
  procedure: ProcedureCoder;
  medication: MedicationNormalizer;
  drugInfo: DrugInfoProvider;
  consumerHealth: ConsumerHealthInfo;
}

/** What `ClinicalEvent.codes` holds. Never the raw term: the column isn't encrypted. */
export interface EventCode extends CodeMatch {
  definition?: { title: string; summary: string; url: string };
  drugLabel?: { indications?: string; warnings?: string; source: string };
}

export interface CodingStats {
  coded: number;
  uncoded: number;
  refused: number;
  failed: number;
}

type Kind = keyof ExtractedTerms;

/**
 * One coder per case run: memoises lookups by (kind, cleaned term) so a term repeated on many pages
 * is looked up once, and keeps counts of distinct terms for the job record (counts only, no terms).
 */
export class CaseCoder {
  readonly stats: CodingStats = { coded: 0, uncoded: 0, refused: 0, failed: 0 };
  private readonly memo = new Map<string, Promise<EventCode | null>>();

  constructor(
    private readonly coders: Coders,
    /** patient name, case number, matter, reference… stripped from every term */
    private readonly knownIdentifiers: string[] = [],
  ) {}

  async codeTerms(terms: ExtractedTerms): Promise<EventCode[]> {
    const out: EventCode[] = [];
    for (const kind of ['diagnoses', 'procedures', 'medications'] as const) {
      for (const raw of terms[kind]) {
        const code = await this.codeOne(kind, raw);
        if (code && !out.some((c) => c.system === code.system && c.code === code.code)) {
          out.push(code);
        }
      }
    }
    return out;
  }

  private async codeOne(kind: Kind, raw: string): Promise<EventCode | null> {
    const clean = deidentifyTerm(raw, { knownIdentifiers: this.knownIdentifiers });
    if (!clean.ok) {
      this.stats.refused++;
      return null;
    }
    const key = `${kind}:${clean.term.toLowerCase()}`;
    let pending = this.memo.get(key);
    if (!pending) {
      pending = this.lookup(kind, clean.term);
      this.memo.set(key, pending);
    }
    return pending;
  }

  private async lookup(kind: Kind, term: string): Promise<EventCode | null> {
    let best: CodeMatch | undefined;
    try {
      const matches =
        kind === 'diagnoses'
          ? await this.coders.diagnosis.search(term, 1)
          : kind === 'procedures'
            ? await this.coders.procedure.search(term, 1)
            : await this.coders.medication.normalize(term);
      best = matches[0];
    } catch {
      this.stats.failed++;
      return null;
    }
    if (!best) {
      this.stats.uncoded++;
      return null;
    }
    this.stats.coded++;
    const code: EventCode = { ...best };
    // Enrichment is best-effort: a definition or label outage keeps the code.
    const definition = await this.coders.consumerHealth.define(best).catch(() => null);
    if (definition) code.definition = definition;
    if (best.system === 'RXNORM') {
      const label = await this.coders.drugInfo.getLabel(best.code).catch(() => null);
      if (label) code.drugLabel = label;
    }
    return code;
  }
}
