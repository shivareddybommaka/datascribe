import { ATTRIBUTION } from '../attribution';
import type { ProviderClient } from '../resilience/provider-client';
import type { DrugInfoProvider } from '../types';
import { withSafeTerm } from './nlm';

export const OPENFDA_LABEL_URL = 'https://api.fda.gov/drug/label.json';

/** Label sections are long; the workspace shows a summary and links to the full label. */
export const MAX_SECTION_CHARS = 1500;

export type DrugLabel = { indications?: string; warnings?: string; source: string };

/** RxCUIs are digits only. Callers pass RxCUIs that came back from RxNorm, never record numbers. */
export const isRxcui = (s: string) => /^\d{1,8}$/.test(s.trim());

/** Strengths and dose forms stop the phrase match on generic/brand name, so drop them. */
export function drugNameForLabel(term: string): string {
  return term
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml|%|units?|iu)(?:\/\w+)?\b/g, ' ')
    .replace(
      /\b(?:oral|tablets?|tabs?|capsules?|caps?|solution|suspension|injection|injectable|cream|ointment|patch|er|xr|sr|cr|dr|extended[- ]release|delayed[- ]release|hcl)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9 -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string | undefined, max = MAX_SECTION_CHARS): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd()} …`;
}

interface LabelResult {
  indications_and_usage?: string[];
  warnings?: string[];
  warnings_and_cautions?: string[];
  boxed_warning?: string[];
}

export function parseLabel(body: unknown, source: string): DrugLabel | null {
  const result = (body as { results?: LabelResult[] } | null)?.results?.[0];
  if (!result) return null;
  const indications = truncate(result.indications_and_usage?.[0]);
  const warnings = truncate(
    result.boxed_warning?.[0] ?? result.warnings_and_cautions?.[0] ?? result.warnings?.[0],
  );
  if (!indications && !warnings) return null;
  return { ...(indications ? { indications } : {}), ...(warnings ? { warnings } : {}), source };
}

/** openFDA Drug Label API. A 404 from openFDA means "no matching label". */
export class OpenFdaDrugInfo implements DrugInfoProvider {
  readonly attribution = ATTRIBUTION.openfda;
  constructor(
    private readonly client: ProviderClient,
    private readonly apiKey?: string,
  ) {}

  private fetchLabel(kind: 'rxcui' | 'name', value: string) {
    return this.client.run<DrugLabel | null>(
      ['label', kind, value],
      async (http) => {
        const search =
          kind === 'rxcui'
            ? `openfda.rxcui:"${value}"`
            : `openfda.generic_name:"${value}" openfda.brand_name:"${value}"`;
        const qs = new URLSearchParams({
          ...(this.apiKey ? { api_key: this.apiKey } : {}),
          search,
          limit: '1',
        });
        const body = await http.getJson(`${OPENFDA_LABEL_URL}?${qs}`, { nullOn404: true });
        return parseLabel(body, this.attribution.source);
      },
      null,
    );
  }

  async getLabel(rxcuiOrName: string): Promise<DrugLabel | null> {
    if (isRxcui(rxcuiOrName)) return this.fetchLabel('rxcui', rxcuiOrName.trim());
    return withSafeTerm(rxcuiOrName, null, async (term) => {
      const name = drugNameForLabel(term);
      return name ? this.fetchLabel('name', name) : null;
    });
  }
}
