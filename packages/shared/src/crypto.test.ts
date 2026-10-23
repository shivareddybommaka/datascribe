import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadKey } from './crypto';

const key = randomBytes(32);

describe('PHI encryption', () => {
  it('round-trips and never contains the plaintext', () => {
    const env = encrypt('Jane Synthetic Doe', key);
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain('Jane');
    expect(decrypt(env, key)).toBe('Jane Synthetic Doe');
  });

  it('uses a fresh IV each time', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key));
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = encrypt('hello', key).split(':');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join(':'), key)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() => decrypt(encrypt('hello', key), randomBytes(32))).toThrow();
  });

  it('validates key length', () => {
    expect(() => loadKey(undefined)).toThrow();
    expect(() => loadKey(randomBytes(16).toString('base64'))).toThrow();
    expect(loadKey(key.toString('base64'))).toHaveLength(32);
  });
});
