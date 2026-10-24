import { notifyPasswordChanged } from '@datascribe/db/notifications';
import { decrypt, encrypt, permissionKey } from '@datascribe/shared';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireAuth, requireCsrf, resolveAuth } from '../auth/middleware';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  isIdle,
  isReuseSignal,
  issueSession,
  revoked,
} from '../auth/session';
import { DEFAULT_RATE_LIMITS, type Deps } from '../context';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { safeNotify } from '../lib/notify';
import { PasswordSchema, burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password';
import { renderEmail } from '../lib/templates';
import { randomToken, sha256, signMfaToken, verifyToken, type MfaClaims } from '../lib/tokens';
import { newTotpSecret, totpQrDataUrl, totpUri, verifyTotp } from '../lib/totp';
import { withTimingFloor } from '../lib/timing';
import { parse } from '../lib/validate';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

export const Email = z.string().trim().toLowerCase().email().max(254);

const invalidCredentials = () =>
  unauthorized('invalid_credentials', 'Email or password is incorrect');

export function rateLimiter(
  deps: Pick<Deps, 'rateLimitStore'>,
  /** names the counter in the shared store; each limiter counts on its own (D-111) */
  name: string,
  windowMs: number,
  limit: number,
  /** key requests by something other than the client IP; requests without a key are not counted */
  keyOf?: (req: Request) => string | undefined,
) {
  return rateLimit({
    windowMs,
    limit,
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore(name) } : {}),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyOf
      ? { keyGenerator: (req: Request) => keyOf(req) ?? '', skip: (req: Request) => !keyOf(req) }
      : {}),
    handler: (_req, res) => {
      res
        .status(429)
        .json({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
    },
  });
}

