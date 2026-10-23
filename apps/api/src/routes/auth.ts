import { decrypt, encrypt, permissionKey } from '@datascribe/shared';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireAuth, requireCsrf, resolveAuth } from '../auth/middleware';
import { REFRESH_COOKIE, clearRefreshCookie, isIdle, issueSession } from '../auth/session';
import type { Deps } from '../context';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { PasswordSchema, burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password';
import { randomToken, sha256, signMfaToken, verifyToken, type MfaClaims } from '../lib/tokens';
import { newTotpSecret, totpQrDataUrl, totpUri, verifyTotp } from '../lib/totp';
import { parse } from '../lib/validate';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export const Email = z.string().trim().toLowerCase().email().max(254);

const invalidCredentials = () =>
  unauthorized('invalid_credentials', 'Email or password is incorrect');

export function rateLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res
        .status(429)
        .json({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
    },
  });
}

type LoginUser = {
  mfaEnabled: boolean;
  organization: { type: 'client' | 'internal'; settings: unknown };
  roles: { role: { isInternal: boolean } }[];
};

/** §5.2: MFA mandatory for internal roles, optional for client roles unless the org enforces it. */
function mfaRequired(user: LoginUser): boolean {
  const settings = (user.organization.settings ?? {}) as { enforceMfa?: boolean };
  return (
    user.mfaEnabled ||
    user.organization.type === 'internal' ||
    user.roles.some((r) => r.role.isInternal) ||
    settings.enforceMfa === true
  );
}

const refreshCookie = (req: Request): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

