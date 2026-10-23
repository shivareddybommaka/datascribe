/**
 * Permission catalogue and seed matrix (REQUIREMENTS.md §4).
 *
 * A permission is module + action + scope. These constants are the single source of truth:
 * they are seeded into the Permission / RolePermission tables, and the API builds CASL
 * abilities from whatever the DB holds at request time (so custom roles work without restart).
 */

export const MODULES = [
  'cms',
  'crm',
  'cases',
  'documents',
  'deliverables',
  'qa_reviews',
  'invoices',
  'payments',
  'subscriptions',
  'users',
  'dashboard_ops',
  'dashboard_sales',
  'dashboard_finance',
  'dashboard_client',
  'audit_log',
  'system_settings',
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] as const;
export type Action = (typeof ACTIONS)[number];

/** Broadest first. A grant at a broader scope implies every narrower scope. */
export const SCOPES = ['all', 'firm', 'assigned', 'own'] as const;
export type Scope = (typeof SCOPES)[number];

export interface PermissionDef {
  module: Module;
  action: Action;
  scope: Scope;
}

export const permissionKey = (p: PermissionDef): string => `${p.module}:${p.action}:${p.scope}`;

/** Every combination, so the admin checkbox matrix (M2) can offer all of them. */
export const ALL_PERMISSIONS: PermissionDef[] = MODULES.flatMap((module) =>
  ACTIONS.flatMap((action) => SCOPES.map((scope) => ({ module, action, scope }))),
);

/** "module:action:scope" → PermissionDef, or null for anything not in the catalogue. */
export function parsePermissionKey(key: string): PermissionDef | null {
  const [module, action, scope, ...rest] = key.split(':');
  if (
    rest.length ||
    !(MODULES as readonly string[]).includes(module ?? '') ||
    !(ACTIONS as readonly string[]).includes(action ?? '') ||
    !(SCOPES as readonly string[]).includes(scope ?? '')
  ) {
    return null;
  }
  return { module, action, scope } as PermissionDef;
}

/**
 * Modules a client-organisation role may use (D-060). Everything else (CRM, CMS, QA, staff
 * dashboards, audit log, system settings) is Datascribe-internal.
 */
export const CLIENT_MODULES: readonly Module[] = [
  'cases',
  'documents',
  'deliverables',
  'invoices',
  'payments',
  'subscriptions',
  'users',
  'dashboard_client',
];

/** Only the built-in super_admin role holds these; custom roles can't (D-060). */
export const RESERVED_MODULES: readonly Module[] = ['system_settings'];

/**
 * Does `held` cover `wanted`? Same module and action, at the same or a broader scope
 * (SCOPES is ordered broadest first). Used for "you can only grant what you hold" (audit M4).
 */
export function holdsPermission(held: readonly PermissionDef[], wanted: PermissionDef): boolean {
  const need = SCOPES.indexOf(wanted.scope);
  return held.some(
    (p) =>
      p.module === wanted.module && p.action === wanted.action && SCOPES.indexOf(p.scope) <= need,
  );
}

