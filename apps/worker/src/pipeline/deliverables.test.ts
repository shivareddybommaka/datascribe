import { describe, expect, it } from 'vitest';
import { buildChronology, buildIndex, summaryInput, type EventInfo } from './deliverables';

const docs = [
  { id: 'a', fileName: 'er-records.pdf', pageCount: 3 },
  { id: 'b', fileName: 'ortho.pdf', pageCount: 2 },
];
const pages = [
  { documentId: 'a', pageNumber: 1, recordType: 'er' as const },
  { documentId: 'a', pageNumber: 2, recordType: 'er' as const },
  { documentId: 'a', pageNumber: 3, recordType: 'billing' as const },
  { documentId: 'b', pageNumber: 2, recordType: 'office_visit' as const },
  { documentId: 'b', pageNumber: 1, recordType: 'office_visit' as const },
];
const ev = (e: Partial<EventInfo> & Pick<EventInfo, 'documentId' | 'pageNumber'>): EventInfo => ({
  eventDate: null,
  provider: null,
  facility: null,
  eventType: null,
  description: 'x',
  codes: [],
  ...e,
});
const events = [
  ev({ documentId: 'b', pageNumber: 2, eventDate: '2025-04-01', provider: 'Dr. B' }),
  ev({ documentId: 'a', pageNumber: 1, eventDate: '2025-03-01', provider: 'Dr. A' }),
  ev({ documentId: 'b', pageNumber: 1, eventDate: '2025-03-20', provider: 'Dr. B' }),
  ev({ documentId: 'a', pageNumber: 2 }),
];

describe('buildIndex', () => {
  it('groups consecutive pages by record type with providers and date range', () => {
    const index = buildIndex(docs, pages, events);
    expect(index.totals).toEqual({ documents: 2, pages: 5 });
    expect(index.rows).toEqual([
      expect.objectContaining({
        documentId: 'a',
        pageFrom: 1,
        pageTo: 2,
        recordType: 'er',
        providers: ['Dr. A'],
        dateFrom: '2025-03-01',
        dateTo: '2025-03-01',
      }),
      expect.objectContaining({ documentId: 'a', pageFrom: 3, pageTo: 3, recordType: 'billing' }),
      expect.objectContaining({
        documentId: 'b',
        pageFrom: 1,
        pageTo: 2,
        providers: ['Dr. B'],
        dateFrom: '2025-03-20',
        dateTo: '2025-04-01',
      }),
    ]);
  });
});

describe('buildChronology', () => {
  it('sorts by date with undated last and cites every entry', () => {
    const chron = buildChronology(docs, events);
    expect(chron.entries.map((e) => e.date)).toEqual([
      '2025-03-01',
      '2025-03-20',
      '2025-04-01',
      null,
    ]);
    for (const e of chron.entries) {
      expect(e.citation.pageNumber).toBeGreaterThan(0);
      expect(e.citation.fileName).not.toBe('');
    }
  });
});

describe('summaryInput', () => {
  it('maps events with citations', () => {
    const input = summaryInput('case1', events.slice(0, 1));
    expect(input).toEqual({
      caseId: 'case1',
      events: [
        {
          date: '2025-04-01',
          description: 'x',
          codes: [],
          citation: { documentId: 'b', pageNumber: 2 },
        },
      ],
    });
  });
});
