/**
 * Renders a PDF page to a PNG for OCR (D-082). pdf.js draws onto an @napi-rs/canvas canvas
 * (prebuilt binaries, no system libraries). 200 dpi is enough for Tesseract on typed records; very
 * large pages are scaled down to a pixel budget so one odd page can't exhaust worker memory.
 * The same drawing gives the staff viewer its page images (`renderPagePreview`, D-085).
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
  return (await drawPage(page, scale)).toBuffer('image/png');
}

/** Staff workspace viewer (M6 part 2b, D-085): page width in pixels of the full image and thumbnail. */
export const PREVIEW_WIDTH = 1100;
export const THUMB_WIDTH = 160;
const JPEG_QUALITY = 80;

export interface PagePreview {
  image: Buffer;
  thumb: Buffer;
}

/** Renders the page once at viewer width and scales it down for the thumbnail; JPEG both. */
export async function renderPagePreview(
  page: PDFPageProxy,
  { width = PREVIEW_WIDTH, thumbWidth = THUMB_WIDTH } = {},
): Promise<PagePreview> {
  const base = page.getViewport({ scale: 1 });
  // a very tall page is capped by the same pixel budget as OCR
  let scale = width / base.width;
  const pixels = base.width * base.height * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const full = await drawPage(page, scale);
  const ratio = Math.min(1, thumbWidth / full.width);
  const small = createCanvas(
    Math.max(1, Math.round(full.width * ratio)),
    Math.max(1, Math.round(full.height * ratio)),
  );
  small.getContext('2d').drawImage(full, 0, 0, small.width, small.height);
  return {
    image: await full.encode('jpeg', JPEG_QUALITY),
    thumb: await small.encode('jpeg', JPEG_QUALITY),
  };
}

async function drawPage(page: PDFPageProxy, scale: number) {
  const viewport = page.getViewport({ scale });
  // round, not ceil: 432pt × (1100 / 432) can land a hair above 1100
  const canvas = createCanvas(
    Math.max(1, Math.round(viewport.width)),
    Math.max(1, Math.round(viewport.height)),
  );
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
  return canvas;
}
