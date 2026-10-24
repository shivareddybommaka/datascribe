import { authenticator } from 'otplib';
import { describe, expect, it } from 'vitest';
import { safeEqual } from './timing';
import { verifyTotp } from './totp';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const codeAt = (ms: number) => authenticator.clone({ epoch: ms }).generate(SECRET);

describe('constant-time compares (audit L9)', () => {
  it('safeEqual matches only identical strings, whatever the lengths', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
    expect(safeEqual('123456', '123457')).toBe(false);
    expect(safeEqual('123456', '12345')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('verifyTotp accepts the previous, current and next step only', () => {
    const now = Date.UTC(2026, 9, 24, 1, 0, 15);
    for (const delta of [-1, 0, 1])
      expect(verifyTotp(codeAt(now + delta * 30_000), SECRET, now)).toBe(true);
    expect(verifyTotp(codeAt(now - 2 * 30_000), SECRET, now)).toBe(false);
    expect(verifyTotp(codeAt(now + 2 * 30_000), SECRET, now)).toBe(false);
    expect(verifyTotp('12345', SECRET, now)).toBe(false);
  });
});
