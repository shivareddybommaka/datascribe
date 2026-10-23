import { notifyInviteAccepted } from '@datascribe/db/notifications';
import { CLIENT_ROLES, broadestScope } from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { assertCanGrant, rolePermissions } from '../auth/grants';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import type { Deps } from '../context';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { safeNotify } from '../lib/notify';
import { PasswordSchema, hashPassword } from '../lib/password';
import { renderEmail } from '../lib/templates';
import { randomToken, sha256 } from '../lib/tokens';
import { parse } from '../lib/validate';
import { Email, rateLimiter } from './auth';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export interface InviteInput {
  organizationId: string;
  email: string;
  roleKey: string;
}

/**
 * Invite rules (§4.3 users row, §5.2):
 * - `users:create` at `all` may invite into any org; at `firm`, only into the inviter's own org.
 * - Client orgs get client roles only; the internal org gets internal roles only.
 * - Only super_admin may grant super_admin (ops_manager "cannot touch super_admin").
 * - The role may only carry permissions the inviter holds (audit M4; super_admin exempt).
 * Used by POST /invites and POST /admin/users.
 */
export async function createInvite(
  deps: Deps,
  req: Request,
  auth: AuthContext,
  input: InviteInput,
) {
  const { prisma } = deps;
  const scope = broadestScope(auth.permissions, 'users', 'create');
  if (!scope) throw forbidden();
  if (scope !== 'all' && input.organizationId !== auth.user.organizationId) throw notFound();

  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  if (!org) throw notFound();
  const role = await prisma.role.findUnique({ where: { key: input.roleKey } });
  if (!role) throw badRequest('unknown_role', 'Unknown role');

  const allowedForOrg = org.type === 'internal' ? role.isInternal : !role.isInternal;
  if (!allowedForOrg) throw forbidden('That role cannot be used in this organisation');
  if (auth.user.orgType === 'client' && !(CLIENT_ROLES as readonly string[]).includes(role.key)) {
    throw forbidden('Client admins can only assign client roles');
  }
  if (role.key === 'super_admin' && !auth.roles.includes('super_admin')) {
    throw forbidden('Only a super admin can grant super admin');
  }
  assertCanGrant(auth, await rolePermissions(prisma, role.id, org.type));
  if (org.status !== 'active') throw badRequest('org_inactive', 'This organisation is suspended');
  return issueInvite(deps, req, {
    org,
    role,
    email: input.email,
    inviter: { id: auth.user.id, name: auth.user.name },
  });
}

/**
 * Create the invite row, audit it and send the email. No permission checks: callers must have
 * authorised the action (createInvite above, or CRM lead conversion, which invites the first
 * client_admin of a firm it has just created).
 */
export async function issueInvite(
  deps: Deps,
  req: Request,
  args: {
    org: { id: string; name: string };
    role: { id: string; key: string };
    email: string;
    inviter: { id: string; name: string };
  },
) {
  const { prisma, mailer, env } = deps;
  if (await prisma.user.findUnique({ where: { email: args.email } })) {
    throw conflict('user_exists', 'A user with this email already exists');
  }
  const token = randomToken();
  const invite = await prisma.invite.create({
    data: {
      organizationId: args.org.id,
      email: args.email,
      roleId: args.role.id,
      tokenHash: sha256(token),
      invitedById: args.inviter.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  await req.audit({
    action: 'invite.create',
    entity: 'Invite',
    entityId: invite.id,
    organizationId: args.org.id,
    metadata: { roleKey: args.role.key },
  });
  await mailer.send({
    to: args.email,
    ...(await renderEmail(prisma, 'invite', {
      inviterName: args.inviter.name,
      organizationName: args.org.name,
      acceptUrl: `${env.APP_URL}/invite/accept?token=${token}`,
    })),
  });
  return {
    id: invite.id,
    email: invite.email,
    organizationId: args.org.id,
    roleKey: args.role.key,
    expiresAt: invite.expiresAt,
  };
}

export function invitesRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  const publicLimit = rateLimiter(deps.rateLimits.windowMs, deps.rateLimits.publicPerWindow);

  r.post('/invites', authenticate(deps), requirePermission('users', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z.object({
        organizationId: z.string().min(1),
        email: Email,
        // custom role keys are allowed too; existence is checked against the DB
        roleKey: z.string().min(1).max(64),
      }),
      req.body,
    );
    res.status(201).json(await createInvite(deps, req, auth, body));
  });

  r.post('/invites/:token/accept', publicLimit, async (req, res) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(200), password: PasswordSchema }),
      req.body,
    );
    const invite = await prisma.invite.findUnique({
      where: { tokenHash: sha256(String(req.params.token)) },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw badRequest('invite_invalid', 'This invite is invalid or has expired');
    }
    if (await prisma.user.findUnique({ where: { email: invite.email } })) {
      throw conflict('user_exists', 'A user with this email already exists');
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw badRequest('invite_invalid', 'This invite is invalid or has expired');
      return tx.user.create({
        data: {
          organizationId: invite.organizationId,
          email: invite.email,
          name: body.name,
          passwordHash,
          status: 'active',
          // the invite link proves control of the mailbox
          emailVerifiedAt: new Date(),
          roles: { create: { roleId: invite.roleId } },
        },
      });
    });
    await req.audit({
      action: 'invite.accepted',
      entity: 'Invite',
      entityId: invite.id,
      actorId: user.id,
      organizationId: invite.organizationId,
    });
    await safeNotify(deps.logger, 'invite_accepted', () =>
      notifyInviteAccepted(prisma, invite.id, user.id),
    );
    res.status(201).json({ userId: user.id, email: user.email });
  });

  return r;
}
