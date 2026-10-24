import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Tokens of staging's storage relay (D-122). A token stands in for an S3 signature: AES-256-GCM
 * sealed (the object key and file name aren't readable in a URL), bound to one operation on one
 * object, and expiring like the presigned URL it replaces.
 */

export const RELAY_PATH = '/api/v1/storage-relay';

const Token = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('put'),
    k: z.string(),
    u: z.string(),
    p: z.number().int().min(1).max(10_000),
    e: z.number(),
  }),
  z.object({ op: z.literal('get'), k: z.string(), n: z.string(), t: z.string(), e: z.number() }),
]);
export type RelayToken = z.infer<typeof Token>;

/** Own key for relay tokens, derived from the access-token secret (never the secret itself). */
export function relayKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'datascribe', 'storage-relay-v1', 32));
}

export function sealRelayToken(token: RelayToken, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The token, or null when it is forged, tampered with or expired. */
export function openRelayToken(value: string, key: Buffer, now = Date.now()): RelayToken | null {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    const token = Token.parse(JSON.parse(text.toString('utf8')));
    return token.e > now ? token : null;
  } catch {
    return null;
  }
}
