/**
 * Idempotent dev/test seed (REQUIREMENTS.md §12 M0):
 * roles, permissions, plans, 1 internal org, 2 client orgs, 1 user per role, 3 synthetic cases.
 * Re-running is safe: everything is upserted by a natural key.
 */
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import argon2 from 'argon2';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  INTERNAL_ROLES,
  ROLE_KEYS,
  ROLE_META,
  encrypt,
  loadKey,
  permissionKey,
  type RoleKey,
} from '@datascribe/shared';
import {
  PrismaClient,
  type CaseStatus,
  type CaseType,
  type Priority,
} from '../generated/client/index.js';
import { SYNTHETIC_CASES } from './fixtures/synthetic-cases';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed with NODE_ENV=production.');
  process.exit(1);
}

const password = process.env.SEED_USER_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set SEED_USER_PASSWORD (min 12 chars) in .env before seeding.');
  process.exit(1);
}
const phiKey = loadKey(process.env.PHI_ENCRYPTION_KEY);

const prisma = new PrismaClient();

const PLANS = [
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
    features: [
      'Everything in Starter',
      'Narrative summary',
      '3-day turnaround',
      'Priority support',
    ],
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

const ORGS = {
  internal: { name: 'Datascribe', type: 'internal' as const, plan: null },
  acme: { name: 'Acme Injury Law (synthetic)', type: 'client' as const, plan: 'Professional' },
  harbor: { name: 'Harbor Legal Group (synthetic)', type: 'client' as const, plan: 'Starter' },
};

// One user per role; Harbor gets its own client_admin so cross-org tests have a second firm.
const USERS: { email: string; name: string; org: keyof typeof ORGS; role: RoleKey }[] = [
  ...INTERNAL_ROLES.map((role) => ({
    email: `${role.replace('_', '.')}@datascribe.example`,
    name: `Seed ${ROLE_META[role].name}`,
    org: 'internal' as const,
    role,
  })),
  {
    email: 'client.admin@acme.example',
    name: 'Acme Client Admin',
    org: 'acme',
    role: 'client_admin',
  },
  { email: 'client.user@acme.example', name: 'Acme Client User', org: 'acme', role: 'client_user' },
  {
    email: 'client.admin@harbor.example',
    name: 'Harbor Client Admin',
    org: 'harbor',
    role: 'client_admin',
  },
];

async function main() {
  // Permissions catalogue
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { module_action_scope: p },
      update: {},
      create: p,
    });
  }
  const permIds = new Map(
    (await prisma.permission.findMany()).map((p) => [`${p.module}:${p.action}:${p.scope}`, p.id]),
  );

  // System roles + default grants (reset to defaults on every seed)
  const roleIds = new Map<RoleKey, string>();
  for (const key of ROLE_KEYS) {
    const meta = ROLE_META[key];
    const role = await prisma.role.upsert({
      where: { key },
      update: {
        name: meta.name,
        description: meta.description,
        isSystem: true,
        isInternal: meta.group === 'internal',
      },
      create: {
        key,
        name: meta.name,
        description: meta.description,
        isSystem: true,
        isInternal: meta.group === 'internal',
      },
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

  // Plans
  const planIds = new Map<string, string>();
  for (const plan of PLANS) {
    const row = await prisma.subscriptionPlan.upsert({
      where: { name: plan.name },
      update: plan,
      create: plan,
    });
    planIds.set(plan.name, row.id);
  }

  // Organisations (no natural unique key on name; look up first)
  const orgIds = new Map<keyof typeof ORGS, string>();
  for (const [key, org] of Object.entries(ORGS) as [
    keyof typeof ORGS,
    (typeof ORGS)[keyof typeof ORGS],
  ][]) {
    const planId = org.plan ? planIds.get(org.plan)! : null;
    const existing = await prisma.organization.findFirst({ where: { name: org.name } });
    const row = existing
      ? await prisma.organization.update({
          where: { id: existing.id },
          data: { type: org.type, planId },
        })
      : await prisma.organization.create({ data: { name: org.name, type: org.type, planId } });
    orgIds.set(key, row.id);

    if (org.plan && !(await prisma.subscription.findFirst({ where: { organizationId: row.id } }))) {
      const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      await prisma.subscription.create({
        data: {
          organizationId: row.id,
          planId: planId!,
          currentPeriodStart: start,
          currentPeriodEnd: end,
        },
      });
    }
  }

  // Users
  const passwordHash = await argon2.hash(password!, { type: argon2.argon2id });
  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, organizationId: orgIds.get(u.org)!, passwordHash, status: 'active' },
      create: {
        email: u.email,
        name: u.name,
        organizationId: orgIds.get(u.org)!,
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
    userIds.set(u.role === 'client_admin' ? `${u.org}:client_admin` : u.role, user.id);
  }

  // Synthetic cases
  let n = 0;
  for (const c of SYNTHETIC_CASES) {
    n += 1;
    const number = `DS-SEED-${String(n).padStart(4, '0')}`;
    const createdById =
      c.org === 'acme' ? userIds.get('client_user')! : userIds.get('harbor:client_admin')!;
    const data = {
      organizationId: orgIds.get(c.org)!,
      matterName: c.matterName,
      reference: c.reference,
      patientName: encrypt(c.patientName, phiKey),
      incidentDate: new Date(c.incidentDate),
      caseType: c.caseType as CaseType,
      requested: [...c.requested],
      priority: c.priority as Priority,
      status: c.status as CaseStatus,
      createdById,
      caseManagerId: userIds.get('case_manager'),
      summarizerId: c.status === 'submitted' ? userIds.get('summarizer') : null,
      qaReviewerId: c.status === 'submitted' ? userIds.get('qa_reviewer') : null,
      submittedAt: c.status === 'submitted' ? new Date() : null,
    };
    await prisma.case.upsert({ where: { number }, update: data, create: { number, ...data } });
  }

  await prisma.setting.upsert({
    where: { key: 'company' },
    update: {},
    create: {
      key: 'company',
      value: { name: 'Datascribe', address: '', taxLabel: 'GST', taxRatePercent: 0 },
    },
  });

  console.log(
    `Seeded ${ALL_PERMISSIONS.length} permissions, ${ROLE_KEYS.length} roles, ${PLANS.length} plans, ` +
      `${Object.keys(ORGS).length} orgs, ${USERS.length} users, ${SYNTHETIC_CASES.length} synthetic cases.`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
