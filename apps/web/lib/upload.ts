/**
 * Resumable uploads for the client portal (§5.3): S3 multipart, parts PUT straight from the
 * browser with presigned URLs, then /complete. Picking the same file again (same case, name, size,
 * modification time) resumes: the API reports which parts S3 already has and only the rest are
 * sent. The browser remembers just a SHA-256 fingerprint → upload id, never names or content.
 */
import { api } from './api';
import type { UploadState } from './types';

export const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/png,image/jpeg,image/tiff';
export const MAX_BYTES = 500 * 1024 * 1024;

const BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const ALLOWED = new Set(Object.values(BY_EXT));

/** The type we announce; the API re-checks the real type from the file's first bytes. */
export function declaredType(file: File): string | null {
  if (ALLOWED.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXT[ext] ?? null;
}

/** Reason a file can't be uploaded, or null. */
export function rejectReason(file: File): string | null {
  if (!declaredType(file)) return 'Only PDF, PNG, JPEG or TIFF files can be uploaded';
  if (file.size === 0) return 'This file is empty';
  if (file.size > MAX_BYTES) return 'Files can be up to 500 MB';
  return null;
}

const STORE = 'ds.uploads.v1';

async function fingerprint(caseId: string, file: File): Promise<string> {
  const text = `${caseId}\n${file.name}\n${file.size}\n${file.lastModified}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function remembered(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function remember(fp: string, id: string | null) {
  const all = remembered();
  if (id) all[fp] = id;
  else delete all[fp];
  localStorage.setItem(STORE, JSON.stringify(all));
}

function putPart(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Paused', 'AbortError'));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload of a part failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.onabort = () => reject(new DOMException('Paused', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Paused', 'AbortError'));
      },
      { once: true },
    );
  });

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export interface UploadCallbacks {
  onProgress: (loaded: number, total: number) => void;
  /** all bytes are in S3; the API is checking type, hash and viruses */
  onVerifying?: () => void;
  signal: AbortSignal;
}

const PARALLEL = 3;
const ATTEMPTS = 3;

export async function uploadFile(
  caseId: string,
  file: File,
  cb: UploadCallbacks,
): Promise<UploadState> {
  const fp = await fingerprint(caseId, file);
  let state: UploadState | null = null;
  const knownId = remembered()[fp];
  if (knownId) {
    state = await api<UploadState>(`/uploads/${knownId}`).catch(() => null);
    if (!state || state.completed || state.sizeBytes !== file.size) {
      remember(fp, null);
      state = null;
    }
  }
  if (!state) {
    state = await api<UploadState>(`/cases/${caseId}/uploads`, {
      method: 'POST',
      body: { fileName: file.name, mimeType: declaredType(file), sizeBytes: file.size },
    });
    remember(fp, state.id);
  }
  const upload = state;

  const partBytes = (n: number) => Math.min(upload.partSize, file.size - (n - 1) * upload.partSize);
  const done = new Set(upload.uploadedParts);
  let doneBytes = [...done].reduce((sum, n) => sum + partBytes(n), 0);
  const inFlight = new Map<number, number>();
  const report = () =>
    cb.onProgress(doneBytes + [...inFlight.values()].reduce((a, b) => a + b, 0), file.size);
  report();

  const queue = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
    (n) => !done.has(n),
  );
  async function worker() {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const start = (n - 1) * upload.partSize;
      const blob = file.slice(start, start + partBytes(n));
      for (let attempt = 1; ; attempt++) {
        try {
          // presigned just in time, so slow uploads never hold an expired URL
          const { parts } = await api<{ parts: { partNumber: number; url: string }[] }>(
            `/uploads/${upload.id}/parts`,
            { method: 'POST', body: { partNumbers: [n] } },
          );
          await putPart(
            parts[0]!.url,
            blob,
            (loaded) => {
              inFlight.set(n, loaded);
              report();
            },
            cb.signal,
          );
          inFlight.delete(n);
          doneBytes += blob.size;
          report();
          break;
        } catch (e) {
          inFlight.delete(n);
          report();
          if (isAbort(e) || attempt >= ATTEMPTS) throw e;
          await sleep(500 * 2 ** (attempt - 1), cb.signal);
        }
      }
    }
  }
  if (queue.length > 0) {
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(PARALLEL, queue.length) }, worker),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  cb.onVerifying?.();
  const completed = await api<UploadState>(`/uploads/${upload.id}/complete`, {
    method: 'POST',
    body: {},
  });
  remember(fp, null);
  return completed;
}
