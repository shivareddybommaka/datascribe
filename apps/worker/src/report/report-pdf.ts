/**
 * Final report PDF (M6 part 5, §5.4, D-098): cover page with the case details and contents, then the
 * approved summary, chronology and index in the order the client requested them. Pure: the caller
 * loads and decrypts the locked deliverable versions and stores the bytes encrypted in S3. The output
 * is PHI; never log it.
 */
import { pdfSafe } from '@datascribe/billing';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ChronologyContent, IndexContent } from '../pipeline/deliverables';

export interface SummaryContent {
  kind: 'summary';
  sections: { heading: string; paragraphs: string[] }[];
  provider: string;
}

export type ReportSectionContent = SummaryContent | ChronologyContent | IndexContent;

export interface ReportInput {
  companyName: string;
  firmName: string;
  caseNumber: string;
  matterName: string;
  reference: string | null;
  patientName: string;
  /** YYYY-MM-DD or null */
  incidentDate: string | null;
  caseType: string;
  approvedAt: Date;
  /** the locked versions, in the order they appear in the report */
  sections: { content: ReportSectionContent; version: number }[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const BOTTOM = MARGIN + 30;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.44, 0.5);
const RULE = rgb(0.8, 0.82, 0.85);

const TITLES: Record<ReportSectionContent['kind'], string> = {
  summary: 'Medical summary',
  chronology: 'Medical chronology',
  index: 'Records index',
};

const RECORD_TYPES: Record<string, string> = {
  office_visit: 'Office visit',
  er: 'Emergency',
  imaging: 'Imaging',
  lab: 'Laboratory',
  operative: 'Operative',
  therapy: 'Therapy',
  pharmacy: 'Pharmacy',
  billing: 'Billing',
  other: 'Other',
};

/** Wrap text to a width, breaking on spaces and, for very long words, inside the word. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (let word of pdfSafe(text).split(' ')) {
    while (font.widthOfTextAtSize(word, size) > width && word.length > 1) {
      if (current) {
        lines.push(current);
        current = '';
      }
      let cut = word.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const range = (from: string | null, to: string | null) =>
  !from && !to ? '-' : from === to || !to ? (from ?? '-') : `${from ?? '?'} to ${to}`;

interface Column {
  title: string;
  width: number;
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly width = A4[0] - MARGIN * 2;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {}

  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  /** Start a new page when fewer than `needed` points are left; true when it did. */
  ensure(needed: number) {
    if (this.y - needed < BOTTOM) {
      this.newPage();
      return true;
    }
    return false;
  }

  text(s: string, x: number, opts: { size?: number; f?: PDFFont; color?: typeof INK } = {}) {
    this.page.drawText(pdfSafe(s), {
      x,
      y: this.y,
      size: opts.size ?? 10,
      font: opts.f ?? this.font,
      color: opts.color ?? INK,
    });
  }

  paragraph(
    s: string,
    opts: { size?: number; f?: PDFFont; color?: typeof INK; gap?: number } = {},
  ) {
    const size = opts.size ?? 10;
    const lead = size * 1.35;
    for (const line of wrapText(s, opts.f ?? this.font, size, this.width)) {
      this.ensure(lead);
      this.text(line, MARGIN, opts);
      this.y -= lead;
    }
    this.y -= opts.gap ?? 6;
  }

  heading(s: string, size = 16) {
    this.ensure(size + 30);
    this.text(s, MARGIN, { size, f: this.bold });
    this.y -= size + 4;
    this.rule();
    this.y -= 14;
  }

  rule(color = RULE) {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.width, y: this.y },
      thickness: 0.6,
      color,
    });
  }

  /** A table whose rows never split across pages; the header repeats on every page. */
  table(columns: Column[], rows: string[][], size = 8.5) {
    const lead = size * 1.3;
    const pad = 6;
    const header = () => {
      let x = MARGIN;
      for (const c of columns) {
        this.text(c.title, x, { size, f: this.bold });
        x += c.width;
      }
      this.y -= 5;
      this.rule(MUTED);
      this.y -= lead;
    };
    this.ensure(lead * 3);
    header();
    for (const row of rows) {
      const cells = row.map((v, i) => wrapText(v, this.font, size, columns[i]!.width - pad));
      const height = Math.max(...cells.map((c) => c.length)) * lead;
      if (this.ensure(height + 4)) header();
      let x = MARGIN;
      cells.forEach((lines, i) => {
        lines.forEach((line, n) => {
          this.page.drawText(line, {
            x,
            y: this.y - n * lead,
            size,
            font: this.font,
            color: INK,
          });
        });
        x += columns[i]!.width;
      });
      this.y -= height - lead + 5;
      this.rule();
      this.y -= lead;
    }
    this.y -= 6;
  }
}

