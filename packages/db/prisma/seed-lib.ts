/**
 * Idempotent seed (REQUIREMENTS.md §12 M0), shared by `pnpm db:seed` and the API test setup:
 * roles, permissions, plans, 1 internal org, 2 client orgs, 1 user per role, 3 synthetic cases.
 * Re-running is safe: everything is upserted by a natural key.
 */
import argon2 from 'argon2';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  INTERNAL_ROLES,
  ROLE_KEYS,
  ROLE_META,
  encrypt,
  permissionKey,
  type RoleKey,
} from '@datascribe/shared';
import type {
  CaseStatus,
  CaseType,
  Priority,
  PrismaClient,
} from '../generated/client/index.js';
import { SYNTHETIC_CASES } from './fixtures/synthetic-cases';

export const SEED_PLANS = [
  {
    name: 'Starter',
    priceMonthly: '499.00',
    includedPages: 500,
    overagePerPage: '0.9000',
    sortOrder: 1,
    features: ['Medical index', 'Chronology', '5-day turnaround'],
  },
  {
    name: 'Professional',
    priceMonthly: '1499.00',
    includedPages: 2000,
    overagePerPage: '0.7500',
    sortOrder: 2,
    features: ['Everything in Starter', 'Narrative summary', '3-day turnaround', 'Priority support'],
  },
  {
    name: 'Enterprise',
    priceMonthly: '3999.00',
    includedPages: 6000,
    overagePerPage: '0.6000',
    sortOrder: 3,
    features: [
      'Everything in Professional',
      'Dedicated case manager',
      '48-hour turnaround',
      'Custom templates',
    ],
  },
];

export const SEED_ORGS = {
  internal: { name: 'Datascribe', type: 'internal' as const, plan: null },
  acme: { name: 'Acme Injury Law (synthetic)', type: 'client' as const, plan: 'Professional' },
  harbor: { name: 'Harbor Legal Group (synthetic)', type: 'client' as const, plan: 'Starter' },
};
export type SeedOrgKey = keyof typeof SEED_ORGS;

/** Seed user email for a role, e.g. ops_manager -> ops.manager@datascribe.example */
export const internalSeedEmail = (role: RoleKey) => `${role.replace('_', '.')}@datascribe.example`;

// One user per role; Harbor gets its own client_admin so cross-org tests have a second firm.
export const SEED_USERS: { email: string; name: string; org: SeedOrgKey; role: RoleKey }[] = [
  ...INTERNAL_ROLES.map((role) => ({
    email: internalSeedEmail(role),
    name: `Seed ${ROLE_META[role].name}`,
    org: 'internal' as const,
    role,
  })),
  { email: 'client.admin@acme.example', name: 'Acme Client Admin', org: 'acme', role: 'client_admin' },
  { email: 'client.user@acme.example', name: 'Acme Client User', org: 'acme', role: 'client_user' },
  {
    email: 'client.admin@harbor.example',
    name: 'Harbor Client Admin',
    org: 'harbor',
    role: 'client_admin',
  },
];

export interface SeedResult {
  orgIds: Record<SeedOrgKey, string>;
  userIds: Record<string, string>; // by email
  caseIds: Record<string, string>; // by fixture key
  counts: Record<string, number>;
}

