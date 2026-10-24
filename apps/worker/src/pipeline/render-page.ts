/**
 * Renders a PDF page to a PNG for OCR (D-082). pdf.js draws onto an @napi-rs/canvas canvas
 * (prebuilt binaries, no system libraries). 200 dpi is enough for Tesseract on typed records; very
 * large pages are scaled down to a pixel budget so one odd page can't exhaust worker memory.
 */
import { createCanvas } from '@napi-rs/canvas';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const OCR_DPI = 200;
export const MAX_PIXELS = 25_000_000;

export async function renderPdfPage(
  page: PDFPageProxy,
  { dpi = OCR_DPI, maxPixels = MAX_PIXELS } = {},
): Promise<Buffer> {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const pixels = base.width * base.height * scale * scale;
  if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  // transparent pixels read as black to Tesseract
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // pdf.js types expect DOM canvases; @napi-rs/canvas implements the same 2D API
  type RenderParams = Parameters<PDFPageProxy['render']>[0];
  await page.render({
    canvas: canvas as unknown as RenderParams['canvas'],
    canvasContext: ctx as unknown as RenderParams['canvasContext'],
    viewport,
  }).promise;
  return canvas.toBuffer('image/png');
}