export function authRouter(deps: Deps): Router {
  const { prisma, env, mailer } = deps;
  const r = Router();
  const authLimit = rateLimiter(deps.rateLimits.windowMs, deps.rateLimits.authPerWindow);
  const publicLimit = rateLimiter(deps.rateLimits.windowMs, deps.rateLimits.publicPerWindow);

  async function completeLogin(req: Request, res: Response, userId: string) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      include: { organization: true },
    });
    const { accessToken } = await issueSession(deps, req, res, {
      id: user.id,
      orgType: user.organization.type,
    });
    await req.audit({
      action: 'auth.login.success',
      entity: 'User',
      entityId: user.id,
      actorId: user.id,
      organizationId: user.organizationId,
    });
    return { accessToken, mustResetPassword: user.mustResetPassword };
  }

  async function recordFailure(req: Request, userId: string, organizationId: string, reason: string) {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
    });
    await req.audit({
      action: 'auth.login.failed',
      entity: 'User',
      entityId: userId,
      actorId: userId,
      organizationId,
      metadata: { reason },
    });
    if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      await prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLoginCount: 0 },
      });
      await req.audit({
        action: 'auth.lockout',
        entity: 'User',
        entityId: userId,
        actorId: userId,
        organizationId,
      });
    }
  }

  function assertNotLocked(user: { lockedUntil: Date | null }) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpError(423, 'account_locked', 'Too many failed attempts. Try again in 15 minutes.');
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────
  r.post('/auth/login', authLimit, async (req, res) => {
    const body = parse(z.object({ email: Email, password: z.string().min(1).max(128) }), req.body);
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { organization: true, roles: { include: { role: true } } },
    });
    if (!user) {
      await burnPasswordCheck(body.password);
      throw invalidCredentials();
    }
    assertNotLocked(user);
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      await recordFailure(req, user.id, user.organizationId, 'password');
      throw invalidCredentials();
    }
    if (user.status !== 'active' || user.organization.status !== 'active') {
      throw forbidden('This account is suspended');
    }
    if (!user.emailVerifiedAt) {
      throw new HttpError(403, 'email_not_verified', 'Verify your email address first');
    }

    if (mfaRequired(user)) {
      const setup = !user.mfaEnabled;
      const mfaToken = signMfaToken({ sub: user.id, setup }, env.JWT_REFRESH_SECRET);
      res.json(setup ? { mfaSetupRequired: true, mfaToken } : { mfaRequired: true, mfaToken });
      return;
    }
    res.json(await completeLogin(req, res, user.id));
  });

  /** MFA subject: an mfaToken from /auth/login, or a signed-in user enrolling voluntarily. */
  async function mfaSubject(
    req: Request,
  ): Promise<{ userId: string; viaLogin: boolean; setup: boolean }> {
    const token = (req.body as { mfaToken?: unknown } | undefined)?.mfaToken;
    if (typeof token === 'string') {
      const claims = verifyToken<MfaClaims>(token, env.JWT_REFRESH_SECRET, 'mfa');
      if (!claims) throw unauthorized('invalid_token', 'MFA step expired, sign in again');
      return { userId: claims.sub, viaLogin: true, setup: claims.setup };
    }
    const ctx = await resolveAuth(deps, req);
    req.auth = ctx;
    return { userId: ctx.user.id, viaLogin: false, setup: true };
  }

  r.post('/auth/mfa/setup', authLimit, async (req, res) => {
    const subject = await mfaSubject(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: subject.userId } });
    if (user.mfaEnabled) throw conflict('mfa_already_enabled', 'MFA is already enabled');
    if (!subject.setup) throw badRequest('mfa_setup_not_allowed', 'MFA setup is not pending');
    const secret = newTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaSecret: encrypt(secret, deps.phiKey) },
    });
    const otpauthUrl = totpUri(user.email, secret);
    res.json({ otpauthUrl, qrDataUrl: await totpQrDataUrl(otpauthUrl), secret });
  });

  r.post('/auth/mfa/verify', authLimit, async (req, res) => {
    const subject = await mfaSubject(req);
    const { code } = parse(
      z.object({ code: z.string().regex(/^\d{6}$/), mfaToken: z.string().optional() }),
      req.body,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: subject.userId } });
    assertNotLocked(user);
    if (!user.mfaSecret) throw badRequest('mfa_not_set_up', 'Set up MFA first');
    if (!verifyTotp(code, decrypt(user.mfaSecret, deps.phiKey))) {
      await recordFailure(req, user.id, user.organizationId, 'mfa_code');
      throw unauthorized('invalid_mfa_code', 'That code is not valid');
    }
    if (!user.mfaEnabled) {
      await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
      await req.audit({
        action: 'auth.mfa.enabled',
        entity: 'User',
        entityId: user.id,
        actorId: user.id,
        organizationId: user.organizationId,
      });
    }
    if (subject.viaLogin) {
      res.json(await completeLogin(req, res, user.id));
    } else {
      res.json({ mfaEnabled: true });
    }
  });

  // ── Refresh (rotation with reuse detection) ───────────────────────────
  r.post('/auth/refresh', authLimit, requireCsrf(deps), async (req, res) => {
    const token = refreshCookie(req);
    if (!token) throw unauthorized('no_refresh_token', 'Not signed in');
    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: sha256(token) },
      include: { user: { include: { organization: true } } },
    });
    const now = new Date();
    if (!session) {
      clearRefreshCookie(deps, res);
      throw unauthorized('invalid_refresh_token', 'Not signed in');
    }
    if (session.revokedAt) {
      // A rotated token was presented again: assume theft and end the whole family.
      await prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
      await req.audit({
        action: 'auth.refresh.reuse_detected',
        entity: 'Session',
        entityId: session.id,
        actorId: session.userId,
        organizationId: session.user.organizationId,
      });
      clearRefreshCookie(deps, res);
      throw unauthorized('refresh_token_reused', 'Session ended for security, sign in again');
    }
    if (session.expiresAt < now || isIdle(session, now) || session.user.status !== 'active') {
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
      clearRefreshCookie(deps, res);
      throw unauthorized('session_expired', 'Session has ended, sign in again');
    }
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: now } });
    const { accessToken } = await issueSession(
      deps,
      req,
      res,
      { id: session.userId, orgType: session.user.organization.type },
      session.familyId,
    );
    res.json({ accessToken });
  });

  r.post('/auth/logout', requireCsrf(deps), async (req, res) => {
    const token = refreshCookie(req);
    if (token) {
      const session = await prisma.session.findUnique({
        where: { refreshTokenHash: sha256(token) },
      });
      if (session && !session.revokedAt) {
        await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        await req.audit({
          action: 'auth.logout',
          entity: 'Session',
          entityId: session.id,
          actorId: session.userId,
        });
      }
    }
    clearRefreshCookie(deps, res);
    res.status(204).end();
  });

  r.post('/auth/sessions/revoke-all', authenticate(deps), async (req, res) => {
    const auth = requireAuth(req);
    const result = await prisma.session.updateMany({
      where: { userId: auth.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await req.audit({
      action: 'auth.sessions.revoked_all',
      entity: 'User',
      entityId: auth.user.id,
      organizationId: auth.user.organizationId,
      metadata: { count: result.count },
    });
    clearRefreshCookie(deps, res);
    res.status(204).end();
  });

  r.get('/auth/me', authenticate(deps), async (req, res) => {
    const auth = requireAuth(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    res.json({
      user: { ...auth.user, mfaEnabled: user.mfaEnabled, mustResetPassword: user.mustResetPassword },
      roles: auth.roles,
      permissions: auth.permissions.map(permissionKey).sort(),
      impersonatorId: auth.impersonatorId ?? null,
    });
  });

  // ── Self-registration (§5.2): creates Organization + first client_admin ──
  r.post('/auth/register', publicLimit, async (req, res) => {
    const body = parse(
      z.object({
        organizationName: z.string().trim().min(2).max(200),
        name: z.string().trim().min(1).max(200),
        email: Email,
        password: PasswordSchema,
      }),
      req.body,
    );
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      // Same response either way, so the endpoint can't be used to discover accounts.
      await mailer.send({
        to: body.email,
        subject: 'Datascribe sign-up attempt',
        text: `Someone tried to register a Datascribe account with this email, but you already have one.\nSign in: ${env.APP_URL}/login\nForgot your password? ${env.APP_URL}/forgot-password`,
      });
      res.status(202).json({ status: 'check_email' });
      return;
    }
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_admin' } });
    const passwordHash = await hashPassword(body.password);
    const token = randomToken();
    const user = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: body.organizationName, type: 'client' },
      });
      const created = await tx.user.create({
        data: {
          organizationId: org.id,
          name: body.name,
          email: body.email,
          passwordHash,
          status: 'active',
          roles: { create: { roleId: role.id } },
        },
      });
      await tx.userToken.create({
        data: {
          userId: created.id,
          type: 'email_verify',
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
        },
      });
      return created;
    });
    await req.audit({
      action: 'auth.register',
      entity: 'Organization',
      entityId: user.organizationId,
      actorId: user.id,
      organizationId: user.organizationId,
    });
    await mailer.send({
      to: user.email,
      subject: 'Verify your Datascribe email',
      text: `Welcome to Datascribe. Confirm your email address:\n${env.APP_URL}/verify-email?token=${token}\nThis link expires in 24 hours.`,
    });
    res.status(202).json({ status: 'check_email' });
  });

  async function consumeToken(type: 'email_verify' | 'password_reset', token: string) {
    const row = await prisma.userToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) {
      throw badRequest('token_invalid', 'This link is invalid or has expired');
    }
    // Conditional update keeps the token single-use under concurrent requests.
    const claimed = await prisma.userToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw badRequest('token_invalid', 'This link is invalid or has expired');
    return row;
  }

  r.post('/auth/verify-email', publicLimit, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const row = await consumeToken('email_verify', token);
    const user = await prisma.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: new Date() },
    });
    await req.audit({
      action: 'auth.email.verified',
      entity: 'User',
      entityId: user.id,
      actorId: user.id,
      organizationId: user.organizationId,
    });
    res.json({ status: 'verified' });
  });

  // ── Forgot / reset password ────────────────────────────────────────────
  r.post('/auth/forgot', publicLimit, async (req, res) => {
    const { email } = parse(z.object({ email: Email }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'active') {
      const token = randomToken();
      await prisma.userToken.create({
        data: {
          userId: user.id,
          type: 'password_reset',
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      });
      await req.audit({
        action: 'auth.password.reset_requested',
        entity: 'User',
        entityId: user.id,
        actorId: user.id,
        organizationId: user.organizationId,
      });
      await mailer.send({
        to: user.email,
        subject: 'Reset your Datascribe password',
        text: `Reset your password:\n${env.APP_URL}/reset-password?token=${token}\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.`,
      });
    }
    res.status(202).json({ status: 'check_email' });
  });

  r.post('/auth/reset', publicLimit, async (req, res) => {
    const body = parse(
      z.object({ token: z.string().min(10).max(200), password: PasswordSchema }),
      req.body,
    );
    const row = await consumeToken('password_reset', body.token);
    const user = await prisma.user.update({
      where: { id: row.userId },
      data: {
        passwordHash: await hashPassword(body.password),
        failedLoginCount: 0,
        lockedUntil: null,
        mustResetPassword: false,
      },
    });
    await prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await req.audit({
      action: 'auth.password.reset',
      entity: 'User',
      entityId: user.id,
      actorId: user.id,
      organizationId: user.organizationId,
    });
    await mailer.send({
      to: user.email,
      subject: 'Your Datascribe password was changed',
      text: `Your password was just changed and all sessions were signed out. If this wasn't you, contact Datascribe support immediately.`,
    });
    res.json({ status: 'password_reset' });
  });

  return r;
}
