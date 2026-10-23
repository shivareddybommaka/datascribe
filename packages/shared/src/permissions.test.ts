import { describe, expect, it } from 'vitest';
import { broadestScope, can, defineAbilityFor, type ScopedResource } from './ability';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  MODULES,
  ROLE_KEYS,
  permissionKey,
  type Action,
  type Module,
  type RoleKey,
} from './permissions';

const ME = 'user-me';
const OTHER = 'user-other';
const MY_ORG = 'org-mine';
const OTHER_ORG = 'org-other';

const abilityFor = (role: RoleKey) =>
  defineAbilityFor({ id: ME, organizationId: MY_ORG }, DEFAULT_ROLE_PERMISSIONS[role]);

// Resources as the API will present them
const otherFirmCase: ScopedResource = {
  organizationId: OTHER_ORG,
  ownerId: OTHER,
  assigneeIds: [OTHER],
  sharedWithIds: [],
};
const myFirmCase: ScopedResource = {
  organizationId: MY_ORG,
  ownerId: OTHER,
  assigneeIds: [OTHER],
  sharedWithIds: [],
};
const myOwnCase: ScopedResource = {
  organizationId: MY_ORG,
  ownerId: ME,
  assigneeIds: [],
  sharedWithIds: [],
};
const sharedWithMe: ScopedResource = {
  organizationId: MY_ORG,
  ownerId: OTHER,
  assigneeIds: [],
  sharedWithIds: [ME],
};
const assignedToMe: ScopedResource = {
  organizationId: OTHER_ORG,
  ownerId: OTHER,
  assigneeIds: [ME],
  sharedWithIds: [],
};

type Row = [RoleKey, Action, Module, ScopedResource | undefined, boolean];

// Hand-written from REQUIREMENTS.md §4.3 / §4.4 — not derived from DEFAULT_ROLE_PERMISSIONS.
const MATRIX: Row[] = [
  // super_admin: everything
  ['super_admin', 'delete', 'cases', otherFirmCase, true],
  ['super_admin', 'edit', 'system_settings', undefined, true],
  ['super_admin', 'view', 'audit_log', undefined, true],

  // ops_manager
  ['ops_manager', 'delete', 'crm', undefined, true],
  ['ops_manager', 'delete', 'cms', undefined, false],
  ['ops_manager', 'manage', 'cases', otherFirmCase, true],
  ['ops_manager', 'view', 'documents', otherFirmCase, true],
  ['ops_manager', 'edit', 'documents', otherFirmCase, false],
  ['ops_manager', 'approve', 'deliverables', otherFirmCase, false],
  ['ops_manager', 'edit', 'users', undefined, true],
  ['ops_manager', 'delete', 'users', undefined, false],
  ['ops_manager', 'view', 'audit_log', undefined, true],
  ['ops_manager', 'view', 'system_settings', undefined, false],

  // case_manager
  ['case_manager', 'view', 'crm', undefined, true],
  ['case_manager', 'edit', 'crm', undefined, false],
  ['case_manager', 'delete', 'cases', otherFirmCase, true],
  ['case_manager', 'delete', 'documents', otherFirmCase, true],
  ['case_manager', 'edit', 'deliverables', otherFirmCase, true],
  ['case_manager', 'approve', 'deliverables', otherFirmCase, false],
  ['case_manager', 'view', 'invoices', undefined, false],

  // summarizer: assigned only
  ['summarizer', 'edit', 'cases', assignedToMe, true],
  ['summarizer', 'view', 'cases', otherFirmCase, false],
  ['summarizer', 'delete', 'cases', assignedToMe, false],
  ['summarizer', 'edit', 'documents', assignedToMe, true],
  ['summarizer', 'edit', 'deliverables', assignedToMe, true],
  ['summarizer', 'edit', 'deliverables', otherFirmCase, false],
  ['summarizer', 'view', 'qa_reviews', undefined, false],
  ['summarizer', 'view', 'crm', undefined, false],

  // qa_reviewer
  ['qa_reviewer', 'view', 'cases', assignedToMe, true],
  ['qa_reviewer', 'edit', 'cases', assignedToMe, false],
  ['qa_reviewer', 'approve', 'deliverables', assignedToMe, true],
  ['qa_reviewer', 'approve', 'deliverables', otherFirmCase, false],
  ['qa_reviewer', 'edit', 'deliverables', assignedToMe, false],
  ['qa_reviewer', 'delete', 'qa_reviews', undefined, true],

  // sales: CRM yes, PHI never (§4.4)
  ['sales', 'delete', 'crm', undefined, true],
  ['sales', 'edit', 'cms', undefined, true],
  ['sales', 'view', 'invoices', undefined, true],
  ['sales', 'edit', 'invoices', undefined, false],
  ['sales', 'view', 'cases', undefined, false],
  ['sales', 'view', 'documents', undefined, false],
  ['sales', 'view', 'deliverables', undefined, false],

  // finance: billing yes, PHI never (§4.4)
  ['finance', 'view', 'crm', undefined, true],
  ['finance', 'edit', 'crm', undefined, false],
  ['finance', 'delete', 'invoices', undefined, true],
  ['finance', 'approve', 'payments', undefined, true],
  ['finance', 'manage', 'subscriptions', undefined, true],
  ['finance', 'view', 'cases', undefined, false],
  ['finance', 'view', 'documents', undefined, false],
  ['finance', 'view', 'deliverables', undefined, false],

  // client_admin: own firm only (§4.4)
  ['client_admin', 'delete', 'cases', myFirmCase, true],
  ['client_admin', 'view', 'cases', otherFirmCase, false],
  ['client_admin', 'view', 'documents', otherFirmCase, false],
  ['client_admin', 'view', 'deliverables', myFirmCase, true],
  ['client_admin', 'edit', 'deliverables', myFirmCase, false],
  ['client_admin', 'view', 'invoices', myFirmCase, true],
  ['client_admin', 'view', 'invoices', otherFirmCase, false],
  ['client_admin', 'create', 'payments', myFirmCase, true],
  ['client_admin', 'manage', 'subscriptions', myFirmCase, true],
  ['client_admin', 'edit', 'users', myFirmCase, true],
  ['client_admin', 'edit', 'users', otherFirmCase, false],
  ['client_admin', 'view', 'crm', undefined, false],
  ['client_admin', 'view', 'audit_log', undefined, false],

  // client_user: own + shared
  ['client_user', 'edit', 'cases', myOwnCase, true],
  ['client_user', 'view', 'cases', sharedWithMe, true],
  ['client_user', 'view', 'cases', myFirmCase, false],
  ['client_user', 'view', 'cases', otherFirmCase, false],
  ['client_user', 'delete', 'cases', myOwnCase, false],
  ['client_user', 'view', 'deliverables', sharedWithMe, true],
  ['client_user', 'view', 'invoices', undefined, false],
  ['client_user', 'view', 'users', undefined, false],
];

