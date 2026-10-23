/**
 * Stage 6 — build deliverables (REQUIREMENTS.md §7). Pure builders for the index and chronology, and
 * the summary input for the SummaryProvider. The results are PHI: callers store them encrypted.
 */
import type { SummaryInput } from '@datascribe/medical-data';
import type { EventCode } from './code-events';
import type { RecordType } from './classify';

export interface DocumentInfo {
  id: string;
  fileName: string;
  pageCount: number;
}
export interface PageInfo {
  documentId: string;
  pageNumber: number;
  recordType: RecordType;
}
export interface EventInfo {
  id?: string;
  documentId: string;
  pageNumber: number;
  eventDate: string | null;
  provider: string | null;
  facility: string | null;
  eventType: string | null;
  description: string;
  codes: EventCode[];
}

export interface Citation {
  documentId: string;
  fileName: string;
  pageNumber: number;
}

export interface IndexRow {
  documentId: string;
  fileName: string;
  pageFrom: number;
  pageTo: number;
  recordType: RecordType;
  providers: string[];
  dateFrom: string | null;
  dateTo: string | null;
}
export interface IndexContent {
  kind: 'index';
  rows: IndexRow[];
  totals: { documents: number; pages: number };
}

export interface ChronologyEntry {
  eventId?: string;
  date: string | null;
  provider: string | null;
  facility: string | null;
  eventType: string | null;
  description: string;
  codes: { system: string; code: string; display: string }[];
  citation: Citation;
}
export interface ChronologyContent {
  kind: 'chronology';
  entries: ChronologyEntry[];
}

const byCitation = (a: EventInfo, b: EventInfo, order: Map<string, number>) =>
  (order.get(a.documentId) ?? 0) - (order.get(b.documentId) ?? 0) || a.pageNumber - b.pageNumber;

/**
 * Index: per document, runs of consecutive pages with the same record type, with the providers and
 * date range of the events on those pages. Documents keep the given order.
 */
export function buildIndex(
  documents: DocumentInfo[],
  pages: PageInfo[],
  events: EventInfo[],
): IndexContent {
  const rows: IndexRow[] = [];
  for (const doc of documents) {
    const docPages = pages
      .filter((p) => p.documentId === doc.id)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    let row: IndexRow | null = null;
    for (const p of docPages) {
      if (row && row.recordType === p.recordType && p.pageNumber === row.pageTo + 1) {
        row.pageTo = p.pageNumber;
        continue;
      }
      row = {
        documentId: doc.id,
        fileName: doc.fileName,
        pageFrom: p.pageNumber,
        pageTo: p.pageNumber,
        recordType: p.recordType,
        providers: [],
        dateFrom: null,
        dateTo: null,
      };
      rows.push(row);
    }
  }
  for (const e of events) {
    const row = rows.find(
      (r) =>
        r.documentId === e.documentId && r.pageFrom <= e.pageNumber && e.pageNumber <= r.pageTo,
    );
    if (!row) continue;
    if (e.provider && !row.providers.includes(e.provider)) row.providers.push(e.provider);
    if (e.eventDate) {
      if (!row.dateFrom || e.eventDate < row.dateFrom) row.dateFrom = e.eventDate;
      if (!row.dateTo || e.eventDate > row.dateTo) row.dateTo = e.eventDate;
    }
  }
  return {
    kind: 'index',
    rows,
    totals: { documents: documents.length, pages: pages.length },
  };
}

/** Chronology: events by date (undated last), then document order and page. Every entry cites. */
export function buildChronology(documents: DocumentInfo[], events: EventInfo[]): ChronologyContent {
  const order = new Map(documents.map((d, i) => [d.id, i]));
  const names = new Map(documents.map((d) => [d.id, d.fileName]));
  const sorted = [...events].sort(
    (a, b) =>
      (a.eventDate ?? '9999-99-99').localeCompare(b.eventDate ?? '9999-99-99') ||
      byCitation(a, b, order),
  );
  return {
    kind: 'chronology',
    entries: sorted.map((e) => ({
      ...(e.id ? { eventId: e.id } : {}),
      date: e.eventDate,
      provider: e.provider,
      facility: e.facility,
      eventType: e.eventType,
      description: e.description,
      codes: e.codes.map(({ system, code, display }) => ({ system, code, display })),
      citation: {
        documentId: e.documentId,
        fileName: names.get(e.documentId) ?? '',
        pageNumber: e.pageNumber,
      },
    })),
  };
}

export function summaryInput(caseId: string, events: EventInfo[]): SummaryInput {
  return {
    caseId,
    events: events.map((e) => ({
      date: e.eventDate,
      description: e.description,
      codes: e.codes.map(({ system, code, display, score, source }) => ({
        system,
        code,
        display,
        score,
        source,
      })),
      citation: { documentId: e.documentId, pageNumber: e.pageNumber },
    })),
  };
}
