import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { groupDigits, pdfSafe, renderInvoicePdf, type InvoicePdfInput } from './pdf';
import {
  LocalObjectStore,
  MemoryObjectStore,
  assertSafeKey,
  invoicePdfKey,
  repoPath,
  repoRoot,
} from './storage';

const input = (lines = 2): InvoicePdfInput => ({
  company: {
    name: 'Datascribe',
    address: '1 Example St, Sydney NSW',
    email: 'billing@datascribe.example',
    taxId: 'ABN 00 000 000 000',
  },
  billTo: { name: 'Acme Injury Law (synthetic)' },
  number: 'INV-2026-00001',
  status: 'issued',
  currency: 'INR',
  issuedAt: new Date('2026-06-01T00:00:00Z'),
  dueAt: new Date('2026-06-15T00:00:00Z'),
  periodStart: new Date('2026-05-01T00:00:00Z'),
  periodEnd: new Date('2026-06-01T00:00:00Z'),
  lines: Array.from({ length: lines }, (_, i) => ({
    description: `Line ${i + 1} — a fairly long description that has to wrap onto a second line in the table ₹`,
    quantity: '1.00',
    unitPrice: '1499.0000',
    amount: '1499.00',
  })),
  subtotal: '2998.00',
  taxLabel: 'GST',
  taxRatePercent: '18.00',
  tax: '539.64',
  total: '3537.64',
  notes: 'Thank you.\nPayment by card.',
});

describe('invoice PDF', () => {
  it('renders a valid PDF with title and one page', async () => {
    const bytes = await renderInvoicePdf(input());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe('Invoice INV-2026-00001');
    expect(doc.getPageCount()).toBe(1);
  });

  it('paginates long invoices', async () => {
    const doc = await PDFDocument.load(await renderInvoicePdf(input(60)));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('helpers', () => {
    expect(pdfSafe('₹100 — ok\n')).toBe('?100 — ok ');
    expect(groupDigits('1234567.50')).toBe('1,234,567.50');
    expect(groupDigits('-1000')).toBe('-1,000');
  });
});

describe('object stores', () => {
  it('memory store round-trips', async () => {
    const s = new MemoryObjectStore();
    await s.put('invoices/o1/INV-1.pdf', new Uint8Array([1, 2]), 'application/pdf');
    expect(await s.get('invoices/o1/INV-1.pdf')).toEqual(new Uint8Array([1, 2]));
    expect(await s.get('invoices/o1/missing.pdf')).toBeNull();
  });

  it('local store writes under its root only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ds-store-'));
    try {
      const s = new LocalObjectStore(dir);
      const key = invoicePdfKey('org1', 'INV-2026-00001');
      await s.put(key, new Uint8Array([9]), 'application/pdf');
      expect(await s.get(key)).toEqual(new Uint8Array([9]));
      expect(await s.get('invoices/none.pdf')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves relative storage dirs from the repo root', () => {
    const here = import.meta.dirname;
    const root = repoRoot(here);
    expect(root).not.toBe(here);
    expect(repoPath('.data/invoices', here)).toBe(path.join(root, '.data/invoices'));
    expect(repoPath('/tmp/x')).toBe('/tmp/x');
    expect(repoRoot('/')).toBe('/');
  });

  it('refuses path traversal', () => {
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a//b', '.hidden', 'a/./b']) {
      expect(() => assertSafeKey(bad)).toThrow(RangeError);
    }
    expect(() => assertSafeKey('invoices/o1/INV-2026-00001.pdf')).not.toThrow();
  });
});
