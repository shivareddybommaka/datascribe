import argon2 from 'argon2';
import { z } from 'zod';

export const PasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Same work for unknown emails, so login timing doesn't reveal which accounts exist. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-placeholder');
  await verifyPassword(await dummyHash, password);
}
