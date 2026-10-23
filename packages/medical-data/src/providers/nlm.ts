import { ATTRIBUTION } from '../attribution';
import { TermRefusedError, requireSafeTerm } from '../deidentify';
import type { ProviderClient } from '../resilience/provider-client';
import type { CodeMatch, DiagnosisCoder, MedicationNormalizer, ProcedureCoder } from '../types';

export const CTSS_BASE = 'https://clinicaltables.nlm.nih.gov/api';
export const RXNAV_BASE = 'https://rxnav.nlm.nih.gov/REST';

const clampLimit = (limit: number | undefined, max: number) =>
  Math.max(1, Math.min(max, Math.trunc(limit ?? 10)));

/** Run `fn` on the de-identified term; refused terms come back "uncoded" without any call. */
export async function withSafeTerm<T>(raw: string, fallback: T, fn: (term: string) => Promise<T>) {
  let term: string;
  try {
    term = requireSafeTerm(raw);
  } catch (e) {
    if (e instanceof TermRefusedError) return fallback;
    throw e;
  }
  return fn(term);
}

/**
 * Clinical Table Search Service output: [total, codes, extra, display[][], codeSystems?]
 * (https://clinicaltables.nlm.nih.gov/apidoc/icd10cm/v3/doc.html#output).
 */
export function parseCtss(body: unknown, system: CodeMatch['system'], source: string): CodeMatch[] {
  if (!Array.isArray(body) || !Array.isArray(body[1]) || !Array.isArray(body[3])) {
    throw new Error('Unexpected Clinical Tables response');
  }
  const codes = body[1] as unknown[];
  const display = body[3] as unknown[];
  return codes.map((code, i) => {
    const row = Array.isArray(display[i]) ? (display[i] as unknown[]) : [];
    return {
      system,
      code: String(code),
      display: String(row[1] ?? row[0] ?? code),
      // CTSS returns results in relevance order without scores; expose the rank as a score.
      score: Number((1 - i / Math.max(codes.length, 1)).toFixed(3)),
      source,
    };
  });
}

/** ICD-10-CM via NLM Clinical Table Search Service. */
export class NlmIcd10Coder implements DiagnosisCoder {
  readonly attribution = ATTRIBUTION.icd10cm;
  constructor(private readonly client: ProviderClient) {}

  search(raw: string, limit?: number): Promise<CodeMatch[]> {
    const max = clampLimit(limit, 50);
    return withSafeTerm(raw, [], (term) =>
      this.client.run(
        ['icd10cm', term, max],
        async (http) => {
          const qs = new URLSearchParams({
            sf: 'code,name',
            df: 'code,name',
            terms: term,
            maxList: String(max),
          });
          return parseCtss(
            await http.getJson(`${CTSS_BASE}/icd10cm/v3/search?${qs}`),
            'ICD10CM',
            this.attribution.source,
          );
        },
        [],
      ),
    );
  }
}

/**
 * Procedures via the CTSS HCPCS Level II table. CPT is AMA-licensed and not offered by CTSS,
 * and there is no ICD-10-PCS table, so HCPCS is the free procedure code set available (D-050).
 */
export class NlmHcpcsCoder implements ProcedureCoder {
  readonly attribution = ATTRIBUTION.hcpcs;
  constructor(private readonly client: ProviderClient) {}

  search(raw: string, limit?: number): Promise<CodeMatch[]> {
    const max = clampLimit(limit, 50);
    return withSafeTerm(raw, [], (term) =>
      this.client.run(
        ['hcpcs', term, max],
        async (http) => {
          const qs = new URLSearchParams({
            sf: 'code,short_desc,long_desc',
            df: 'code,display',
            terms: term,
            maxList: String(max),
          });
          return parseCtss(
            await http.getJson(`${CTSS_BASE}/hcpcs/v3/search?${qs}`),
            'HCPCS',
            this.attribution.source,
          );
        },
        [],
      ),
    );
  }
}

interface RxCandidate {
  rxcui?: string;
  score?: string;
  rank?: string;
  name?: string;
  source?: string;
}

/**
 * RxNorm via RxNav `approximateTerm` (handles misspellings, strengths and extra words), limited to
 * active concepts. Candidates without a releasable name (restricted source vocabularies) are named
 * from an RXNORM candidate for the same RxCUI or dropped.
 */
export class RxNormNormalizer implements MedicationNormalizer {
  readonly attribution = ATTRIBUTION.rxnorm;
  constructor(
    private readonly client: ProviderClient,
    private readonly maxResults = 5,
  ) {}

  normalize(raw: string): Promise<CodeMatch[]> {
    return withSafeTerm(raw, [], (term) =>
      this.client.run(
        ['rxnorm', term, this.maxResults],
        async (http) => {
          const qs = new URLSearchParams({ term, maxEntries: '20', option: '1' });
          const body = (await http.getJson(`${RXNAV_BASE}/approximateTerm.json?${qs}`)) as {
            approximateGroup?: { candidate?: RxCandidate[] };
          } | null;
          return parseRxCandidates(
            body?.approximateGroup?.candidate ?? [],
            this.attribution.source,
          ).slice(0, this.maxResults);
        },
        [],
      ),
    );
  }
}

export function parseRxCandidates(candidates: RxCandidate[], source: string): CodeMatch[] {
  const best = new Map<
    string,
    { name?: string; score: number; rank: number; rxnormName?: string }
  >();
  for (const c of candidates) {
    if (!c.rxcui) continue;
    const score = Number(c.score ?? 0);
    const rank = Number(c.rank ?? 99);
    const prev = best.get(c.rxcui);
    const entry = prev ?? { score, rank };
    if (!prev || rank < prev.rank || (rank === prev.rank && score > prev.score)) {
      entry.score = score;
      entry.rank = rank;
    }
    if (c.name && !entry.name) entry.name = c.name;
    if (c.name && c.source === 'RXNORM') entry.rxnormName = c.name;
    best.set(c.rxcui, entry);
  }
  return [...best.entries()]
    .filter(([, v]) => v.rxnormName ?? v.name)
    .sort((a, b) => a[1].rank - b[1].rank || b[1].score - a[1].score)
    .map(([rxcui, v]) => ({
      system: 'RXNORM' as const,
      code: rxcui,
      display: (v.rxnormName ?? v.name)!,
      score: v.score,
      source,
    }));
}
