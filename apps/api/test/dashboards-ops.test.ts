import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) => request(app).get(path).set(bearer(tokens[who]!));

const H = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * H);
const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MATTER = `Synthetic Ops Matter ${STAMP}`;
const PATIENT = 'Jordan Synthetic';

const users: Record<string, { id: string; email: string }> = {};
const caseIds: string[] = [];

/** A fresh internal user, so the own / assigned numbers below are exact. */
async function makeStaff(role: RoleKey, name: string) {
  const email = uniqueEmail(role.replace(/_/g, '-'));
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const u = await prisma.user.create({
    data: {
      email,
      name,
      organizationId: await orgId('internal'),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      mfaEnabled: true,
      mfaSecret: encrypt(TEST_TOTP_SECRET, testPhiKey),
      roles: { create: [{ roleId: r.id }] },
    },
  });
  return { id: u.id, email };
}

beforeAll(async () => {
  users.cm = await makeStaff('case_manager', 'Synthetic Manager');
  users.a = await makeStaff('summarizer', 'Synthetic Summarizer A');
  users.b = await makeStaff('summarizer', 'Synthetic Summarizer B');
  users.qa = await makeStaff('qa_reviewer', 'Synthetic Reviewer');

  const acme = await orgId('acme');
  const creator = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
  const kase = async (n: number, data: Record<string, unknown>) => {
    const c = await prisma.case.create({
      data: {
        organizationId: acme,
        number: `DSH-${STAMP}-${n}`,
        matterName: MATTER,
        patientName: encrypt(PATIENT, testPhiKey),
        caseType: 'personal_injury',
        requested: ['index'],
        createdById: creator.id,
        caseManagerId: users.cm!.id,
        ...data,
      },
    });
    caseIds.push(c.id);
    return c;
  };

  // 1: A's, in review 6 h after submission, overdue
  const c1 = await kase(1, {
    status: 'in_review',
    summarizerId: users.a!.id,
    qaReviewerId: users.qa!.id,
    submittedAt: ago(10),
    dueAt: ago(1),
  });
  await prisma.auditLog.create({
    data: {
      action: 'case.status',
      entity: 'Case',
      entityId: c1.id,
      organizationId: acme,
      metadata: { from: 'processing', to: 'in_review', by: 'pipeline' },
      createdAt: ago(4),
    },
  });
  // 2: A's, in QA, due tomorrow
  await kase(2, { status: 'qa', summarizerId: users.a!.id, submittedAt: ago(30), dueAt: ago(-24) });
  // 3: B's, processing, overdue
  await kase(3, {
    status: 'processing',
    summarizerId: users.b!.id,
    submittedAt: ago(5),
    dueAt: ago(2),
  });
  // 4: A's, delivered 48 h after submission (not open, not overdue even though past due)
  await kase(4, {
    status: 'delivered',
    summarizerId: users.a!.id,
    qaReviewerId: users.qa!.id,
    submittedAt: ago(50),
    deliveredAt: ago(2),
    dueAt: ago(10),
  });
  // 5: nobody summarizing yet
  await kase(5, { status: 'submitted', submittedAt: ago(1) });
  // 6: a draft another manager's team owns: outside cm's scope
  await kase(6, { status: 'draft', caseManagerId: null });

  for (const [k, email] of Object.entries({
    cm: users.cm.email,
    a: users.a.email,
    b: users.b.email,
    qa: users.qa.email,
    ops: SEED.internal('ops_manager'),
    seededSummarizer: SEED.internal('summarizer'),
    sales: SEED.internal('sales'),
    finance: SEED.internal('finance'),
    acmeAdmin: SEED.acmeAdmin,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  // the review-timeline row stays: AuditLog is append-only (a trigger rejects DELETE)
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.$disconnect();
});

type Ops = {
  days: number;
  scope: string;
  byStatus: { status: string; count: number }[];
  open: number;
  overdue: number;
  turnaround: {
    delivered: { count: number; avgHours: number | null };
    inReview: { count: number; avgHours: number | null };
  };
  workload: { userId: string | null; name: string | null; open: number; overdue: number }[];
};
const status = (b: Ops, s: string) => b.byStatus.find((x) => x.status === s)!.count;
const OPS = '/api/v1/dashboards/ops';

describe('GET /dashboards/ops', () => {
  it('is for ops managers, case managers, summarizers and QA; not sales, finance or clients', async () => {
    for (const who of ['ops', 'cm', 'a', 'qa', 'seededSummarizer']) {
      expect((await get(who, OPS)).status, who).toBe(200);
    }
    for (const who of ['sales', 'finance', 'acmeAdmin']) {
      expect((await get(who, OPS)).status, who).toBe(403);
    }
    expect((await request(app).get(OPS)).status).toBe(401);
  });

  it('own (summarizer): only cases they summarize, and only their own workload row', async () => {
    const res = await get('a', OPS);
    expect(res.status).toBe(200);
    const d = res.body as Ops;
    expect(d.scope).toBe('own');
    expect(d.days).toBe(30);
    expect(d.byStatus.map((s) => s.status)).toEqual([
      'draft',
      'submitted',
      'processing',
      'in_review',
      'qa',
      'changes_requested',
      'approved',
      'delivered',
      'closed',
      'on_hold',
      'cancelled',
    ]);
    expect(d.byStatus.reduce((n, s) => n + s.count, 0)).toBe(3);
    expect([status(d, 'in_review'), status(d, 'qa'), status(d, 'delivered')]).toEqual([1, 1, 1]);
    expect(d.open).toBe(2);
    expect(d.overdue).toBe(1);
    expect(d.turnaround.delivered).toEqual({ count: 1, avgHours: 48 });
    expect(d.turnaround.inReview).toEqual({ count: 1, avgHours: 6 });
    expect(d.workload).toEqual([
      { userId: users.a!.id, name: 'Synthetic Summarizer A', open: 2, overdue: 1 },
    ]);
  });

  it('own (QA): cases they review; no workload rows since they summarize none', async () => {
    const d = (await get('qa', OPS)).body as Ops;
    expect(d.scope).toBe('own');
    expect(d.byStatus.reduce((n, s) => n + s.count, 0)).toBe(2);
    expect(d.open).toBe(1);
    expect(d.overdue).toBe(1);
    expect(d.workload).toEqual([]);
  });

  it('assigned (case manager): their team, workload per summarizer with unassigned last', async () => {
    const d = (await get('cm', OPS)).body as Ops;
    expect(d.scope).toBe('assigned');
    expect(d.byStatus.reduce((n, s) => n + s.count, 0)).toBe(5);
    expect(status(d, 'draft')).toBe(0);
    expect(d.open).toBe(4);
    expect(d.overdue).toBe(2);
    expect(d.turnaround.delivered).toEqual({ count: 1, avgHours: 48 });
    expect(d.workload).toEqual([
      { userId: users.a!.id, name: 'Synthetic Summarizer A', open: 2, overdue: 1 },
      { userId: users.b!.id, name: 'Synthetic Summarizer B', open: 1, overdue: 1 },
      { userId: null, name: null, open: 1, overdue: 0 },
    ]);
  });

  it('all (ops manager): every case, including other teams', async () => {
    const d = (await get('ops', OPS)).body as Ops;
    expect(d.scope).toBe('all');
    expect(status(d, 'draft')).toBeGreaterThanOrEqual(1);
    expect(d.open).toBeGreaterThanOrEqual(4);
    expect(d.overdue).toBeGreaterThanOrEqual(2);
    expect(d.workload.find((w) => w.userId === users.b!.id)).toMatchObject({ open: 1, overdue: 1 });
    expect(d.workload.at(-1)?.userId ?? null).toBeNull();
  });

  it('a short window leaves older turnaround out', async () => {
    // delivered 2 h ago and reviewed 4 h ago both fall inside 1 day; nothing older than that exists
    const d = (await get('a', `${OPS}?days=1`)).body as Ops;
    expect(d.days).toBe(1);
    expect(d.turnaround.delivered.count).toBe(1);
    await prisma.case.update({ where: { id: caseIds[3]! }, data: { deliveredAt: ago(72) } });
    const later = (await get('a', `${OPS}?days=1`)).body as Ops;
    expect(later.turnaround.delivered).toEqual({ count: 0, avgHours: null });
  });

  it('returns aggregates only, never case details', async () => {
    for (const who of ['ops', 'cm', 'a']) {
      const body = JSON.stringify((await get(who, OPS)).body);
      expect(body).not.toContain(MATTER);
      expect(body).not.toContain(PATIENT);
      expect(body).not.toContain(`DSH-${STAMP}`);
      expect(body).not.toMatch(/@/);
    }
  });

  it('rejects a bad window', async () => {
    expect((await get('ops', `${OPS}?days=0`)).status).toBe(400);
    expect((await get('ops', `${OPS}?days=abc`)).status).toBe(400);
  });
});
