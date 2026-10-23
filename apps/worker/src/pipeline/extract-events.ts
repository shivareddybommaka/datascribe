/**
 * Stage 4 — extract clinical events (REQUIREMENTS.md §7). Rules + regex only; an LLM extractor can be
 * added behind config later. Pure: one page in, zero or one event out, always citing its page.
 * The output holds PHI (it is page text): callers encrypt `description` and never log it.
 */
import type { RecordType } from './classify';

export interface PageInput {
  documentId: string;
  pageNumber: number;
  text: string | null | undefined;
  recordType: RecordType;
}

export interface ExtractedTerms {
  diagnoses: string[];
  procedures: string[];
  medications: string[];
}

export interface ExtractedEvent {
  documentId: string;
  pageNumber: number;
  /** ISO date (YYYY-MM-DD) of service, or null when the page has none */
  eventDate: string | null;
  provider: string | null;
  facility: string | null;
  eventType: RecordType;
  description: string;
  vitals: string[];
  /** short clinical terms for stage 5 (coding); de-identified again before any external call */
  terms: ExtractedTerms;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DATE_SOURCE =
  String.raw`(\d{1,2})[/-](\d{1,2})[/-](\d{4})` + // 03/14/2025 (US order)
  String.raw`|(\d{4})-(\d{2})-(\d{2})` + // 2025-03-14
  String.raw`|([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})`; // March 14, 2025

const SERVICE_LABEL =
  /\b(?:date of service|dos|service date|visit date|date of visit|admission date|admit date|date of (?:exam|procedure|surgery)|collected|exam date|fill date|date)\s*[:#-]?\s*/i;
const BIRTH_LABEL = /\b(?:dob|d\.o\.b\.|date of birth|birth ?date)\b/i;

function toIso(m: RegExpExecArray): string | null {
  let y: number;
  let mo: number;
  let d: number;
  if (m[3]) [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (m[4]) [y, mo, d] = [Number(m[4]), Number(m[5]), Number(m[6])];
  else {
    const idx = MONTHS.indexOf((m[7] ?? '').slice(0, 3).toLowerCase());
    if (idx < 0) return null;
    [y, mo, d] = [Number(m[9]), idx + 1, Number(m[8])];
  }
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null; // e.g. 02/31
  return date.toISOString().slice(0, 10);
}

/** Labelled service date first; otherwise the first date on a line that isn't a birth date. */
export function findServiceDate(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (BIRTH_LABEL.test(line)) continue;
    const label = SERVICE_LABEL.exec(line);
    if (!label) continue;
    const m = new RegExp(DATE_SOURCE).exec(line.slice(label.index + label[0].length));
    const iso = m && toIso(m);
    if (iso) return iso;
  }
  for (const line of lines) {
    if (BIRTH_LABEL.test(line)) continue;
    const re = new RegExp(DATE_SOURCE, 'g');
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const iso = toIso(m);
      if (iso) return iso;
    }
  }
  return null;
}

// Label is case-insensitive, the name itself must be capitalised (so it's a separate, anchored match).
const PROVIDER_LABEL =
  /\b(?:provider|physician|attending|seen by|signed by|surgeon|radiologist|therapist|prescriber|ordering)[ \t]*:?[ \t]+/gi;
const PROVIDER_NAME =
  /^(?:Dr\.?[ \t]+)?[A-Z][A-Za-z.'-]+(?:[ \t]+[A-Z][A-Za-z.'-]+){0,3}(?:,[ \t]*(?:MD|DO|PA-C|NP|DPT|PT|DC|RN|PharmD))?/;

function findProvider(text: string): string | null {
  for (const label of text.matchAll(PROVIDER_LABEL)) {
    const name = PROVIDER_NAME.exec(text.slice(label.index + label[0].length))?.[0];
    if (name) return name;
  }
  return null;
}
const FACILITY_RE = /^\s*(?:facility|hospital|clinic|location|pharmacy name)\s*:\s*(.+)$/im;