/** The account a request targets, hashed (limiter keys never hold an email address). */
const accountKey = (prefix: string, value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? `${prefix}:${sha256(value.trim().toLowerCase())}`
    : undefined;

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
  const authLimit = rateLimiter(
    deps,
    'auth',
    deps.rateLimits.windowMs,
    deps.rateLimits.authPerWindow,
  );
  const publicLimit = rateLimiter(
    deps,
    'auth-public',
    deps.rateLimits.windowMs,
    deps.rateLimits.publicPerWindow,
  );
  // Per target account, so spreading guesses or reset mails over many IPs doesn't help (audit M6).
  // Email for login/forgot/register, the MFA step's user for the TOTP step.
  const accountLimit = rateLimiter(
    deps,
    'account',
    deps.rateLimits.windowMs,
    deps.rateLimits.accountPerWindow ?? DEFAULT_RATE_LIMITS.accountPerWindow,
    (req) => {
      const body = (req.body ?? {}) as { email?: unknown; mfaToken?: unknown };
      if (body.email !== undefined) return accountKey('email', body.email);
      if (typeof body.mfaToken !== 'string') return undefined;
      const claims = verifyToken<MfaClaims>(body.mfaToken, env.JWT_REFRESH_SECRET, 'mfa');
      return claims ? accountKey('user', claims.sub) : undefined;
    },
  );

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

  const accountLocked = () =>
    new HttpError(423, 'account_locked', 'Too many failed attempts. Try again in 15 minutes.');

  /**
   * Take one of the MAX_FAILED_LOGINS attempts atomically, before the password or code is checked
   * (audit M2: concurrent guesses could all pass a read-then-check). The attempt that reaches the
   * limit sets the lock in the same statement, so later guesses get 423 without being verified.
   * An expired lock starts a fresh count. Returns this attempt's number (1..MAX).
   */
  async function reserveAttempt(userId: string): Promise<number> {
    const lockSeconds = LOCKOUT_MS / 1000;
    const rows = await prisma.$queryRaw<{ failedLoginCount: number }[]>`
      UPDATE "User" SET
        "failedLoginCount" = CASE WHEN "lockedUntil" <= now() THEN 1 ELSE "failedLoginCount" + 1 END,
        "lockedUntil" = CASE
          WHEN (CASE WHEN "lockedUntil" <= now() THEN 1 ELSE "failedLoginCount" + 1 END) >= ${MAX_FAILED_LOGINS}
          THEN now() + make_interval(secs => ${lockSeconds})
          ELSE NULL END,
        "updatedAt" = now()
      WHERE id = ${userId}
        AND ("lockedUntil" <= now() OR ("lockedUntil" IS NULL AND "failedLoginCount" < ${MAX_FAILED_LOGINS}))
      RETURNING "failedLoginCount"`;
    if (!rows[0]) throw accountLocked();
    return rows[0].failedLoginCount;
  }

  /** The secret was right: give the attempt back (and lift the lock this attempt set, if any). */
  async function releaseAttempt(userId: string, attempt: number) {
    await prisma.$executeRaw`
      UPDATE "User" SET
        "failedLoginCount" = GREATEST("failedLoginCount" - 1, 0),
        "lockedUntil" = CASE WHEN ${attempt} >= ${MAX_FAILED_LOGINS} THEN NULL ELSE "lockedUntil" END,
        "updatedAt" = now()
      WHERE id = ${userId}`;
  }

  /** The secret was wrong: the reserved attempt stays used; audit, and audit the lockout. */
  async function recordFailure(
    req: Request,
    user: { id: string; organizationId: string },
    attempt: number,
    reason: string,
  ) {
    const base = {
      entity: 'User',
      entityId: user.id,
      actorId: user.id,
      organizationId: user.organizationId,
    };
    await req.audit({ ...base, action: 'auth.login.failed', metadata: { reason } });
    if (attempt >= MAX_FAILED_LOGINS) await req.audit({ ...base, action: 'auth.lockout' });
  }

  // ── Login ──────────────────────────────────────────────────────────────
  const floor = env.AUTH_RESPONSE_FLOOR_MS;

  r.post(
    '/auth/login',
    authLimit,
    accountLimit,
    withTimingFloor(floor, async (req, res) => {
      const body = parse(
        z.object({ email: Email, password: z.string().min(1).max(128) }),
        req.body,
      );
      const user = await prisma.user.findUnique({
        where: { email: body.email },
        include: { organization: true, roles: { include: { role: true } } },
      });
      if (!user) {
        await burnPasswordCheck(body.password);
        throw invalidCredentials();
      }
      const attempt = await reserveAttempt(user.id);
      if (!(await verifyPassword(user.passwordHash, body.password))) {
        await recordFailure(req, user, attempt, 'password');
        throw invalidCredentials();
      }
      await releaseAttempt(user.id, attempt);
      if (user.status !== 'active' || user.organization.status !== 'active') {
        throw forbidden('This account is suspended');
      }
      if (!user.emailVerifiedAt) {
        throw new HttpError(403, 'email_not_verified', 'Verify your email address first');
      }
      // set by an admin (M2): no session until the emailed reset link is used
      if (user.mustResetPassword) {
        throw new HttpError(
          403,
          'password_reset_required',
          'Set a new password using the link we emailed you, or use "Forgot password"',
        );
      }

      if (mfaRequired(user)) {
        const setup = !user.mfaEnabled;
        const mfaToken = signMfaToken(
          { sub: user.id, setup, at: Date.now() },
          env.JWT_REFRESH_SECRET,
        );
        res.json(setup ? { mfaSetupRequired: true, mfaToken } : { mfaRequired: true, mfaToken });
        return;
      }
      res.json(await completeLogin(req, res, user.id));
    }),
  );

  const mfaStepExpired = () => unauthorized('invalid_token', 'MFA step expired, sign in again');

  /** MFA subject: an mfaToken from /auth/login, or a signed-in user enrolling voluntarily. */
  async function mfaSubject(
    req: Request,
  ): Promise<{ userId: string; viaLogin: boolean; setup: boolean; issuedAt: Date }> {
    const token = (req.body as { mfaToken?: unknown } | undefined)?.mfaToken;
    if (typeof token === 'string') {
      const claims = verifyToken<MfaClaims>(token, env.JWT_REFRESH_SECRET, 'mfa');
      if (!claims || typeof claims.at !== 'number') throw mfaStepExpired();
      return {
        userId: claims.sub,
        viaLogin: true,
        setup: claims.setup,
        issuedAt: new Date(claims.at),
      };
    }
    const ctx = await resolveAuth(deps, req);
    req.auth = ctx;
    return { userId: ctx.user.id, viaLogin: false, setup: true, issuedAt: new Date() };
  }

  /**
   * Spend an MFA step token (audit L8): only the first sign-in completed after it was issued wins.
   * Atomic, so a replayed token, or two verifies racing with one token, get one session at most.
   */
  async function claimMfaStep(userId: string, issuedAt: Date) {
    const claimed = await prisma.user.updateMany({
      where: { id: userId, OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: issuedAt } }] },
      data: { lastLoginAt: new Date() },
    });
    if (claimed.count !== 1) throw mfaStepExpired();
  }

  r.post('/auth/mfa/setup', authLimit, accountLimit, async (req, res) => {
    const subject = await mfaSubject(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: subject.userId } });
    if (subject.viaLogin && user.lastLoginAt && user.lastLoginAt >= subject.issuedAt) {
      throw mfaStepExpired();
    }
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

  r.post('/auth/mfa/verify', authLimit, accountLimit, async (req, res) => {
    const subject = await mfaSubject(req);
    const { code } = parse(
      z.object({ code: z.string().regex(/^\d{6}$/), mfaToken: z.string().optional() }),
      req.body,
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: subject.userId } });
    if (subject.viaLogin && user.lastLoginAt && user.lastLoginAt >= subject.issuedAt) {
      throw mfaStepExpired();
    }
    if (!user.mfaSecret) throw badRequest('mfa_not_set_up', 'Set up MFA first');
    const attempt = await reserveAttempt(user.id);
    if (!verifyTotp(code, decrypt(user.mfaSecret, deps.phiKey))) {
      await recordFailure(req, user, attempt, 'mfa_code');
      throw unauthorized('invalid_mfa_code', 'That code is not valid');
    }
    await releaseAttempt(user.id, attempt);
    if (subject.viaLogin) await claimMfaStep(user.id, subject.issuedAt);
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
      include: {
        user: { include: { organization: true, roles: { include: { role: true } } } },
      },
    });
    const now = new Date();
    if (!session) {
      clearRefreshCookie(deps, res);
      throw unauthorized('invalid_refresh_token', 'Not signed in');
    }
    // A rotated token was presented again: assume theft and end the whole family.
    const reuseDetected = async () => {
      await prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: revoked('reuse', now),
      });
      await req.audit({
        action: 'auth.refresh.reuse_detected',
        entity: 'Session',
        entityId: session.id,
        actorId: session.userId,
        organizationId: session.user.organizationId,
      });
      clearRefreshCookie(deps, res);
      return unauthorized('refresh_token_reused', 'Session ended for security, sign in again');
    };
    if (session.revokedAt) {
      // Only a rotated (or already-flagged) token is a theft signal. One ended by logout, idle,
      // expiry, password reset or revoke-all is just over: no alert, other devices untouched (L1).
      if (isReuseSignal(session.revokedReason)) throw await reuseDetected();
      clearRefreshCookie(deps, res);
      throw unauthorized('session_revoked', 'Session has ended, sign in again');
    }
    const idle = isIdle(session, now);
    if (
      session.expiresAt < now ||
      idle ||
      session.user.status !== 'active' ||
      session.user.organization.status !== 'active'
    ) {
      await prisma.session.update({
        where: { id: session.id },
        data: revoked(idle ? 'idle' : 'expired', now),
      });
      clearRefreshCookie(deps, res);
      throw unauthorized('session_expired', 'Session has ended, sign in again');
    }
    // MFA policy may have changed since sign-in (internal role granted, org enforces MFA): a user
    // who now needs MFA but hasn't enrolled must sign in again and enrol (audit M5).
    if (mfaRequired(session.user) && !session.user.mfaEnabled) {
      await prisma.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: revoked('mfa_required', now),
      });
      await req.audit({
        action: 'auth.refresh.mfa_required',
        entity: 'Session',
        entityId: session.id,
        actorId: session.userId,
        organizationId: session.user.organizationId,
      });
      clearRefreshCookie(deps, res);
      throw unauthorized('mfa_required', 'Your organization now requires MFA, sign in again');
    }
    // Claim the token atomically: of two concurrent refreshes with the same token, only one wins;
    // the loser is treated as reuse (audit finding M1).
    const claimed = await prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: revoked('rotated', now),
    });
    if (claimed.count !== 1) throw await reuseDetected();
    const { accessToken } = await issueSession(
      deps,
      req,
      res,
      { id: session.userId, orgType: session.user.organization.type },
      { id: session.familyId, expiresAt: session.expiresAt },
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
        await prisma.session.update({ where: { id: session.id }, data: revoked('logout') });
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
      data: revoked('revoke_all'),
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
    // banner data (§4.4): who is viewing, as which firm, until when
    const impersonation = auth.impersonatorId
      ? {
          by: await prisma.user.findUniqueOrThrow({
            where: { id: auth.impersonatorId },
            select: { id: true, name: true, email: true },
          }),
          organization: await prisma.organization.findUniqueOrThrow({
            where: { id: auth.user.organizationId },
            select: { id: true, name: true },
          }),
          expiresAt: (await prisma.session.findUniqueOrThrow({ where: { id: auth.sessionId } }))
            .expiresAt,
        }
      : null;
    res.json({
      user: {
        ...auth.user,
        mfaEnabled: user.mfaEnabled,
        mustResetPassword: user.mustResetPassword,
      },
      roles: auth.roles,
      permissions: auth.permissions.map(permissionKey).sort(),
      impersonatorId: auth.impersonatorId ?? null,
      impersonation,
    });
  });

  const alreadyRegistered = (to: string) =>
    mailer.send({
      to,
      subject: 'Datascribe sign-up attempt',
      text: `Someone tried to register a Datascribe account with this email, but you already have one.\nSign in: ${env.APP_URL}/login\nForgot your password? ${env.APP_URL}/forgot-password`,
    });

  // ── Self-registration (§5.2): creates Organization + first client_admin ──
  r.post(
    '/auth/register',
    // Staging is on the open internet: no new firms unless switched on (D-125). Invites and the
    // seeded accounts are unaffected.
    (_req, _res, next) => {
      if (env.DEPLOY_ENV === 'staging' && !env.STAGING_ALLOW_SIGNUP) {
        throw new HttpError(403, 'signup_disabled', 'Sign-up is closed on staging');
      }
      next();
    },
    publicLimit,
    accountLimit,
    withTimingFloor(floor, async (req, res) => {
      const body = parse(
        z.object({
          organizationName: z.string().trim().min(2).max(200),
          name: z.string().trim().min(1).max(200),
          email: Email,
          password: PasswordSchema,
        }),
        req.body,
      );
      // hashed on every path, so the argon2 cost doesn't reveal whether the address is taken (L9)
      const passwordHash = await hashPassword(body.password);
      const existing = await prisma.user.findUnique({
        where: { email: body.email },
        include: { organization: { include: { _count: { select: { users: true } } } } },
      });
      // An unverified sign-up proves nothing about who owns the address. Someone registering it
      // again replaces that pending sign-up instead of being locked out (audit L3). Only the
      // latest link works, and it activates the password chosen with it.
      const pending =
        existing &&
        !existing.emailVerifiedAt &&
        existing.organization.type === 'client' &&
        existing.organization._count.users === 1;
      if (existing && !pending) {
        // Same response either way, so the endpoint can't be used to discover accounts.
        await alreadyRegistered(body.email);
        res.status(202).json({ status: 'check_email' });
        return;
      }
      const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_admin' } });
      const token = randomToken();
      const user = await prisma.$transaction(async (tx) => {
        if (existing) {
          // Tokens first, then the user, the same lock order as /auth/verify-email: a verification
          // that lands first makes the conditional update below match nothing.
          await tx.userToken.updateMany({
            where: { userId: existing.id, type: 'email_verify', usedAt: null },
            data: { usedAt: new Date() },
          });
          const replaced = await tx.user.updateMany({
            where: { id: existing.id, emailVerifiedAt: null },
            data: { name: body.name, passwordHash, failedLoginCount: 0, lockedUntil: null },
          });
          if (replaced.count !== 1) return null;
          await tx.organization.update({
            where: { id: existing.organizationId },
            data: { name: body.organizationName },
          });
          await tx.userToken.create({
            data: {
              userId: existing.id,
              type: 'email_verify',
              tokenHash: sha256(token),
              expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
            },
          });
          return existing;
        }
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
      if (!user) {
        // verified meanwhile: from now on it's an existing account
        await alreadyRegistered(body.email);
        res.status(202).json({ status: 'check_email' });
        return;
      }
      await req.audit({
        action: existing ? 'auth.register.replaced_unverified' : 'auth.register',
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
    }),
  );

  async function consumeToken(
    type: 'email_verify' | 'password_reset',
    token: string,
    db: Pick<typeof prisma, 'userToken'> = prisma,
  ) {
    const row = await db.userToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) {
      throw badRequest('token_invalid', 'This link is invalid or has expired');
    }
    // Conditional update keeps the token single-use under concurrent requests.
    const claimed = await db.userToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw badRequest('token_invalid', 'This link is invalid or has expired');
    return row;
  }

  r.post('/auth/verify-email', publicLimit, async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    // One transaction, token before user: a re-registration replacing this pending sign-up
    // (audit L3) either voids the token first or finds the user already verified.
    const user = await prisma.$transaction(async (tx) => {
      const row = await consumeToken('email_verify', token, tx);
      return tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
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
  r.post(
    '/auth/forgot',
    publicLimit,
    accountLimit,
    withTimingFloor(floor, async (req, res) => {
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
          ...(await renderEmail(prisma, 'password_reset', {
            name: user.name,
            resetUrl: `${env.APP_URL}/reset-password?token=${token}`,
          })),
        });
      }
      res.status(202).json({ status: 'check_email' });
    }),
  );

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
      data: revoked('password_reset'),
    });
    // Any other reset link still in an inbox would undo this reset (audit L2).
    await prisma.userToken.updateMany({
      where: { userId: user.id, type: 'password_reset', usedAt: null },
      data: { usedAt: new Date() },
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
    await safeNotify(deps.logger, 'password_changed', () => notifyPasswordChanged(prisma, user.id));
    res.json({ status: 'password_reset' });
  });

  return r;
}
