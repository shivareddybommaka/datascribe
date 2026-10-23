import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where generated files (invoice PDFs) are kept. In-memory and local-disk stubs for now; the
 * S3 implementation (private bucket, SSE, signed URLs) arrives with M4 behind the same interface.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new RangeError(`Unsafe object key: ${key}`);
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string) {
    assertSafeKey(key);
    this.objects.set(key, { bytes, contentType });
  }

  async get(key: string) {
    assertSafeKey(key);
    return this.objects.get(key)?.bytes ?? null;
  }
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  private file(key: string) {
    assertSafeKey(key);
    return path.join(this.rootDir, ...key.split('/'));
  }

  async put(key: string, bytes: Uint8Array) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export const invoicePdfKey = (organizationId: string, invoiceNumber: string) =>
  `invoices/${organizationId}/${invoiceNumber}.pdf`;
