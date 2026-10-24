/**
 * Stage 2 — split and extract text (REQUIREMENTS.md §7). Reads the PDF text layer per page with
 * pdf.js; a page with fewer than 20 characters goes to the OcrProvider. Images (PNG/JPEG/TIFF) are
 * one OCR'd page. Never logs text.
 *
 * OCR needs the page as an image. Rendering is injected (`renderPage`, the worker passes
 * `renderPdfPage` with a real OCR provider, D-082); without one a low-text page keeps its text
 * layer and is reported in `needsOcr`.
 */
import type { OcrProvider } from '@datascribe/medical-data';
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MIN_TEXT_CHARS = 20;

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  /** 1 for a text layer, the OCR confidence (0..1) for OCR'd pages, null when OCR was needed but impossible */
  ocrConfidence: number | null;
}

export interface ExtractOptions {
  ocr: OcrProvider;
  /** renders a 1-based PDF page to an image for OCR; null = can't render */
  renderPage?: (pageNumber: number, page: PDFPageProxy) => Promise<Buffer | null>;
  /** called once for every page while it is open (viewer images, D-085) */
  onPage?: (pageNumber: number, page: PDFPageProxy) => Promise<void>;
}

export interface ExtractResult {
  pages: ExtractedPage[];
  ocrPages: number;
  needsOcr: number;
}

const visibleChars = (s: string) => s.replace(/\s+/g, '').length;

export async function extractPdfPages(
  data: Uint8Array,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  // pdf.js may transfer the buffer it is given, so it gets a copy.
  const pdf = await getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const result: ExtractResult = { pages: [], ocrPages: 0, needsOcr: 0 };
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      if (opts.onPage) {
        try {
          await opts.onPage(n, page);
        } catch (err) {
          page.cleanup();
          throw err;
        }
      }
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      text = text.replace(/[ \t]+\n/g, '\n').trim();

      if (visibleChars(text) >= MIN_TEXT_CHARS) {
        page.cleanup();
        result.pages.push({ pageNumber: n, text, ocrConfidence: 1 });
        continue;
      }
      let image: Buffer | null;
      try {
        image = opts.renderPage ? await opts.renderPage(n, page) : null;
      } finally {
        page.cleanup();
      }
      if (!image) {
        result.needsOcr++;
        result.pages.push({ pageNumber: n, text, ocrConfidence: null });
        continue;
      }
      const ocr = await opts.ocr.recognize(image);
      result.ocrPages++;
      result.pages.push({ pageNumber: n, text: ocr.text.trim(), ocrConfidence: ocr.confidence });
    }
  } finally {
    await pdf.destroy();
  }
  return result;
}

/** PNG/JPEG/TIFF uploads: the file itself is the image (multi-page TIFF goes to OCR as one file). */
export async function extractImagePage(data: Buffer, ocr: OcrProvider): Promise<ExtractResult> {
  const r = await ocr.recognize(data);
  return {
    pages: [{ pageNumber: 1, text: r.text.trim(), ocrConfidence: r.confidence }],
    ocrPages: 1,
    needsOcr: 0,
  };
}