export const ROLE_KEYS = [
  'super_admin',
  'ops_manager',
  'case_manager',
  'summarizer',
  'qa_reviewer',
  'sales',
  'finance',
  'client_admin',
  'client_user',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const INTERNAL_ROLES: readonly RoleKey[] = [
  'super_admin',
  'ops_manager',
  'case_manager',
  'summarizer',
  'qa_reviewer',
  'sales',
  'finance',
];
export const CLIENT_ROLES: readonly RoleKey[] = ['client_admin', 'client_user'];

export const ROLE_META: Record<
  RoleKey,
  { name: string; group: 'internal' | 'client'; description: string }
> = {
  super_admin: {
    name: 'Super Admin',
    group: 'internal',
    description: 'Full access including roles, system settings, audit log',
  },
  ops_manager: {
    name: 'Operations Manager',
    group: 'internal',
    description: 'Users, clients, case assignment, SLAs',
  },
  case_manager: {
    name: 'Case Manager',
    group: 'internal',
    description: 'Owns cases end to end, assigns work, client contact',
  },
  summarizer: {
    name: 'Medical Summarizer',
    group: 'internal',
    description: 'Works assigned cases, edits AI output',
  },
  qa_reviewer: {
    name: 'QA Reviewer',
    group: 'internal',
    description: 'Approves or rejects deliverables',
  },
  sales: {
    name: 'Sales / CRM User',
    group: 'internal',
    description: 'Leads, accounts, pipeline. NO medical records',
  },
  finance: {
    name: 'Finance',
    group: 'internal',
    description: 'Invoices, payments, subscriptions. NO medical records',
  },
  client_admin: {
    name: 'Client Admin',
    group: 'client',
    description: "Manages own firm's users, billing, subscription; sees all firm cases",
  },
  client_user: {
    name: 'Client User',
    group: 'client',
    description: 'Creates cases, uploads, downloads for own or shared cases',
  },
};

// Matrix legend from §4.3
const F: Action[] = ['view', 'create', 'edit', 'delete'];
const E: Action[] = ['view', 'create', 'edit'];
const V: Action[] = ['view'];

type Grant = [Module, Action[], Scope];

const grants = (list: Grant[]): PermissionDef[] =>
  list.flatMap(([module, actions, scope]) => actions.map((action) => ({ module, action, scope })));

/** Seed defaults. See docs/DECISIONS.md D-004..D-007 for how ambiguous cells were mapped. */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, PermissionDef[]> = {
  super_admin: grants(MODULES.map((m) => [m, [...ACTIONS], 'all'] as Grant)),

  ops_manager: grants([
    ['cms', E, 'all'],
    ['crm', [...F, 'export'], 'all'],
    ['cases', [...F, 'manage'], 'all'], // manage = reassign anything
    ['documents', V, 'all'],
    ['deliverables', V, 'all'],
    ['qa_reviews', V, 'all'],
    ['invoices', V, 'all'],
    ['payments', V, 'all'],
    ['subscriptions', V, 'all'],
    ['users', E, 'all'], // cannot touch super_admin: enforced in the users service
    ['dashboard_ops', [...V, 'export'], 'all'],
    ['dashboard_sales', [...V, 'export'], 'all'],
    ['dashboard_finance', [...V, 'export'], 'all'],
    ['audit_log', V, 'all'],
  ]),

  case_manager: grants([
    ['crm', V, 'all'],
    ['cases', F, 'all'],
    ['documents', F, 'all'],
    ['deliverables', E, 'all'],
    ['qa_reviews', V, 'all'],
    ['dashboard_ops', V, 'assigned'], // "team" = cases they manage
  ]),

  summarizer: grants([
    ['cases', E, 'assigned'],
    ['documents', E, 'assigned'],
    ['deliverables', E, 'assigned'],
    ['dashboard_ops', V, 'own'],
  ]),

  qa_reviewer: grants([
    ['cases', V, 'assigned'],
    ['documents', V, 'assigned'],
    ['deliverables', ['view', 'approve'], 'assigned'],
    ['qa_reviews', F, 'all'],
    ['dashboard_ops', V, 'own'],
  ]),

  sales: grants([
    ['cms', E, 'all'],
    ['crm', [...F, 'export'], 'all'],
    ['invoices', V, 'all'],
    ['payments', V, 'all'],
    ['subscriptions', V, 'all'],
    ['dashboard_sales', V, 'all'],
  ]),

  finance: grants([
    ['crm', V, 'all'],
    ['invoices', [...F, 'export'], 'all'],
    ['payments', [...F, 'approve', 'export'], 'all'], // approve = refunds
    ['subscriptions', [...F, 'manage'], 'all'],
    ['dashboard_finance', [...V, 'export'], 'all'],
  ]),

  client_admin: grants([
    ['cases', F, 'firm'],
    ['documents', F, 'firm'],
    ['deliverables', V, 'firm'],
    ['invoices', V, 'firm'],
    ['payments', ['view', 'create'], 'firm'], // create = pay an invoice
    ['subscriptions', ['view', 'manage'], 'firm'],
    ['users', E, 'firm'], // client roles only: enforced in the users service
    ['dashboard_client', V, 'firm'],
  ]),

  client_user: grants([
    ['cases', E, 'own'], // own includes cases shared with the user (CaseShare)
    ['documents', E, 'own'],
    ['deliverables', V, 'own'],
  ]),
};
