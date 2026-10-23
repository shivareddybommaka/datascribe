import { createHash } from 'node:crypto';
import { ATTRIBUTION } from '../attribution';
import { deidentifyTerm } from '../deidentify';
import type {
  CodeMatch,
  ConsumerHealthInfo,
  DiagnosisCoder,
  DrugInfoProvider,
  MedicationNormalizer,
  OcrProvider,
  ProcedureCoder,
  SummaryInput,
  SummaryOutput,
  SummaryProvider,
} from '../types';
import { isRxcui } from './openfda';

/**
 * Deterministic mock providers (§8.3). No network; the same input always gives the same output.
 * The codes are real-looking examples so pipeline output reads sensibly in demos and tests.
 */
const SOURCE = ATTRIBUTION.mock.source;

const DIAGNOSES: [code: string, display: string, keywords: string[]][] = [
  ['M54.16', 'Radiculopathy, lumbar region', ['lumbar radiculopathy', 'sciatica', 'radiculopathy']],
  ['M54.12', 'Radiculopathy, cervical region', ['cervical radiculopathy']],
  ['M54.50', 'Low back pain, unspecified', ['low back pain', 'lumbago', 'back pain']],
  ['M54.2', 'Cervicalgia', ['neck pain', 'cervicalgia']],
  [
    'S13.4XXA',
    'Sprain of ligaments of cervical spine, initial encounter',
    ['whiplash', 'neck sprain', 'cervical sprain'],
  ],
  [
    'S33.5XXA',
    'Sprain of ligaments of lumbar spine, initial encounter',
    ['lumbar sprain', 'back sprain'],
  ],
  ['S06.0X0A', 'Concussion without loss of consciousness, initial encounter', ['concussion']],
  [
    'M51.26',
    'Other intervertebral disc displacement, lumbar region',
    ['disc herniation', 'herniated disc', 'disc displacement'],
  ],
  [
    'S82.201A',
    'Unspecified fracture of shaft of right tibia, initial encounter for closed fracture',
    ['tibia fracture', 'tibial fracture'],
  ],
  [
    'G44.309',
    'Post-traumatic headache, unspecified, not intractable',
    ['post-traumatic headache', 'headache'],
  ],
  ['F43.10', 'Post-traumatic stress disorder, unspecified', ['ptsd', 'post-traumatic stress']],
  ['E11.9', 'Type 2 diabetes mellitus without complications', ['type 2 diabetes', 'diabetes']],
  ['I10', 'Essential (primary) hypertension', ['hypertension', 'high blood pressure']],
];

const PROCEDURES: [code: string, display: string, keywords: string[]][] = [
  [
    'L0650',
    'Lumbar-sacral orthosis, sagittal-coronal control, prefabricated',
    ['lumbar orthosis', 'back brace', 'lumbar brace'],
  ],
  [
    'L0120',
    'Cervical, flexible, non-adjustable, prefabricated',
    ['cervical collar', 'neck brace', 'soft collar'],
  ],
  ['E0114', 'Crutches, underarm, other than wood, adjustable or fixed, pair', ['crutches']],
  [
    'G0283',
    'Electrical stimulation (unattended), to one or more areas',
    ['electrical stimulation', 'tens', 'e-stim'],
  ],
  [
    'J1100',
    'Injection, dexamethasone sodium phosphate, 1 mg',
    ['dexamethasone injection', 'steroid injection'],
  ],
  ['E0730', 'Transcutaneous electrical nerve stimulation (TENS) device', ['tens unit']],
];

const MEDICATIONS: [rxcui: string, display: string, keywords: string[]][] = [
  ['25480', 'gabapentin', ['gabapentin', 'neurontin']],
  ['5640', 'ibuprofen', ['ibuprofen', 'advil', 'motrin']],
  ['161', 'acetaminophen', ['acetaminophen', 'paracetamol', 'tylenol']],
  ['7804', 'oxycodone', ['oxycodone', 'oxycontin']],
  ['21949', 'cyclobenzaprine', ['cyclobenzaprine', 'flexeril']],
  ['7258', 'naproxen', ['naproxen', 'aleve']],
  ['10689', 'tramadol', ['tramadol', 'ultram']],
  ['41493', 'meloxicam', ['meloxicam', 'mobic']],
];

