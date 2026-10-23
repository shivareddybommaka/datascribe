import type { Prisma } from '@datascribe/db';
import {
  ROLE_KEYS,
  broadestScope,
  parsePermissionKey,
  permissionKey,
  type Action,
  type PermissionDef,
} from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../auth/context';
import { assertCanGrant, assertValidRolePermissions, isSuperAdmin } from '../../auth/grants';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { requireInternal } from '../crm/common';

const roleInclude = {
  permissions: { select: { permission: { select: { module: true, action: true, scope: true } } } },
  _count: { select: { users: true } },
} satisfies Prisma.RoleInclude;

type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

const keysOf = (role: RoleRow): string[] =>
  role.permissions.map((rp) => permissionKey(rp.permission as PermissionDef)).sort();

function serializeRole(role: RoleRow) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    group: role.isInternal ? 'internal' : 'client',
    // super_admin is never edited: it must always hold everything (D-060)
    locked: role.key === 'super_admin',
    userCount: role._count.users,
    permissions: keysOf(role),
  };
}

const PermissionKeys = z
  .array(z.string().max(64))
  .max(1000)
  .transform((keys, ctx) => {
    const out = new Map<string, PermissionDef>();
    for (const k of keys) {
      const p = parsePermissionKey(k);
      if (!p) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown permission ${k}` });
        return z.NEVER;
      }
      out.set(permissionKey(p), p);
    }
    return [...out.values()];
  });

const Name = z.string().trim().min(2).max(80);
const Description = z.string().trim().max(300).nullable().optional();

/** Role changes are internal-only (roles are shared by every firm) and need `users:<action>` at `all`. */
function requireRoleAdmin(auth: AuthContext, action: Action) {
  if (
    auth.user.orgType !== 'internal' ||
    broadestScope(auth.permissions, 'users', action) !== 'all'
  ) {
    throw forbidden();
  }
}

/** Upsert Permission rows (normally all seeded) and return their ids. */
async function permissionIds(deps: Deps, perms: PermissionDef[]): Promise<string[]> {
  if (!perms.length) return [];
  await deps.prisma.permission.createMany({ data: perms, skipDuplicates: true });
  const rows = await deps.prisma.permission.findMany({
    where: { OR: perms.map((p) => ({ module: p.module, action: p.action, scope: p.scope })) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

const slug = (name: string) =>
  `custom_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)}`;

/**
 * §5.7 Roles (D-060): list, create custom roles, edit their permission matrix, delete unused
 * custom roles. Permissions are loaded from the DB on every request (auth/context.ts), so an edit
 * takes effect on the holder's next request without a restart (M2 DoD).
 */
export function rolesRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/roles', authenticate(deps));

  r.get('/roles', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    // client admins only ever assign client roles, so that's all they see
    const roles = await prisma.role.findMany({
      where: auth.user.orgType === 'client' ? { isInternal: false } : {},
      include: roleInclude,
      orderBy: [{ isSystem: 'desc' }, { isInternal: 'desc' }, { name: 'asc' }],
    });
    res.json({ items: roles.map(serializeRole) });
  });

  r.get('/roles/:id', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const role = await prisma.role.findUnique({
      where: { id: String(req.params.id) },
      include: roleInclude,
    });
    if (!role || (auth.user.orgType === 'client' && role.isInternal)) throw notFound();
    const invitesPending = await prisma.invite.count({
      where: { roleId: role.id, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    res.json({ ...serializeRole(role), invitesPending });
  });

  r.post('/roles', requireInternal, requirePermission('users', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    requireRoleAdmin(auth, 'create');
    const body = parse(
      z.object({
        name: Name,
        key: z
          .string()
          .regex(/^[a-z][a-z0-9_]{2,47}$/, 'lowercase letters, digits and _ (3–48)')
          .optional(),
        description: Description,
        group: z.enum(['internal', 'client']),
        permissions: PermissionKeys,
      }),
      req.body,
    );
    const key = body.key ?? slug(body.name);
    if ((ROLE_KEYS as readonly string[]).includes(key)) {
      throw conflict('role_exists', 'That key belongs to a built-in role');
    }
    const isInternal = body.group === 'internal';
    assertValidRolePermissions(body.permissions, isInternal);
    assertCanGrant(auth, body.permissions);
    if (await prisma.role.findUnique({ where: { key } })) {
      throw conflict('role_exists', 'A role with this key already exists');
    }
    const ids = await permissionIds(deps, body.permissions);
    const role = await prisma.role.create({
      data: {
        key,
        name: body.name,
        description: body.description ?? null,
        isSystem: false,
        isInternal,
        permissions: { create: ids.map((permissionId) => ({ permissionId })) },
      },
      include: roleInclude,
    });
    await req.audit({
      action: 'admin.role.created',
      entity: 'Role',
      entityId: role.id,
      metadata: { key, group: body.group, permissions: keysOf(role) },
    });
    res.status(201).json(serializeRole(role));
  });

  r.patch('/roles/:id', requireInternal, requirePermission('users', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    requireRoleAdmin(auth, 'edit');
    const body = parse(
      z
        .object({ name: Name, description: Description, permissions: PermissionKeys })
        .partial()
        .refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
      req.body,
    );
    const role = await prisma.role.findUnique({
      where: { id: String(req.params.id) },
      include: roleInclude,
    });
    if (!role) throw notFound();
    if (role.key === 'super_admin') {
      throw badRequest('role_locked', 'The Super Admin role always holds every permission');
    }
    if (role.isSystem && !isSuperAdmin(auth)) {
      throw forbidden('Only a super admin can change a built-in role');
    }

    const before = keysOf(role);
    let added: string[] = [];
    let removed: string[] = [];
    if (body.permissions) {
      assertValidRolePermissions(body.permissions, role.isInternal);
      // Non-super admins may only edit roles entirely within their own grants (audit M4).
      const current = role.permissions.map((rp) => rp.permission as PermissionDef);
      assertCanGrant(auth, [...current, ...body.permissions]);
      const after = body.permissions.map(permissionKey);
      added = after.filter((k) => !before.includes(k)).sort();
      removed = before.filter((k) => !after.includes(k));
      const ids = await permissionIds(deps, body.permissions);
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        prisma.rolePermission.createMany({
          data: ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        }),
      ]);
    }
    const updated = await prisma.role.update({
      where: { id: role.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      include: roleInclude,
    });
    await req.audit({
      action: 'admin.role.updated',
      entity: 'Role',
      entityId: role.id,
      metadata: {
        key: role.key,
        fields: Object.keys(body).sort(),
        ...(body.permissions ? { added, removed } : {}),
      },
    });
    res.json(serializeRole(updated));
  });

  r.delete(
    '/roles/:id',
    requireInternal,
    requirePermission('users', 'delete'),
    async (req, res) => {
      const auth = requireAuth(req);
      requireRoleAdmin(auth, 'delete');
      const role = await prisma.role.findUnique({
        where: { id: String(req.params.id) },
        include: roleInclude,
      });
      if (!role) throw notFound();
      if (role.isSystem) throw badRequest('system_role', 'Built-in roles cannot be deleted');
      const invites = await prisma.invite.count({
        where: { roleId: role.id, acceptedAt: null, expiresAt: { gt: new Date() } },
      });
      if (role._count.users > 0 || invites > 0) {
        throw conflict(
          'role_in_use',
          'Remove this role from its users (and let pending invites expire) first',
        );
      }
      assertCanGrant(
        auth,
        role.permissions.map((rp) => rp.permission as PermissionDef),
      );
      await prisma.$transaction([
        // accepted/expired invite rows would block the FK; the audit log keeps their history
        prisma.invite.deleteMany({ where: { roleId: role.id } }),
        prisma.role.delete({ where: { id: role.id } }),
      ]);
      await req.audit({
        action: 'admin.role.deleted',
        entity: 'Role',
        entityId: role.id,
        metadata: { key: role.key, permissions: keysOf(role) },
      });
      res.status(204).end();
    },
  );

  return r;
}
