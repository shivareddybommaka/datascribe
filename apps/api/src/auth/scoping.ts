import type { Prisma } from '@datascribe/db';
import { can, type Action, type Module, type ScopedResource } from '@datascribe/shared';
import { forbidden } from '../lib/errors';
import type { AuthContext } from './context';

/**
 * Org scoping for everything that hangs off a Case (cases, documents, deliverables, events…).
 * Builds the Prisma WHERE from the union of the user's granted scopes for module+action.
 * Client-org users always get an extra hard organizationId filter (§4.4 rule 1).
 */
export function caseScopeWhere(
  auth: AuthContext,
  module: Module,
  action: Action,
): Prisma.CaseWhereInput {
  const scopes = new Set(
    auth.permissions.filter((p) => p.module === module && p.action === action).map((p) => p.scope),
  );
  if (scopes.size === 0) throw forbidden();

  const { id: userId, organizationId, orgType } = auth.user;
  const orgGuard: Prisma.CaseWhereInput = orgType === 'client' ? { organizationId } : {};
  if (scopes.has('all')) return orgGuard;

  const any: Prisma.CaseWhereInput[] = [];
  if (scopes.has('firm')) any.push({ organizationId });
  if (scopes.has('assigned')) {
    any.push({ caseManagerId: userId }, { summarizerId: userId }, { qaReviewerId: userId });
  }
  if (scopes.has('own')) {
    any.push({ createdById: userId }, { shares: { some: { userId } } });
  }
  return { AND: [orgGuard, { OR: any }] };
}

export interface CaseForScope {
  organizationId: string;
  createdById: string;
  caseManagerId: string | null;
  summarizerId: string | null;
  qaReviewerId: string | null;
  shares: { userId: string }[];
}

export function caseResource(c: CaseForScope): ScopedResource {
  return {
    organizationId: c.organizationId,
    ownerId: c.createdById,
    assigneeIds: [c.caseManagerId, c.summarizerId, c.qaReviewerId].filter(
      (id): id is string => !!id,
    ),
    sharedWithIds: c.shares.map((s) => s.userId),
  };
}

/** CASL check on a loaded case. Used as a second line of defence after the scoped query. */
export function canOnCase(
  auth: AuthContext,
  action: Action,
  module: Module,
  c: CaseForScope,
): boolean {
  if (auth.user.orgType === 'client' && c.organizationId !== auth.user.organizationId) return false;
  return can(auth.ability, action, module, caseResource(c));
}
