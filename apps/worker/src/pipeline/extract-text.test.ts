import { MockOcrProvider } from '@datascribe/medical-data';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractImagePage, extractPdfPages } from './extract-text';

// Synthetic PDF: page 1 has a text layer, pages 2 and 3 are "scanned" (no / too little text).
async function syntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText('OFFICE VISIT', { x: 50, y: 740, size: 14, font });
  p1.drawText('Date of Service: 03/14/2025', { x: 50, y: 720, size: 11, font });
  doc.addPage([612, 792]);
  doc.addPage([612, 792]).drawText('p. 3', { x: 50, y: 740, size: 11, font });
  return doc.save();
}

describe('extractPdfPages', () => {
  it('reads the text layer and sends low-text pages to OCR', async () => {
    const result = await extractPdfPages(await syntheticPdf(), {
      ocr: new MockOcrProvider(),
      renderPage: async (n) => (n === 2 ? Buffer.from('LABORATORY RESULTS scanned page') : null),
    });
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]).toMatchObject({ pageNumber: 1, ocrConfidence: 1 });
    expect(result.pages[0]!.text).toMatch(/OFFICE VISIT\s+Date of Service: 03\/14\/2025/);
    expect(result.pages[1]).toEqual({
      pageNumber: 2,
      text: 'LABORATORY RESULTS scanned page',
      ocrConfidence: 0.99,
    });
    // page 3 can't be rendered: kept as-is and counted
    expect(result.pages[2]).toEqual({ pageNumber: 3, text: 'p. 3', ocrConfidence: null });
    expect(result).toMatchObject({ ocrPages: 1, needsOcr: 1 });
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(
      extractPdfPages(new TextEncoder().encode('not a pdf'), { ocr: new MockOcrProvider() }),
    ).rejects.toThrow();
  });
});

describe('extractImagePage', () => {
  it('OCRs the whole image as page 1', async () => {
    const r = await extractImagePage(Buffer.from('RADIOLOGY REPORT'), new MockOcrProvider());
    expect(r.pages).toEqual([{ pageNumber: 1, text: 'RADIOLOGY REPORT', ocrConfidence: 0.99 }]);
  });
});