describe('permission matrix (§4.3)', () => {
  it.each(MATRIX)('%s %s %s -> %s', (role, action, module, resource, expected) => {
    expect(can(abilityFor(role), action, module, resource)).toBe(expected);
  });
});

describe('always-true rules (§4.4)', () => {
  const PHI_MODULES: Module[] = ['cases', 'documents', 'deliverables'];

  it.each(['sales', 'finance'] as const)('%s has no grant at all on PHI modules', (role) => {
    const ability = abilityFor(role);
    for (const m of PHI_MODULES) {
      for (const a of ['view', 'export', 'manage'] as const) {
        expect(can(ability, a, m)).toBe(false);
      }
    }
  });

  it.each(['client_admin', 'client_user'] as const)(
    '%s can never act on another organisation',
    (role) => {
      const ability = abilityFor(role);
      for (const m of MODULES) {
        for (const a of ['view', 'create', 'edit', 'delete', 'export'] as const) {
          expect(can(ability, a, m, otherFirmCase)).toBe(false);
        }
      }
    },
  );

  it('client roles hold no "all"-scoped permission', () => {
    for (const role of ['client_admin', 'client_user'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].some((p) => p.scope === 'all')).toBe(false);
    }
  });
});

describe('catalogue', () => {
  it('every seeded grant exists in ALL_PERMISSIONS', () => {
    const keys = new Set(ALL_PERMISSIONS.map(permissionKey));
    for (const role of ROLE_KEYS) {
      for (const p of DEFAULT_ROLE_PERMISSIONS[role]) expect(keys.has(permissionKey(p))).toBe(true);
    }
  });

  it('"manage" is an ordinary action, not a CASL wildcard', () => {
    // ops_manager has cases:manage but must not get cases:approve from it
    expect(can(abilityFor('ops_manager'), 'approve', 'cases')).toBe(false);
  });

  it('broadestScope picks the widest grant', () => {
    expect(broadestScope(DEFAULT_ROLE_PERMISSIONS.client_admin, 'cases', 'view')).toBe('firm');
    expect(broadestScope(DEFAULT_ROLE_PERMISSIONS.summarizer, 'cases', 'view')).toBe('assigned');
    expect(broadestScope(DEFAULT_ROLE_PERMISSIONS.sales, 'cases', 'view')).toBeNull();
    expect(
      broadestScope(
        [
          { module: 'cases', action: 'view', scope: 'own' },
          { module: 'cases', action: 'view', scope: 'firm' },
        ],
        'cases',
        'view',
      ),
    ).toBe('firm');
  });
});
