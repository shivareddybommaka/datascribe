import { randomUUID } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { Deps } from '../context';
import { REFRESH_TOKEN_TTL_MS, randomToken, sha256, signAccessToken } from '../lib/tokens';

export type Surface = 'portal' | 'console';

export const REFRESH_COOKIE = 'ds_refresh';

/** §5.2: idle timeout 15 min in the staff console, 30 min in the client portal. */
export const IDLE_TIMEOUT_MS: Record<Surface, number> = {
  console: 15 * 60 * 1000,
  portal: 30 * 60 * 1000,
};

export const surfaceFor = (orgType: 'client' | 'internal'): Surface =>
  orgType === 'internal' ? 'console' : 'portal';

export function isIdle(session: { surface: string; lastUsedAt: Date }, now = new Date()): boolean {
  const limit = IDLE_TIMEOUT_MS[session.surface as Surface] ?? IDLE_TIMEOUT_MS.console;
  return now.getTime() - session.lastUsedAt.getTime() > limit;
}

function cookieOptions(deps: Deps): CookieOptions {
  return {
    httpOnly: true,
    secure: deps.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

export function setRefreshCookie(deps: Deps, res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(deps));
}

export function clearRefreshCookie(deps: Deps, res: Response) {
  const opts = cookieOptions(deps);
  delete opts.maxAge;
  res.clearCookie(REFRESH_COOKIE, opts);
}

/**
 * Create a session (or the next link in a rotation family), set the refresh cookie and return
 * a fresh access token.
 */
export async function issueSession(
  deps: Deps,
  req: Request,
  res: Response,
  user: { id: string; orgType: 'client' | 'internal' },
  familyId: string = randomUUID(),
): Promise<{ accessToken: string; sessionId: string }> {
  const refreshToken = randomToken();
  const session = await deps.prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      familyId,
      surface: surfaceFor(user.orgType),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
    },
  });
  setRefreshCookie(deps, res, refreshToken);
  const accessToken = signAccessToken(
    { sub: user.id, sid: session.id },
    deps.env.JWT_ACCESS_SECRET,
  );
  return { accessToken, sessionId: session.id };
}
