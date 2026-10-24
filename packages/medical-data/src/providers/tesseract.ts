/**
 * Tesseract OCR (REQUIREMENTS.md §2, §7 stage 2) via tesseract.js, which runs the engine as WASM in
 * a worker thread: no system install. The English model comes from the `@tesseract.js-data/eng`
 * package, so nothing is downloaded at runtime and page images never leave the process (D-082).
 * Never logs text.
 */
import { createRequire } from 'node:module';
import type { OcrProvider } from '../types';

type TesseractWorker = {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
};

export interface TesseractOptions {
  /** directory holding `<lang>.traineddata.gz`; default: the bundled `@tesseract.js-data/eng` */
  langPath?: string;
  lang?: string;
}

export class TesseractOcrProvider implements OcrProvider {
  private worker: Promise<TesseractWorker> | null = null;

  constructor(private readonly opts: TesseractOptions = {}) {}

  private start(): Promise<TesseractWorker> {
    this.worker ??= (async () => {
      const require = createRequire(import.meta.url);
      const { createWorker } = (await import('tesseract.js')) as unknown as {
        createWorker: (lang: string, oem: number, options: object) => Promise<TesseractWorker>;
      };
      const data = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
      return createWorker(this.opts.lang ?? 'eng', 1, {
        langPath: this.opts.langPath ?? data.langPath,
        gzip: data.gzip,
        // no traineddata cache files next to the app, no progress logging
        cacheMethod: 'none',
        logger: () => {},
        errorHandler: () => {},
      });
    })();
    // a failed start (bad langPath) is retried on the next call instead of sticking
    this.worker.catch(() => {
      this.worker = null;
    });
    return this.worker;
  }

  async recognize(image: Buffer) {
    const worker = await this.start();
    const { data } = await worker.recognize(image);
    // tesseract reports 0..100; pages store 0..1 like the text-layer confidence of 1
    return { text: data.text, confidence: Math.max(0, Math.min(1, data.confidence / 100)) };
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await (await worker).terminate();
  }
}
