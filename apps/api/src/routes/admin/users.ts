import type { Prisma } from '@datascribe/db';
import { CLIENT_ROLES, broadestScope, type Action } from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../auth/context';
import { assertCanGrant, isSuperAdmin, rolePermissions } from '../../auth/grants';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import { revoked } from '../../auth/session';
import type { Deps } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { renderEmail } from '../../lib/templates';
import { randomToken, sha256 } from '../../lib/tokens';
import { parse } from '../../lib/validate';
import { Email, RESET_TTL_MS } from '../auth';
import { Pagination } from '../crm/common';
import { createInvite } from '../invites';

const userInclude = {
  organization: { select: { id: true, name: true, type: true, status: true } },
  roles: { select: { role: { select: { key: true, name: true } } } },
} satisfies Prisma.UserInclude;

type AdminUser = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Never returns password hashes, MFA secrets or lockout internals beyond what an admin needs. */
export function serializeAdminUser(u: AdminUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    organization: u.organization,
    roles: u.roles.map((r) => r.role),
    mfaEnabled: u.mfaEnabled,
    emailVerified: !!u.emailVerifiedAt,
    mustResetPassword: u.mustResetPassword,
    locked: !!u.lockedUntil && u.lockedUntil > new Date(),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

/**
 * Which users the caller may see for `users:<action>` (§4.3 users row).
 * `all` = every org (internal admins); `firm` = own org only (client_admin). Narrower scopes
 * grant nothing here. Client-org callers always get a hard organizationId filter (§4.4 rule 1).
 */
export function userScopeWhere(auth: AuthContext, action: Action): Prisma.UserWhereInput {
  const scope = broadestScope(auth.permissions, 'users', action);
  if (scope === 'all' && auth.user.orgType === 'internal') return {};
  if (scope === 'all' || scope === 'firm') return { organizationId: auth.user.organizationId };
  throw forbidden();
}

/**
 * Load a user the caller may change. Rules on top of scoping:
 * - not yourself (use your own account settings);
 * - only super_admin may change a super_admin ("cannot touch super_admin");
 * - client admins may only change holders of client roles.
 */
async function loadTarget(deps: Deps, auth: AuthContext, id: string, action: Action) {
  const user = await deps.prisma.user.findFirst({
    where: { AND: [{ id }, userScopeWhere(auth, action)] },
    include: userInclude,
  });
  if (!user) throw notFound();
  if (action === 'view') return user;
  if (user.id === auth.user.id) throw forbidden('You cannot do that to your own account');
  const keys = user.roles.map((r) => r.role.key);
  if (keys.includes('super_admin') && !auth.roles.includes('super_admin')) {
    throw forbidden('Only a super admin can change a super admin');
  }
  if (
    auth.user.orgType === 'client' &&
    keys.some((k) => !(CLIENT_ROLES as readonly string[]).includes(k))
  ) {
    throw forbidden('Client admins can only manage client users');
  }
  return user;
}

async function revokeSessions(deps: Deps, userId: string) {
  const { count } = await deps.prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: revoked('admin_action'),
  });
  return count;
}

