import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { countPages, tiffPageCount } from './pages';

const b = (...bytes: number[]) => Uint8Array.from(bytes);

describe('tiffPageCount', () => {
  it('walks the IFD chain (little and big endian) and refuses loops', () => {
    // LE: header → IFD at 8 (0 entries) → IFD at 14 (0 entries) → end
    const two = b(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(tiffPageCount(two)).toBe(2);
    const be = b(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0);
    expect(tiffPageCount(be)).toBe(1);
    const loop = b(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 8, 0, 0, 0);
    expect(tiffPageCount(loop)).toBeNull();
    expect(tiffPageCount(b(0x49, 0x49, 0x2a, 0, 200, 0, 0, 0))).toBeNull();
    expect(tiffPageCount(b(0x49, 0x49))).toBeNull();
  });
});

describe('countPages', () => {
  it('counts PDF pages, treats PNG/JPEG as one page and returns null for broken files', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    pdf.addPage();
    expect(await countPages('application/pdf', await pdf.save())).toBe(3);
    expect(await countPages('image/png', b(0x89, 0x50))).toBe(1);
    expect(await countPages('application/pdf', new TextEncoder().encode('%PDF-broken'))).toBeNull();
  });
});