function summarySection(w: Writer, s: SummaryContent) {
  for (const section of s.sections) {
    w.ensure(40);
    w.paragraph(section.heading, { size: 12, f: w.bold, gap: 2 });
    for (const p of section.paragraphs) w.paragraph(p);
    w.y -= 4;
  }
}

function chronologySection(w: Writer, c: ChronologyContent) {
  if (c.entries.length === 0) return w.paragraph('No dated medical events were found.');
  const cols = [
    { title: 'Date', width: 62 },
    { title: 'Provider / facility', width: 105 },
    { title: 'Event', width: 220 },
    { title: 'Source', width: w.width - 387 },
  ];
  w.table(
    cols,
    c.entries.map((e) => [
      e.date ?? 'Undated',
      [e.provider, e.facility].filter(Boolean).join(', ') || '-',
      [
        e.eventType ? `${e.eventType}: ${e.description}` : e.description,
        ...e.codes.map((k) => `${k.system} ${k.code} ${k.display}`),
      ].join(' | '),
      `${e.citation.fileName}, p. ${e.citation.pageNumber}`,
    ]),
  );
}

function indexSection(w: Writer, ix: IndexContent) {
  w.paragraph(
    `${ix.totals.documents} ${ix.totals.documents === 1 ? 'file' : 'files'}, ${ix.totals.pages} ${
      ix.totals.pages === 1 ? 'page' : 'pages'
    }.`,
    { color: MUTED },
  );
  if (ix.rows.length === 0) return;
  w.table(
    [
      { title: 'File', width: 130 },
      { title: 'Pages', width: 52 },
      { title: 'Record type', width: 72 },
      { title: 'Providers', width: 140 },
      { title: 'Dates', width: w.width - 394 },
    ],
    ix.rows.map((r) => [
      r.fileName,
      r.pageFrom === r.pageTo ? `${r.pageFrom}` : `${r.pageFrom}-${r.pageTo}`,
      RECORD_TYPES[r.recordType] ?? r.recordType,
      r.providers.join(', ') || '-',
      range(r.dateFrom, r.dateTo),
    ]),
  );
}

/** Render the final report. Returns the PDF bytes and its page count. */
export async function renderReportPdf(
  input: ReportInput,
): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Medical records report ${input.caseNumber}`);
  doc.setAuthor(pdfSafe(input.companyName));
  doc.setCreator('Datascribe');
  // fixed dates keep the output reproducible for the same input
  doc.setCreationDate(input.approvedAt);
  doc.setModificationDate(input.approvedAt);
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );

  // Cover
  w.newPage();
  w.text(input.companyName, MARGIN, { size: 12, f: w.bold, color: MUTED });
  w.y -= 90;
  w.paragraph('Medical records report', { size: 26, f: w.bold, gap: 4 });
  w.paragraph(input.matterName, { size: 14, gap: 30 });
  const details: [string, string][] = [
    ['Case number', input.caseNumber],
    ['Client', input.firmName],
    ['Reference', input.reference ?? '-'],
    ['Patient', input.patientName],
    ['Date of incident', input.incidentDate ?? '-'],
    ['Case type', input.caseType.replace(/_/g, ' ')],
    ['Approved', input.approvedAt.toISOString().slice(0, 10)],
  ];
  for (const [k, v] of details) {
    w.text(k, MARGIN, { color: MUTED });
    const lines = wrapText(v, w.font, 10, w.width - 140);
    lines.forEach((l, i) => {
      w.text(l, MARGIN + 140);
      if (i < lines.length - 1) w.y -= 14;
    });
    w.y -= 18;
  }
  w.y -= 20;
  w.text('Contents', MARGIN, { size: 12, f: w.bold });
  w.y -= 18;
  input.sections.forEach((s, i) => {
    w.text(`${i + 1}. ${TITLES[s.content.kind]} (version ${s.version})`, MARGIN);
    w.y -= 15;
  });
  w.y -= 30;
  w.paragraph(
    'Every chronology entry cites the source file and page it was taken from. This report contains ' +
      'protected health information; store and share it only as your engagement allows.',
    { size: 9, color: MUTED },
  );

  // Sections, each from a new page
  input.sections.forEach((s, i) => {
    w.newPage();
    w.heading(`${i + 1}. ${TITLES[s.content.kind]}`);
    if (s.content.kind === 'summary') summarySection(w, s.content);
    else if (s.content.kind === 'chronology') chronologySection(w, s.content);
    else indexSection(w, s.content);
  });

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = pdfSafe(
      `Confidential - ${input.caseNumber} - ${input.companyName} - page ${i + 1} of ${pages.length}`,
    );
    p.drawText(footer, { x: MARGIN, y: MARGIN - 20, size: 8, font: w.font, color: MUTED });
  });

  return { bytes: await doc.save(), pages: pages.length };
}
