import { createHash } from 'node:crypto';

export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Response cache for provider calls (§8.4). Keys are hashes, so stored rows never hold the term. */
export interface CacheStore {
  get(provider: string, requestHash: string): Promise<unknown | undefined>;
  set(provider: string, requestHash: string, value: unknown, ttlMs: number): Promise<void>;
}

/** Normalise a request (lowercase, trimmed, collapsed spaces) and hash it. */
export function requestHash(parts: (string | number | undefined)[]): string {
  const normalised = parts
    .map((p) =>
      String(p ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' '),
    )
    .join('\u001f');
  return createHash('sha256').update(normalised).digest('hex');
}

/** In-process cache for tests and the mock setup. */
export class MemoryCacheStore implements CacheStore {
  private readonly rows = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(provider: string, hash: string) {
    const row = this.rows.get(`${provider}:${hash}`);
    if (!row) return undefined;
    if (row.expiresAt <= this.now()) {
      this.rows.delete(`${provider}:${hash}`);
      return undefined;
    }
    return structuredClone(row.value);
  }

  async set(provider: string, hash: string, value: unknown, ttlMs: number) {
    this.rows.set(`${provider}:${hash}`, {
      value: structuredClone(value),
      expiresAt: this.now() + ttlMs,
    });
  }

  get size() {
    return this.rows.size;
  }
}

/**
 * The slice of Prisma's `medicalApiCache` delegate this store uses. Typed structurally so this
 * package needs no dependency on `@datascribe/db`; pass `prisma.medicalApiCache`.
 */
export interface MedicalApiCacheDelegate {
  findUnique(args: {
    where: { provider_requestHash: { provider: string; requestHash: string } };
  }): Promise<{ response: unknown; expiresAt: Date } | null>;
  upsert(args: {
    where: { provider_requestHash: { provider: string; requestHash: string } };
    create: { provider: string; requestHash: string; response: never; expiresAt: Date };
    update: { response: never; expiresAt: Date };
  }): Promise<unknown>;
  deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }>;
}

/** MedicalApiCache table (§6). Expired rows are ignored on read and removed by `purgeExpired`. */
export class PrismaCacheStore implements CacheStore {
  constructor(
    private readonly table: MedicalApiCacheDelegate,
    private readonly now: () => number = Date.now,
  ) {}

  async get(provider: string, hash: string) {
    const row = await this.table.findUnique({
      where: { provider_requestHash: { provider, requestHash: hash } },
    });
    if (!row || row.expiresAt.getTime() <= this.now()) return undefined;
    return unwrapNull(row.response);
  }

  async set(provider: string, hash: string, value: unknown, ttlMs: number) {
    const expiresAt = new Date(this.now() + ttlMs);
    // null is not a valid Prisma Json input; store it wrapped so "no match" is cacheable too.
    const response = (value === null ? { __null: true } : value) as never;
    await this.table.upsert({
      where: { provider_requestHash: { provider, requestHash: hash } },
      create: { provider, requestHash: hash, response, expiresAt },
      update: { response, expiresAt },
    });
  }

  async purgeExpired(): Promise<number> {
    const { count } = await this.table.deleteMany({
      where: { expiresAt: { lt: new Date(this.now()) } },
    });
    return count;
  }
}

function unwrapNull(value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { __null?: boolean }).__null === true) {
    return null;
  }
  return value;
}
