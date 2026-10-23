import type { PrismaClient } from '@datascribe/db';
import {
  CLIENT_MODULES,
  RESERVED_MODULES,
  holdsPermission,
  permissionKey,
  type PermissionDef,
} from '@datascribe/shared';
import { badRequest, forbidden } from '../lib/errors';
import type { AuthContext } from './context';
import { effectivePermissions } from './context';

export const isSuperAdmin = (auth: AuthContext) => auth.roles.includes('super_admin');

/**
 * Audit M4: a role, invite or role assignment may only hand out permissions the actor holds
 * (same module and action, same or broader scope). super_admin is exempt.
 */
export function assertCanGrant(auth: AuthContext, wanted: PermissionDef[]) {
  if (isSuperAdmin(auth)) return;
  const missing = wanted.filter((p) => !holdsPermission(auth.permissions, p));
  if (missing.length) {
    throw forbidden(
      `You can only grant permissions you hold yourself (missing: ${missing
        .slice(0, 5)
        .map(permissionKey)
        .join(', ')}${missing.length > 5 ? ', …' : ''})`,
    );
  }
}

/**
 * Shape rules for a custom role's permission set (D-060):
 * - client roles never get `all` scope and only use client-facing modules;
 * - system_settings stays with the built-in super_admin role.
 */
export function assertValidRolePermissions(perms: PermissionDef[], isInternal: boolean) {
  const reserved = perms.filter((p) => RESERVED_MODULES.includes(p.module));
  if (reserved.length) {
    throw badRequest('reserved_permission', 'System settings can only be held by Super Admin');
  }
  if (isInternal) return;
  const bad = perms.filter((p) => p.scope === 'all' || !CLIENT_MODULES.includes(p.module));
  if (bad.length) {
    throw badRequest(
      'client_role_scope',
      'Client roles can only use client modules, and never at "all" scope',
      { permissions: bad.map(permissionKey) },
    );
  }
}

/** A role's grants as they would apply to a member of an org of the given type. */
export async function rolePermissions(
  prisma: PrismaClient,
  roleId: string,
  orgType: 'client' | 'internal',
): Promise<PermissionDef[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permission: { select: { module: true, action: true, scope: true } } },
  });
  return effectivePermissions(
    rows.map((r) => r.permission),
    orgType,
  );
}
