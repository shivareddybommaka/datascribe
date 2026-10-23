import { ATTRIBUTION } from '../attribution';
import type { ProviderClient } from '../resilience/provider-client';
import type { CodeMatch, ConsumerHealthInfo } from '../types';

export const MEDLINEPLUS_CONNECT_URL = 'https://connect.medlineplus.gov/service';

/** HL7 code system OIDs accepted by MedlinePlus Connect. HCPCS is not supported. */
export const CODE_SYSTEM_OID: Partial<Record<CodeMatch['system'], string>> = {
  ICD10CM: '2.16.840.1.113883.6.90',
  SNOMED: '2.16.840.1.113883.6.96',
  RXNORM: '2.16.840.1.113883.6.88',
};

/** Codes are sent instead of terms; still validate the shape so nothing else can slip through. */
export const CODE_PATTERN: Record<CodeMatch['system'], RegExp> = {
  ICD10CM: /^[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?$/,
  RXNORM: /^\d{1,8}$/,
  SNOMED: /^\d{6,18}$/,
  HCPCS: /^[A-V]\d{4}$/,
};

export const isValidCode = (c: Pick<CodeMatch, 'system' | 'code'>) =>
  CODE_PATTERN[c.system]?.test(c.code) ?? false;

export const MAX_SUMMARY_CHARS = 1200;

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(?:br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

interface Entry {
  title?: { _value?: string };
  link?: { href?: string }[];
  summary?: { _value?: string };
}

export function parseConnect(
  body: unknown,
): { title: string; summary: string; url: string } | null {
  const entry = (body as { feed?: { entry?: Entry[] } } | null)?.feed?.entry?.[0];
  const title = entry?.title?._value?.trim();
  const url = entry?.link?.[0]?.href;
  if (!entry || !title || !url) return null;
  let summary = htmlToText(entry.summary?._value ?? '').replace(/\n+/g, ' ');
  if (summary.length > MAX_SUMMARY_CHARS) {
    const cut = summary.slice(0, MAX_SUMMARY_CHARS);
    const stop = cut.lastIndexOf('. ');
    summary = `${stop > MAX_SUMMARY_CHARS / 2 ? cut.slice(0, stop + 1) : cut} …`;
  }
  return { title, summary, url };
}

/** Plain-language definitions via MedlinePlus Connect (code-based, so no free text is sent). */
export class MedlinePlusConnect implements ConsumerHealthInfo {
  readonly attribution = ATTRIBUTION.medlineplus;
  constructor(private readonly client: ProviderClient) {}

  async define(code: CodeMatch) {
    const oid = CODE_SYSTEM_OID[code.system];
    if (!oid || !isValidCode(code)) return null;
    return this.client.run(
      ['connect', code.system, code.code.toUpperCase()],
      async (http) => {
        const qs = new URLSearchParams({
          'mainSearchCriteria.v.cs': oid,
          'mainSearchCriteria.v.c': code.code.toUpperCase(),
          knowledgeResponseType: 'application/json',
          'informationRecipient.languageCode.c': 'en',
        });
        return parseConnect(await http.getJson(`${MEDLINEPLUS_CONNECT_URL}?${qs}`));
      },
      null,
    );
  }
}
