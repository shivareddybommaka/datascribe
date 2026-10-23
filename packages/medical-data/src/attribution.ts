/**
 * Source attribution shown in the staff workspace and report footers (§8.4). Wording follows each
 * provider's terms as checked on 2026-10-24 (docs/DECISIONS.md D-050..D-053).
 */
export interface Attribution {
  /** Short label for CodeMatch.source and UI chips, e.g. "Source: NLM RxNorm". */
  source: string;
  /** Statement the provider asks applications to show. */
  statement: string;
  url: string;
}

export const NLM_DISCLAIMER =
  'This product uses publicly available data from the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.';

export const ATTRIBUTION = {
  icd10cm: {
    source: 'Source: NLM Clinical Table Search Service (ICD-10-CM)',
    statement: NLM_DISCLAIMER,
    url: 'https://clinicaltables.nlm.nih.gov/',
  },
  hcpcs: {
    source: 'Source: NLM Clinical Table Search Service (HCPCS Level II)',
    statement: NLM_DISCLAIMER,
    url: 'https://clinicaltables.nlm.nih.gov/',
  },
  rxnorm: {
    source: 'Source: NLM RxNorm',
    statement: NLM_DISCLAIMER,
    url: 'https://lhncbc.nlm.nih.gov/RxNav/',
  },
  openfda: {
    source: 'Source: openFDA Drug Label',
    statement: 'Data provided by the U.S. Food and Drug Administration (https://open.fda.gov)',
    url: 'https://open.fda.gov/',
  },
  medlineplus: {
    source: 'Source: MedlinePlus.gov',
    statement:
      'Information from MedlinePlus.gov, U.S. National Library of Medicine. MedlinePlus does not endorse this product.',
    url: 'https://medlineplus.gov/',
  },
  mock: {
    source: 'Source: mock fixtures (synthetic)',
    statement: 'Synthetic reference data for development and tests. Not for clinical use.',
    url: 'https://datascribe.example/mock',
  },
} as const satisfies Record<string, Attribution>;
