// Real Tesseract + page renderer on a synthetic "scanned" page (D-082, D-085): no mocks, no network.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { TesseractOcrProvider } from '@datascribe/medical-data';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { extractImagePage, extractPdfPages } from './extract-text';
import { PREVIEW_WIDTH, THUMB_WIDTH, renderPagePreview, renderPdfPage } from './render-page';

const LINES = ['DISCHARGE SUMMARY', 'Patient: Test Synthetic', 'Diagnosis: Pneumonia'];

function scannedImage(): Buffer {
  const canvas = createCanvas(1200, 400);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 56px sans-serif';
  LINES.forEach((line, i) => ctx.fillText(line, 40, 100 + i * 110));
  return canvas.toBuffer('image/png');
}

async function scannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(scannedImage());
  // 6in x 2in page, image only: no text layer, like a scan
  const page = doc.addPage([432, 144]);
  page.drawImage(png, { x: 0, y: 0, width: 432, height: 144 });
  return doc.save();
}

const ocr = new TesseractOcrProvider();
afterAll(() => ocr.close());

const words = (s: string) => s.toUpperCase().replace(/\s+/g, ' ');

describe('tesseract OCR', () => {
  it('reads a scanned PDF page rendered with pdf.js', { timeout: 60_000 }, async () => {
    const result = await extractPdfPages(await scannedPdf(), {
      ocr,
      renderPage: (_n, page) => renderPdfPage(page),
    });
    expect(result).toMatchObject({ ocrPages: 1, needsOcr: 0 });
    const [page] = result.pages;
    expect(words(page!.text)).toContain('DISCHARGE SUMMARY');
    expect(words(page!.text)).toContain('PNEUMONIA');
    expect(page!.ocrConfidence).toBeGreaterThan(0.6);
    expect(page!.ocrConfidence).toBeLessThanOrEqual(1);
  });

  it('reads an image upload directly', { timeout: 60_000 }, async () => {
    const result = await extractImagePage(scannedImage(), ocr);
    expect(words(result.pages[0]!.text)).toContain('DISCHARGE SUMMARY');
  });
});

describe('viewer page preview (D-085)', () => {
  it('renders a JPEG at viewer width and a thumbnail of every page', async () => {
    const previews: { n: number; image: Buffer; thumb: Buffer }[] = [];
    await extractPdfPages(await scannedPdf(), {
      ocr,
      onPage: async (n, page) => {
        previews.push({ n, ...(await renderPagePreview(page)) });
      },
    });
    expect(previews.map((p) => p.n)).toEqual([1]);
    const { image, thumb } = previews[0]!;
    const jpeg = (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg(image) && jpeg(thumb)).toBe(true);
    const full = await loadImage(image);
    const small = await loadImage(thumb);
    expect(full.width).toBe(PREVIEW_WIDTH);
    expect(full.height).toBe(Math.round(PREVIEW_WIDTH / 3)); // the 6in x 2in page keeps its shape
    expect(small.width).toBe(THUMB_WIDTH);
    expect(thumb.length).toBeLessThan(image.length);
  });
});