export async function seedDatabase(
  prisma: PrismaClient,
  opts: { password: string; phiKey: Buffer },
): Promise<SeedResult> {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { module_action_scope: p }, update: {}, create: p });
  }
  const permIds = new Map(
    (await prisma.permission.findMany()).map((p) => [`${p.module}:${p.action}:${p.scope}`, p.id]),
  );

  // System roles + default grants (reset to defaults on every seed)
  const roleIds = new Map<RoleKey, string>();
  for (const key of ROLE_KEYS) {
    const meta = ROLE_META[key];
    const fields = {
      name: meta.name,
      description: meta.description,
      isSystem: true,
      isInternal: meta.group === 'internal',
    };
    const role = await prisma.role.upsert({
      where: { key },
      update: fields,
      create: { key, ...fields },
    });
    roleIds.set(key, role.id);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: DEFAULT_ROLE_PERMISSIONS[key].map((p) => ({
        roleId: role.id,
        permissionId: permIds.get(permissionKey(p))!,
      })),
    });
  }

  const planIds = new Map<string, string>();
  for (const plan of SEED_PLANS) {
    const row = await prisma.subscriptionPlan.upsert({
      where: { name: plan.name },
      update: plan,
      create: plan,
    });
    planIds.set(plan.name, row.id);
  }

  // Organisations (no natural unique key on name; look up first)
  const orgIds = {} as Record<SeedOrgKey, string>;
  for (const key of Object.keys(SEED_ORGS) as SeedOrgKey[]) {
    const org = SEED_ORGS[key];
    const planId = org.plan ? planIds.get(org.plan)! : null;
    const existing = await prisma.organization.findFirst({ where: { name: org.name } });
    const row = existing
      ? await prisma.organization.update({
          where: { id: existing.id },
          data: { type: org.type, planId },
        })
      : await prisma.organization.create({ data: { name: org.name, type: org.type, planId } });
    orgIds[key] = row.id;

    if (org.plan && !(await prisma.subscription.findFirst({ where: { organizationId: row.id } }))) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      await prisma.subscription.create({
        data: { organizationId: row.id, planId: planId!, currentPeriodStart: start, currentPeriodEnd: end },
      });
    }
  }

  const passwordHash = await argon2.hash(opts.password, { type: argon2.argon2id });
  const userIds: Record<string, string> = {};
  for (const u of SEED_USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, organizationId: orgIds[u.org], passwordHash, status: 'active' },
      create: {
        email: u.email,
        name: u.name,
        organizationId: orgIds[u.org],
        passwordHash,
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: roleIds.get(u.role)! } },
      update: {},
      create: { userId: user.id, roleId: roleIds.get(u.role)! },
    });
    userIds[u.email] = user.id;
  }

  const caseIds: Record<string, string> = {};
  let n = 0;
  for (const c of SYNTHETIC_CASES) {
    n += 1;
    const number = `DS-SEED-${String(n).padStart(4, '0')}`;
    const createdById =
      c.org === 'acme' ? userIds['client.user@acme.example']! : userIds['client.admin@harbor.example']!;
    const assigned = c.status === 'submitted';
    const data = {
      organizationId: orgIds[c.org],
      matterName: c.matterName,
      reference: c.reference,
      patientName: encrypt(c.patientName, opts.phiKey),
      incidentDate: new Date(c.incidentDate),
      caseType: c.caseType as CaseType,
      requested: [...c.requested],
      priority: c.priority as Priority,
      status: c.status as CaseStatus,
      createdById,
      caseManagerId: userIds[internalSeedEmail('case_manager')],
      summarizerId: assigned ? userIds[internalSeedEmail('summarizer')] : null,
      qaReviewerId: assigned ? userIds[internalSeedEmail('qa_reviewer')] : null,
      submittedAt: assigned ? new Date() : null,
    };
    const row = await prisma.case.upsert({
      where: { number },
      update: data,
      create: { number, ...data },
    });
    caseIds[c.key] = row.id;
  }

  await prisma.setting.upsert({
    where: { key: 'company' },
    update: {},
    create: {
      key: 'company',
      value: { name: 'Datascribe', address: '', taxLabel: 'GST', taxRatePercent: 0 },
    },
  });

  return {
    orgIds,
    userIds,
    caseIds,
    counts: {
      permissions: ALL_PERMISSIONS.length,
      roles: ROLE_KEYS.length,
      plans: SEED_PLANS.length,
      orgs: Object.keys(SEED_ORGS).length,
      users: SEED_USERS.length,
      cases: SYNTHETIC_CASES.length,
    },
  };
}
