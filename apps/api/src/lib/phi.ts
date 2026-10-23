import { decrypt, encrypt, isEnvelope } from '@datascribe/shared';

/** Encrypt an optional PHI field; empty strings are stored as null. */
export const encryptOptional = (value: string | null | undefined, key: Buffer): string | null =>
  value ? encrypt(value, key) : null;

/**
 * Decrypt an optional PHI field. Plaintext can only exist on databases that haven't run the L5
 * backfill yet (the CHECK constraints refuse new plaintext), so it is passed through unchanged.
 */
export const decryptOptional = (value: string | null, key: Buffer): string | null =>
  value === null ? null : isEnvelope(value) ? decrypt(value, key) : value;
