import type { PrismaClient } from '@datascribe/db';
import {
  ACTIONS,
  MODULES,
  SCOPES,
  defineAbilityFor,
  permissionKey,
  type AppAbility,
  type PermissionDef,
} from '@datascribe/shared';

export interface AuthUser {
  id: string;
  organizationId: string;
  orgType: 'client' | 'internal';
  email: string;
  name: string;
}

export interface AuthContext {
  user: AuthUser;
  roles: string[];
  permissions: PermissionDef[];
  ability: AppAbility;
  sessionId: string;
  impersonatorId?: string;
}

const isKnown = (p: { module: string; action: string; scope: string }): p is PermissionDef =>
  (MODULES as readonly string[]).includes(p.module) &&
  (ACTIONS as readonly string[]).includes(p.action) &&
  (SCOPES as readonly string[]).includes(p.scope);

/**
 * Hard isolation (§4.4): a user in a client organisation can never hold an `all`-scope grant,
 * even if a custom role says so. Such grants are narrowed to `firm`.
 */
export function effectivePermissions(
  raw: { module: string; action: string; scope: string }[],
  orgType: 'client' | 'internal',
): PermissionDef[] {
  const seen = new Map<string, PermissionDef>();
  for (const p of raw.filter(isKnown)) {
    const eff: PermissionDef =
      orgType === 'client' && p.scope === 'all' ? { ...p, scope: 'firm' } : { ...p };
    seen.set(permissionKey(eff), eff);
  }
  return [...seen.values()];
}

/**
 * Loads roles and permissions from the DB on every request, so role edits take effect
 * without a restart. Returns null when the user is missing or not active.
 */
export async function loadAuthContext(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
  impersonatorId?: string,
): Promise<AuthContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      organization: true,
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  if (!user || user.status !== 'active' || user.organization.status !== 'active') return null;

  const orgType = user.organization.type;
  const permissions = effectivePermissions(
    user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission)),
    orgType,
  );
  const authUser: AuthUser = {
    id: user.id,
    organizationId: user.organizationId,
    orgType,
    email: user.email,
    name: user.name,
  };
  return {
    user: authUser,
    roles: user.roles.map((ur) => ur.role.key),
    permissions,
    ability: defineAbilityFor({ id: user.id, organizationId: user.organizationId }, permissions),
    sessionId,
    impersonatorId,
  };
}
