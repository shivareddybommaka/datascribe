import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface CompanyDetails {
  name: string;
  address: string;
  email?: string;
  taxId?: string;
}

export interface InvoicePdfInput {
  company: CompanyDetails;
  billTo: { name: string };
  number: string;
  status: string;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
  subtotal: string;
  taxLabel: string;
  taxRatePercent: string;
  tax: string;
  total: string;
  notes?: string | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.44, 0.5);

/** The standard PDF fonts only cover WinAnsi; replace anything else rather than crash. */
const ALLOWED_HIGH = new Set([...'–—‘’“”•€…']);
export const pdfSafe = (s: string) =>
  [...s.replace(/[\r\n\t]+/g, ' ')]
    .map((c) => (c.charCodeAt(0) <= 0xff || ALLOWED_HIGH.has(c) ? c : '?'))
    .join('');

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');

/** Thousands separators on a fixed decimal string: "12345.60" → "12,345.60". */
export const groupDigits = (v: string) => {
  const [whole, frac] = v.split('.');
  const neg = whole!.startsWith('-');
  const digits = (neg ? whole!.slice(1) : whole!).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${digits}${frac !== undefined ? `.${frac}` : ''}`;
};

/** Wrap text to a width, breaking on spaces. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && current) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** Invoice PDF (§5.6): company details, bill-to, number, lines, tax line and total. */
export async function renderInvoicePdf(inv: InvoicePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setAuthor(pdfSafe(inv.company.name));
  doc.setCreator('Datascribe');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage(A4);
  const width = A4[0] - MARGIN * 2;
  let y = A4[1] - MARGIN;

  const text = (
    s: string,
    x: number,
    opts: { size?: number; f?: PDFFont; color?: typeof INK; right?: boolean } = {},
  ) => {
    const size = opts.size ?? 10;
    const f = opts.f ?? font;
    const safe = pdfSafe(s);
    const dx = opts.right ? x - f.widthOfTextAtSize(safe, size) : x;
    page.drawText(safe, { x: dx, y, size, font: f, color: opts.color ?? INK });
  };
  const newPageIfNeeded = (needed: number) => {
    if (y - needed < MARGIN + 40) {
      page = doc.addPage(A4);
      y = A4[1] - MARGIN;
    }
  };

  // Header: company on the left, INVOICE + number on the right
  text(inv.company.name, MARGIN, { size: 16, f: bold });
  text('INVOICE', MARGIN + width, { size: 18, f: bold, right: true });
  y -= 18;
  for (const line of inv.company.address.split(/\n|,\s*/).filter(Boolean)) {
    text(line.trim(), MARGIN, { color: MUTED });
    y -= 13;
  }
  if (inv.company.email) {
    text(inv.company.email, MARGIN, { color: MUTED });
    y -= 13;
  }
  if (inv.company.taxId) {
    text(`Tax ID: ${inv.company.taxId}`, MARGIN, { color: MUTED });
    y -= 13;
  }

  y -= 12;
  const meta: [string, string][] = [
    ['Invoice number', inv.number],
    ['Issue date', day(inv.issuedAt)],
    ['Due date', day(inv.dueAt)],
    ['Status', inv.status],
  ];
  if (inv.periodStart && inv.periodEnd) {
    meta.push(['Period', `${day(inv.periodStart)} to ${day(new Date(inv.periodEnd.getTime() - 1))}`]);
  }
  const metaTop = y;
  text('Bill to', MARGIN, { f: bold });
  y -= 14;
  for (const l of wrap(inv.billTo.name, font, 10, width / 2 - 10)) {
    text(l, MARGIN);
    y -= 13;
  }
  y = metaTop;
  for (const [k, v] of meta) {
    text(k, MARGIN + width - 220, { color: MUTED });
    text(v, MARGIN + width, { right: true, f: k === 'Invoice number' ? bold : font });
    y -= 14;
  }

  // Lines table
  y -= 20;
  const col = {
    desc: MARGIN,
    qty: MARGIN + width - 190,
    unit: MARGIN + width - 95,
    amount: MARGIN + width,
  };
  const head = () => {
    text('Description', col.desc, { f: bold });
    text('Qty', col.qty, { f: bold, right: true });
    text(`Unit (${inv.currency})`, col.unit, { f: bold, right: true });
    text(`Amount (${inv.currency})`, col.amount, { f: bold, right: true });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + width, y },
      thickness: 0.7,
      color: MUTED,
    });
    y -= 14;
  };
  head();
  for (const line of inv.lines) {
    const descLines = wrap(line.description, font, 10, col.qty - col.desc - 60);
    newPageIfNeeded(descLines.length * 13 + 4);
    text(groupDigits(line.quantity.replace(/\.00$/, '')), col.qty, { right: true });
    text(groupDigits(line.unitPrice.replace(/(\.\d\d)00$/, '$1')), col.unit, { right: true });
    text(groupDigits(line.amount), col.amount, { right: true });
    for (const dl of descLines) {
      text(dl, col.desc);
      y -= 13;
    }
    y -= 4;
  }

  // Totals
  newPageIfNeeded(70);
  y -= 6;
  page.drawLine({
    start: { x: MARGIN + width - 220, y: y + 8 },
    end: { x: MARGIN + width, y: y + 8 },
    thickness: 0.7,
    color: MUTED,
  });
  const totals: [string, string, boolean][] = [
    ['Subtotal', inv.subtotal, false],
    [`${inv.taxLabel} (${inv.taxRatePercent.replace(/\.00$/, '')}%)`, inv.tax, false],
    [`Total (${inv.currency})`, inv.total, true],
  ];
  for (const [k, v, strong] of totals) {
    text(k, MARGIN + width - 220, { f: strong ? bold : font });
    text(groupDigits(v), MARGIN + width, { right: true, f: strong ? bold : font });
    y -= 15;
  }

  if (inv.notes) {
    y -= 15;
    newPageIfNeeded(40);
    text('Notes', MARGIN, { f: bold });
    y -= 13;
    for (const l of wrap(inv.notes, font, 9, width)) {
      newPageIfNeeded(13);
      text(l, MARGIN, { size: 9, color: MUTED });
      y -= 12;
    }
  }

  // Footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = pdfSafe(`${inv.company.name} - Invoice ${inv.number} - page ${i + 1} of ${pages.length}`);
    p.drawText(footer, { x: MARGIN, y: MARGIN - 20, size: 8, font, color: MUTED });
  });

  return doc.save();
}
