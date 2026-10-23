import { broadestScope, type Action, type Module } from '@datascribe/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Deps } from '../context';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyToken, type AccessClaims } from '../lib/tokens';
import { loadAuthContext, type AuthContext } from './context';
import { isIdle } from './session';

const TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * Resolve the bearer access token into req.auth. The session row is checked on every request,
 * so logout, "revoke all sessions" and idle timeouts take effect immediately.
 */
export async function resolveAuth(deps: Deps, req: Request): Promise<AuthContext> {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw unauthorized();
  const claims = verifyToken<AccessClaims>(token, deps.env.JWT_ACCESS_SECRET, 'access');
  if (!claims) throw unauthorized('invalid_token', 'Invalid or expired token');

  const session = await deps.prisma.session.findUnique({ where: { id: claims.sid } });
  const now = new Date();
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < now) {
    throw unauthorized('session_revoked', 'Session has ended, please sign in again');
  }
  if (isIdle(session, now)) {
    await deps.prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
    throw unauthorized('session_idle', 'Signed out after inactivity');
  }
  if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await deps.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: now } });
  }

  const ctx = await loadAuthContext(deps.prisma, claims.sub, session.id, claims.imp);
  if (!ctx) throw unauthorized('account_inactive', 'Account is not active');
  return ctx;
}

export function authenticate(deps: Deps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await resolveAuth(deps, req);
    next();
  };
}

/** Route-level gate: the user must hold module:action at some scope. Row-level checks follow in the handler. */
export function requirePermission(module: Module, action: Action): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!broadestScope(req.auth.permissions, module, action)) throw forbidden();
    next();
  };
}

/**
 * CSRF guard for cookie-authenticated routes (refresh, logout). The refresh cookie is
 * SameSite=Strict; in addition we require a custom header (forces a CORS preflight) and,
 * when present, an Origin matching APP_URL.
 */
export function requireCsrf(deps: Deps): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    const trusted = [deps.env.APP_URL, ...deps.env.EXTRA_TRUSTED_ORIGINS];
    if (req.get('x-datascribe-csrf') !== '1' || (origin && !trusted.includes(origin))) {
      throw forbidden('CSRF check failed');
    }
    next();
  };
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
