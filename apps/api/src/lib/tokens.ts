import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  typ: 'access';
  sub: string; // user id
  sid: string; // session id
  imp?: string; // impersonator user id (M2)
}

export interface MfaClaims {
  typ: 'mfa';
  sub: string;
  /** true when the user still has to enrol (internal role or org policy) */
  setup: boolean;
  /** issued at, in ms: the token is spent once a sign-in completes after it (audit L8) */
  at: number;
}

export function signAccessToken(claims: Omit<AccessClaims, 'typ'>, secret: string): string {
  return jwt.sign({ ...claims, typ: 'access' }, secret, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function signMfaToken(claims: Omit<MfaClaims, 'typ'>, secret: string): string {
  return jwt.sign({ ...claims, typ: 'mfa' }, secret, {
    algorithm: 'HS256',
    expiresIn: MFA_TOKEN_TTL_SECONDS,
  });
}

/** Returns null for any invalid/expired/wrong-type token; callers decide the error. */
export function verifyToken<T extends { typ: string }>(
  token: string,
  secret: string,
  typ: T['typ'],
): T | null {
  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] }) as unknown as T;
    return claims.typ === typ ? claims : null;
  } catch {
    return null;
  }
}

/** URL-safe random token for emails and refresh cookies. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Tokens are stored only as SHA-256 hashes. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
