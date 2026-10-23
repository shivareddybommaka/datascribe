import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// Accept the previous/next 30 s step to tolerate clock drift.
authenticator.options = { window: 1 };

export const newTotpSecret = (): string => authenticator.generateSecret();

export const totpUri = (email: string, secret: string): string =>
  authenticator.keyuri(email, 'Datascribe', secret);

export const totpQrDataUrl = (uri: string): Promise<string> => QRCode.toDataURL(uri);

export function verifyTotp(code: string, secret: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}