/** §5.7 Users: list, view, create (= invite), roles, suspend, reactivate, reset MFA, force password reset. */
export function adminUsersRouter(deps: Deps): Router {
  const { prisma, mailer, env } = deps;
  const r = Router();
  r.use('/admin/users', authenticate(deps));

  r.get('/admin/users', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      Pagination.extend({
        q: z.string().trim().min(1).max(100).optional(),
        status: z.enum(['invited', 'active', 'suspended']).optional(),
        organizationId: z.string().min(1).max(64).optional(),
        role: z.string().min(1).max(64).optional(),
      }),
      req.query,
    );
    const where: Prisma.UserWhereInput = {
      AND: [
        userScopeWhere(auth, 'view'),
        q.status ? { status: q.status } : {},
        q.organizationId ? { organizationId: q.organizationId } : {},
        q.role ? { roles: { some: { role: { key: q.role } } } } : {},
        q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' } },
                { email: { contains: q.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        take: q.limit,
        skip: q.offset,
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ total, items: users.map(serializeAdminUser) });
  });

  // §5.7 "create user": admins never set someone else's password, so creating = inviting (D-022).
  r.post('/admin/users', requirePermission('users', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z.object({
        organizationId: z.string().min(1).max(64),
        email: Email,
        roleKey: z.string().min(1).max(64),
      }),
      req.body,
    );
    res.status(201).json(await createInvite(deps, req, auth, body));
  });

  /**
   * Replace a user's roles. Same target rules as the other actions, plus: each role must suit
   * the user's organisation type, client admins assign client roles only, only super_admin
   * grants super_admin, and every role's permissions must be held by the caller (audit M4).
   */
  r.put('/admin/users/:id/roles', requirePermission('users', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z.object({ roleKeys: z.array(z.string().min(1).max(64)).min(1).max(10) }),
      req.body,
    );
    const user = await loadTarget(deps, auth, String(req.params.id), 'edit');
    const keys = [...new Set(body.roleKeys)];
    const roles = await prisma.role.findMany({ where: { key: { in: keys } } });
    if (roles.length !== keys.length) throw badRequest('unknown_role', 'Unknown role');

    const orgType = user.organization.type;
    const before = user.roles.map((r) => r.role.key);
    for (const role of roles) {
      if (role.isInternal !== (orgType === 'internal')) {
        throw forbidden('That role cannot be used in this organisation');
      }
      if (before.includes(role.key)) continue; // keeping a role grants nothing new
      if (role.key === 'super_admin' && !isSuperAdmin(auth)) {
        throw forbidden('Only a super admin can grant super admin');
      }
      assertCanGrant(auth, await rolePermissions(prisma, role.id, orgType));
    }
    const after = roles.map((r) => r.key).sort();
    if (before.includes('super_admin') && !after.includes('super_admin')) {
      const others = await prisma.user.count({
        where: {
          id: { not: user.id },
          status: 'active',
          roles: { some: { role: { key: 'super_admin' } } },
        },
      });
      if (others === 0) throw badRequest('last_super_admin', 'Keep at least one super admin');
    }
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: user.id } }),
      prisma.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id })) }),
    ]);
    await req.audit({
      action: 'admin.user.roles_changed',
      entity: 'User',
      entityId: user.id,
      organizationId: user.organizationId,
      metadata: { before: [...before].sort(), after },
    });
    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: userInclude,
    });
    res.json(serializeAdminUser(fresh));
  });

  r.get('/admin/users/:id', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const user = await loadTarget(deps, auth, String(req.params.id), 'view');
    const invitesPending = await prisma.invite.count({
      where: { email: user.email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    res.json({ ...serializeAdminUser(user), invitesPending });
  });

  /** Shared shape of the state-changing actions: load with edit rights, act, audit, respond. */
  const action = (
    path: string,
    auditAction: string,
    run: (req: Request, user: AdminUser) => Promise<Record<string, unknown> | void>,
  ) =>
    r.post(`/admin/users/:id/${path}`, requirePermission('users', 'edit'), async (req, res) => {
      const auth = requireAuth(req);
      const user = await loadTarget(deps, auth, String(req.params.id), 'edit');
      const metadata = (await run(req, user)) ?? {};
      await req.audit({
        action: auditAction,
        entity: 'User',
        entityId: user.id,
        organizationId: user.organizationId,
        metadata,
      });
      const fresh = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: userInclude,
      });
      res.json(serializeAdminUser(fresh));
    });

  action('suspend', 'admin.user.suspended', async (_req, user) => {
    if (user.status === 'suspended') throw badRequest('already_suspended', 'User is suspended');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'suspended' } });
    return { sessionsRevoked: await revokeSessions(deps, user.id) };
  });

  action('reactivate', 'admin.user.reactivated', async (_req, user) => {
    if (user.status !== 'suspended') throw badRequest('not_suspended', 'User is not suspended');
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'active', failedLoginCount: 0, lockedUntil: null },
    });
  });

  // The user enrols again at next sign-in (mandatory for internal roles, §5.2).
  action('reset-mfa', 'admin.user.mfa_reset', async (_req, user) => {
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    const sessionsRevoked = await revokeSessions(deps, user.id);
    await mailer.send({
      to: user.email,
      ...(await renderEmail(prisma, 'mfa_reset', { name: user.name })),
    });
    return { sessionsRevoked };
  });

  // Sign-in is refused until the emailed link is used (auth.ts: password_reset_required).
  action('force-password-reset', 'admin.user.password_reset_forced', async (_req, user) => {
    const token = randomToken();
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { mustResetPassword: true } }),
      // only the newest link stays valid
      prisma.userToken.updateMany({
        where: { userId: user.id, type: 'password_reset', usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.userToken.create({
        data: {
          userId: user.id,
          type: 'password_reset',
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      }),
    ]);
    const sessionsRevoked = await revokeSessions(deps, user.id);
    await mailer.send({
      to: user.email,
      subject: 'Set a new Datascribe password',
      text: `An administrator asked you to set a new password. All sessions were signed out.\nSet a new password: ${env.APP_URL}/reset-password?token=${token}\nThis link expires in 1 hour. To get a new link later, use "Forgot password" on the sign-in page.`,
    });
    return { sessionsRevoked };
  });

  return r;
}
