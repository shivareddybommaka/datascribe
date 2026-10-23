import { createMongoAbility, subject, type MongoAbility } from '@casl/ability';
import { SCOPES, type Action, type Module, type PermissionDef, type Scope } from './permissions';

/**
 * What every scoped check needs to know about a resource. The API maps each entity onto this
 * shape (e.g. a Case: ownerId = createdById, assigneeIds = [caseManager, summarizer, qaReviewer],
 * sharedWithIds = CaseShare users). Child entities (documents, deliverables) inherit their case's.
 */
export interface ScopedResource {
  organizationId?: string | null;
  ownerId?: string | null;
  assigneeIds?: string[];
  sharedWithIds?: string[];
}

export interface AbilityUser {
  id: string;
  organizationId: string;
}

export type AppAbility = MongoAbility<
  [Action, Module | (ScopedResource & { __caslSubjectType__: Module })]
>;

// 'manage' and 'all' are wildcards in CASL by default; ours are ordinary actions/modules.
const CASL_OPTIONS = { anyAction: '*', anySubjectType: '__any__' } as const;

function conditionsFor(scope: Scope, user: AbilityUser): Record<string, unknown>[] | null {
  switch (scope) {
    case 'all':
      return null;
    case 'firm':
      return [{ organizationId: user.organizationId }];
    case 'assigned':
      return [{ assigneeIds: user.id }];
    case 'own':
      // "own" covers records the user created and records shared with them (D-006).
      return [{ ownerId: user.id }, { sharedWithIds: user.id }];
  }
}

export function defineAbilityFor(user: AbilityUser, permissions: PermissionDef[]): AppAbility {
  const rules = permissions.flatMap(({ module, action, scope }) => {
    const conds = conditionsFor(scope, user);
    if (!conds) return [{ action, subject: module }];
    return conds.map((conditions) => ({ action, subject: module, conditions }));
  });
  return createMongoAbility(rules as never, CASL_OPTIONS) as AppAbility;
}

/** Check an action, optionally against a concrete resource (otherwise: "is any grant present"). */
export function can(
  ability: AppAbility,
  action: Action,
  module: Module,
  resource?: ScopedResource,
): boolean {
  if (!resource) return ability.can(action, module);
  return ability.can(action, subject(module, { ...resource }) as never);
}

/**
 * Broadest scope the permission set grants for module+action, or null if none.
 * Used to build list-query filters (e.g. firm -> WHERE organizationId = $1).
 */
export function broadestScope(
  permissions: PermissionDef[],
  module: Module,
  action: Action,
): Scope | null {
  const granted = new Set(
    permissions.filter((p) => p.module === module && p.action === action).map((p) => p.scope),
  );
  return SCOPES.find((s) => granted.has(s)) ?? null;
}
