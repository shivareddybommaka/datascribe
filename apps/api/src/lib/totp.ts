import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { safeEqual } from './timing';

// Accept the previous/next 30 s step to tolerate clock drift.
authenticator.options = { window: 1 };

export const newTotpSecret = (): string => authenticator.generateSecret();

export const totpUri = (email: string, secret: string): string =>
  authenticator.keyuri(email, 'Datascribe', secret);

export const totpQrDataUrl = (uri: string): Promise<string> => QRCode.toDataURL(uri);

const STEP_MS = 30_000;

/**
 * Checks the previous, current and next 30 s step, each with a constant-time compare and without
 * stopping at the first match (otplib compares with ===, audit L9).
 */
export function verifyTotp(code: string, secret: string, now = Date.now()): boolean {
  try {
    let ok = false;
    for (const delta of [-1, 0, 1]) {
      const expected = authenticator.clone({ epoch: now + delta * STEP_MS }).generate(secret);
      ok = safeEqual(expected, code) || ok;
    }
    return ok;
  } catch {
    return false;
  }
}
