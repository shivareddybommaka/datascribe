import { MockOcrProvider } from '@datascribe/medical-data';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractPdfPages } from '../pipeline/extract-text';
import { renderReportPdf, wrapText, type ReportInput } from './report-pdf';

// synthetic data only
const input = (entries = 3): ReportInput => ({
  companyName: 'Datascribe',
  firmName: 'Acme Injury Law (synthetic)',
  caseNumber: 'DS-2026-000042',
  matterName: 'Doe v. Example Transit',
  reference: 'ACME-17',
  patientName: 'Jane Testpatient',
  incidentDate: '2025-03-14',
  caseType: 'personal_injury',
  approvedAt: new Date('2026-10-25T03:00:00Z'),
  sections: [
    {
      version: 2,
      content: {
        kind: 'summary',
        provider: 'template',
        sections: [
          {
            heading: 'Overview',
            paragraphs: ['The synthetic patient was seen after a low-speed collision.'],
          },
        ],
      },
    },
    {
      version: 3,
      content: {
        kind: 'chronology',
        entries: Array.from({ length: entries }, (_, i) => ({
          date: `2025-03-${String((i % 28) + 1).padStart(2, '0')}`,
          provider: 'Dr Alex Sample',
          facility: 'Example General',
          eventType: 'office_visit',
          description: `Follow-up visit ${i + 1}; neck pain improving with physiotherapy and rest.`,
          codes: [{ system: 'ICD-10-CM', code: 'S13.4XXA', display: 'Sprain of cervical spine' }],
          citation: { documentId: 'doc1', fileName: 'records-a.pdf', pageNumber: i + 1 },
        })),
      },
    },
    {
      version: 1,
      content: {
        kind: 'index',
        totals: { documents: 1, pages: 6 },
        rows: [
          {
            documentId: 'doc1',
            fileName: 'records-a.pdf',
            pageFrom: 1,
            pageTo: 6,
            recordType: 'office_visit',
            providers: ['Dr Alex Sample'],
            dateFrom: '2025-03-01',
            dateTo: '2025-03-06',
          },
        ],
      },
    },
  ],
});

const pageTexts = async (bytes: Uint8Array) =>
  (await extractPdfPages(bytes, { ocr: new MockOcrProvider() })).pages.map((p) => p.text);

describe('report PDF', () => {
  it('renders a cover and one page per section, with citations and footers', async () => {
    const { bytes, pages } = await renderReportPdf(input());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe('Medical records report DS-2026-000042');
    expect(pages).toBe(4);
    expect(doc.getPageCount()).toBe(4);
    const text = await pageTexts(bytes);
    expect(text[0]).toContain('Jane Testpatient');
    expect(text[0]).toContain('2. Medical chronology (version 3)');
    expect(text[1]).toContain('1. Medical summary');
    expect(text[2]).toContain('records-a.pdf, p. 3');
    expect(text[2]).toContain('S13.4XXA');
    expect(text[3]).toContain('Office visit');
    expect(text[3]).toContain('page 4 of 4');
  });

  it('paginates a long chronology and repeats the table header', async () => {
    const { bytes, pages } = await renderReportPdf(input(120));
    expect(pages).toBeGreaterThan(5);
    const text = await pageTexts(bytes);
    const chronoPages = text.filter((t) => t.includes('Follow-up visit'));
    expect(chronoPages.length).toBeGreaterThan(2);
    for (const t of chronoPages) expect(t).toContain('Provider / facility');
    expect(text.join(' ')).toContain('records-a.pdf, p. 120');
  });

  it('is reproducible for the same input', async () => {
    const a = await renderReportPdf(input());
    const b = await renderReportPdf(input());
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('copes with empty sections and characters outside WinAnsi', async () => {
    const i = input(0);
    i.patientName = 'Zoë Ŧestpatient';
    const { bytes, pages } = await renderReportPdf(i);
    expect(pages).toBe(4);
    expect((await pageTexts(bytes))[2]).toContain('No dated medical events were found.');
  });

  it('wraps long words inside the width', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrapText(`short ${'x'.repeat(200)} end`, font, 10, 100);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(100);
    expect(wrapText('', font, 10, 100)).toEqual(['']);
  });
});