function clip(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Items after a heading like "Diagnoses:" — same line, then following list lines until a blank. */
function listAfter(text: string, heading: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = heading.exec(lines[i]!);
    if (!m) continue;
    const rest = lines[i]!.slice(m.index + m[0].length);
    const chunk = [rest];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!/^\s*(?:\d+[.)]|[-•*])\s+/.test(next)) break;
      chunk.push(next);
    }
    for (const part of chunk.join(';').split(/[;\n]|,(?![^(]*\))/)) {
      const item = part
        .replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '')
        .replace(/\s*\([A-Z]\d{2}(?:\.\w+)?\)\s*$/, '') // drop a printed ICD code; stage 5 re-codes
        .trim();
      if (item.length >= 3 && item.length <= 80 && /[a-z]/i.test(item)) out.push(item);
    }
  }
  return [...new Map(out.map((s) => [s.toLowerCase(), s])).values()];
}

const DIAGNOSIS_HEADING =
  /\b(?:diagnos[ie]s|dx|assessment|impression|(?:pre|post)-?operative diagnosis)\s*:\s*/i;
const PROCEDURE_HEADING = /\b(?:procedures?(?: performed)?|operation)\s*:\s*/i;
const MEDICATION_HEADING = /\b(?:medications?|meds|rx|prescribed|drug|dispensed)\s*:\s*/i;

const VITAL_RES = [
  /\bBP\s*:?\s*\d{2,3}\/\d{2,3}\b/i,
  /\b(?:HR|pulse)\s*:?\s*\d{2,3}\b/i,
  /\b(?:temp|temperature)\s*:?\s*\d{2,3}(?:\.\d)?\s*°?\s*[FC]?\b/i,
  /\b(?:RR|resp(?:irations)?)\s*:?\s*\d{1,2}\b/i,
  /\b(?:SpO2|O2 sat)\s*:?\s*\d{2,3}\s*%/i,
  /\bpain\s*(?:score|level)?\s*:?\s*\d{1,2}\s*\/\s*10\b/i,
];

const TYPE_LABEL: Record<RecordType, string> = {
  office_visit: 'Office visit',
  er: 'Emergency department visit',
  imaging: 'Imaging study',
  lab: 'Laboratory results',
  operative: 'Operative procedure',
  therapy: 'Therapy session',
  pharmacy: 'Pharmacy record',
  billing: 'Billing record',
  other: 'Medical record',
};

/**
 * One event per page that carries clinical content. Billing pages and pages with neither a date
 * nor any clinical term produce nothing (they still appear in the index).
 */
export function extractEvent(page: PageInput): ExtractedEvent | null {
  const text = page.text ?? '';
  if (!text.trim() || page.recordType === 'billing') return null;

  const terms: ExtractedTerms = {
    diagnoses: listAfter(text, DIAGNOSIS_HEADING),
    procedures: listAfter(text, PROCEDURE_HEADING),
    medications: listAfter(text, MEDICATION_HEADING),
  };
  const vitals = VITAL_RES.map((re) => re.exec(text)?.[0]).filter((v): v is string => !!v);
  const eventDate = findServiceDate(text);
  const hasTerms = terms.diagnoses.length + terms.procedures.length + terms.medications.length > 0;
  if (!eventDate && !hasTerms) return null;

  const provider = findProvider(text);
  const facility = FACILITY_RE.exec(text)?.[1];
  const parts = [TYPE_LABEL[page.recordType]];
  if (terms.diagnoses.length) parts.push(`Diagnoses: ${terms.diagnoses.join('; ')}`);
  if (terms.procedures.length) parts.push(`Procedures: ${terms.procedures.join('; ')}`);
  if (terms.medications.length) parts.push(`Medications: ${terms.medications.join('; ')}`);
  if (vitals.length) parts.push(`Vitals: ${vitals.join(', ')}`);

  return {
    documentId: page.documentId,
    pageNumber: page.pageNumber,
    eventDate,
    provider: provider ? clip(provider, 80) : null,
    facility: facility ? clip(facility, 120) : null,
    eventType: page.recordType,
    description: `${parts.join('. ')}.`,
    vitals,
    terms,
  };
}