function lookup(
  table: [string, string, string[]][],
  system: CodeMatch['system'],
  raw: string,
  limit = 10,
): CodeMatch[] {
  const r = deidentifyTerm(raw);
  if (!r.ok) return [];
  const term = r.term.toLowerCase();
  const scored = table
    .map(([code, display, keywords]) => {
      const hit = keywords.find((k) => term.includes(k) || k.includes(term));
      if (!hit) return null;
      return {
        code,
        display,
        score:
          term === hit
            ? 1
            : Number(
                (Math.min(term.length, hit.length) / Math.max(term.length, hit.length)).toFixed(3),
              ),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return scored.slice(0, Math.max(1, limit)).map((m) => ({ system, ...m, source: SOURCE }));
}

export class MockDiagnosisCoder implements DiagnosisCoder {
  readonly attribution = ATTRIBUTION.mock;
  async search(term: string, limit?: number) {
    return lookup(DIAGNOSES, 'ICD10CM', term, limit);
  }
}

export class MockProcedureCoder implements ProcedureCoder {
  readonly attribution = ATTRIBUTION.mock;
  async search(term: string, limit?: number) {
    return lookup(PROCEDURES, 'HCPCS', term, limit);
  }
}

export class MockMedicationNormalizer implements MedicationNormalizer {
  readonly attribution = ATTRIBUTION.mock;
  async normalize(name: string) {
    return lookup(MEDICATIONS, 'RXNORM', name, 5);
  }
}

export class MockDrugInfo implements DrugInfoProvider {
  readonly attribution = ATTRIBUTION.mock;
  async getLabel(rxcuiOrName: string) {
    const med = isRxcui(rxcuiOrName)
      ? MEDICATIONS.find(([rxcui]) => rxcui === rxcuiOrName.trim())
      : MEDICATIONS.find(
          ([rxcui]) => rxcui === lookup(MEDICATIONS, 'RXNORM', rxcuiOrName, 1)[0]?.code,
        );
    if (!med) return null;
    return {
      indications: `${med[1]} is indicated for conditions described in its FDA label (mock text).`,
      warnings: `See the full prescribing information for ${med[1]} warnings (mock text).`,
      source: SOURCE,
    };
  }
}

export class MockConsumerHealthInfo implements ConsumerHealthInfo {
  readonly attribution = ATTRIBUTION.mock;
  async define(code: CodeMatch) {
    const all = [...DIAGNOSES, ...PROCEDURES, ...MEDICATIONS];
    const hit = all.find(([c]) => c.toUpperCase() === code.code.toUpperCase());
    if (!hit) return null;
    return {
      title: hit[1],
      summary: `${hit[1]}: plain-language explanation for the summary (mock text).`,
      url: `${ATTRIBUTION.mock.url}/${encodeURIComponent(hit[0])}`,
    };
  }
}

/**
 * Mock OCR. A buffer of printable UTF-8 is returned as its own text (so pipeline tests can feed
 * "scanned" pages as text); anything else gets a fixed placeholder keyed by its hash.
 */
export class MockOcrProvider implements OcrProvider {
  async recognize(image: Buffer) {
    const text = image.toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (text.length > 0 && !/[\u0000-\u0008\u000e-\u001f�]/.test(text)) {
      return { text, confidence: 0.99 };
    }
    const hash = createHash('sha256').update(image).digest('hex').slice(0, 12);
    return { text: `[mock OCR page ${hash}]`, confidence: 0.5 };
  }
}

/** Mock summary: deterministic sections built from the events, each sentence cites its page. */
export class MockSummaryProvider implements SummaryProvider {
  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const events = [...input.events].sort(
      (a, b) =>
        (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
        a.citation.documentId.localeCompare(b.citation.documentId) ||
        a.citation.pageNumber - b.citation.pageNumber,
    );
    const cite = (e: SummaryInput['events'][number]) =>
      `[doc ${e.citation.documentId} p.${e.citation.pageNumber}]`;
    const coded = events.filter((e) => e.codes.some((c) => c.system === 'ICD10CM'));
    const meds = events.filter((e) => e.codes.some((c) => c.system === 'RXNORM'));
    const dated = events.filter((e) => e.date);
    const sections: SummaryOutput['sections'] = [
      {
        heading: 'Overview',
        paragraphs: [
          events.length
            ? `The records contain ${events.length} clinical event(s)` +
              (dated.length ? ` dated ${dated[0]!.date} to ${dated[dated.length - 1]!.date}.` : '.')
            : 'No clinical events were extracted.',
        ],
      },
      {
        heading: 'Diagnoses',
        paragraphs: coded.length
          ? coded.map((e) => {
              const c = e.codes
                .filter((x) => x.system === 'ICD10CM')
                .map((x) => `${x.code} ${x.display}`);
              return `${e.date ?? 'Undated'}: ${c.join('; ')} ${cite(e)}`;
            })
          : ['No coded diagnoses.'],
      },
      {
        heading: 'Treatment course',
        paragraphs: events.length
          ? events.map((e) => `${e.date ?? 'Undated'}: ${e.description} ${cite(e)}`)
          : ['None recorded.'],
      },
      {
        heading: 'Medications',
        paragraphs: meds.length
          ? meds.map(
              (e) =>
                `${e.codes
                  .filter((x) => x.system === 'RXNORM')
                  .map((x) => x.display)
                  .join(', ')} ${cite(e)}`,
            )
          : ['No coded medications.'],
      },
    ];
    return { sections, provider: 'mock' };
  }
}
