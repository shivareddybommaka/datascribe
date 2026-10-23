import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level PHI encryption (REQUIREMENTS.md §6): AES-256-GCM.
 * Envelope format: "v1:<iv b64>:<tag b64>:<ciphertext b64>". The version prefix lets us rotate
 * keys / move to KMS data keys later without a data migration of the format.
 */

const VERSION = 'v1';

export function loadKey(base64Key: string | undefined): Buffer {
  if (!base64Key) throw new Error('PHI_ENCRYPTION_KEY is not set');
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('PHI_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** True for a value produced by encrypt() (any future version prefix included). */
export const isEnvelope = (value: string): boolean => /^v\d+:[^:]*:[^:]*:[^:]*$/.test(value);

export function decrypt(envelope: string, key: Buffer): string {
  const [version, iv, tag, ct] = envelope.split(':');
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error('Unrecognised ciphertext envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
