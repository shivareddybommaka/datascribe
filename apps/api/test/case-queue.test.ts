import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { slaFlag } from '../src/services/cases';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

/** M6 part 1 (§5.4, D-083): staff case queue filters, SLA flags and assignment. Synthetic data. */
const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) =>
  request(app).get(`/api/v1${path}`).set(bearer(tokens[who]!));
const assign = (who: string, id: string, body: object) =>
  request(app).post(`/api/v1/cases/${id}/assign`).set(bearer(tokens[who]!)).send(body);

const H = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * H);
const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MATTER = `Synthetic Queue Matter ${STAMP}`;

const users: Record<string, { id: string; email: string }> = {};
const ids: Record<string, string> = {};

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
  users.cm = await makeStaff('case_manager', 'Synthetic Queue Manager');
  users.cm2 = await makeStaff('case_manager', 'Synthetic Second Manager');
  users.sum = await makeStaff('summarizer', 'Synthetic Queue Summarizer');
  users.qa = await makeStaff('qa_reviewer', 'Synthetic Queue Reviewer');

  const acme = await orgId('acme');
  const creator = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
  const kase = async (key: string, data: Record<string, unknown>) => {
    const c = await prisma.case.create({
      data: {
        organizationId: acme,
        number: `DSQ-${STAMP}-${key}`,
        matterName: MATTER,
        patientName: encrypt('Riley Synthetic', testPhiKey),
        caseType: 'personal_injury',
        requested: ['index', 'chronology'],
        createdById: creator.id,
        submittedAt: new Date(),
        ...data,
      },
    });
    ids[key] = c.id;
  };
  await kase('overdue', {
    status: 'in_review',
    dueAt: inHours(-2),
    priority: 'normal',
    caseManagerId: users.cm.id,
  });
  await kase('soon', {
    status: 'processing',
    dueAt: inHours(5),
    priority: 'urgent',
    caseManagerId: users.cm.id,
  });
  await kase('later', { status: 'submitted', dueAt: inHours(72), priority: 'low' });
  await kase('pastDelivered', {
    status: 'delivered',
    dueAt: inHours(-10),
    caseManagerId: users.cm.id,
  });
  await kase('draft', { status: 'draft', submittedAt: null });

  for (const [k, email] of Object.entries({
    cm: users.cm.email,
    cm2: users.cm2.email,
    sum: users.sum.email,
    qa: users.qa.email,
    ops: SEED.internal('ops_manager'),
    sales: SEED.internal('sales'),
    acmeAdmin: SEED.acmeAdmin,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { userId: { in: Object.values(users).map((u) => u.id) } },
  });
  await prisma.case.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.$disconnect();
});

type Row = {
  id: string;
  sla: string | null;
  priority: string;
  summarizer?: { id: string } | null;
  organization?: { name: string };
};
const mine = (body: { items: Row[] }) =>
  body.items.filter((i) => Object.values(ids).includes(i.id));
const q = `q=${encodeURIComponent(MATTER)}`;

describe('SLA flag (§5.4)', () => {
  it('is red when overdue, amber under 24 h, none otherwise or once delivered', () => {
    const now = new Date('2026-10-25T00:00:00Z');
    const at = (h: number) => new Date(now.getTime() + h * H);
    expect(slaFlag({ status: 'in_review', dueAt: at(-1) }, now)).toBe('red');
    expect(slaFlag({ status: 'qa', dueAt: at(23) }, now)).toBe('amber');
    expect(slaFlag({ status: 'qa', dueAt: at(25) }, now)).toBeNull();
    expect(slaFlag({ status: 'delivered', dueAt: at(-1) }, now)).toBeNull();
    expect(slaFlag({ status: 'draft', dueAt: at(-1) }, now)).toBeNull();
    expect(slaFlag({ status: 'qa', dueAt: null }, now)).toBeNull();
  });
});

describe('staff case queue (§5.4)', () => {
  it('flags SLA and shows the firm and assignees to staff', async () => {
    const res = await get('ops', `/cases?${q}&limit=100`);
    expect(res.status).toBe(200);
    const byId = new Map(mine(res.body).map((r) => [r.id, r]));
    expect(byId.get(ids.overdue!)!.sla).toBe('red');
    expect(byId.get(ids.soon!)!.sla).toBe('amber');
    expect(byId.get(ids.later!)!.sla).toBeNull();
    expect(byId.get(ids.pastDelivered!)!.sla).toBeNull();
    expect(byId.get(ids.overdue!)!.organization!.name).toMatch(/Acme/);
    expect(byId.get(ids.overdue!)).toHaveProperty('summarizer', null);
  });

  it('filters by SLA flag', async () => {
    const red = mine((await get('ops', `/cases?${q}&sla=red`)).body).map((r) => r.id);
    expect(red).toEqual([ids.overdue]);
    const any = mine((await get('ops', `/cases?${q}&sla=any`)).body).map((r) => r.id);
    expect(any.sort()).toEqual([ids.overdue, ids.soon].sort());
  });

  it('filters by client firm, unassigned slot and due date, and sorts by priority', async () => {
    const harbor = await orgId('harbor');
    expect(mine((await get('ops', `/cases?${q}&organizationId=${harbor}`)).body)).toHaveLength(0);
    const noCm = mine((await get('ops', `/cases?${q}&unassigned=case_manager`)).body).map(
      (r) => r.id,
    );
    expect(noCm).toEqual([ids.later]);
    const due = mine(
      (await get('ops', `/cases?${q}&dueBefore=${inHours(30).toISOString().slice(0, 10)}`)).body,
    );
    expect(due.map((r) => r.id)).not.toContain(ids.later);
    const sorted = mine((await get('ops', `/cases?${q}&open=true&sort=priority`)).body);
    expect(sorted[0]!.id).toBe(ids.soon);
  });

  it('keeps staff filters and assignee names away from client users', async () => {
    const res = await get('acmeAdmin', `/cases?assigneeId=${users.cm!.id}`);
    expect(res.status).toBe(400);
    const list = await get('acmeAdmin', `/cases?${q}`);
    expect(list.status).toBe(200);
    expect(mine(list.body)[0]).not.toHaveProperty('summarizer');
    expect(mine(list.body)[0]).not.toHaveProperty('caseManager');
  });
});

describe('assignment (§5.4, D-083)', () => {
  it('lists eligible staff with their open workload', async () => {
    const res = await get('cm', '/cases/assignable-staff?role=summarizer');
    expect(res.status).toBe(200);
    const people = res.body.items as { id: string; openCases: number }[];
    expect(people.map((p) => p.id)).toContain(users.sum!.id);
    expect(people.map((p) => p.id)).not.toContain(users.qa!.id);
    expect(people.find((p) => p.id === users.sum!.id)!.openCases).toBe(0);
    expect((await get('sum', '/cases/assignable-staff?role=summarizer')).status).toBe(403);
    expect((await get('sales', '/cases/assignable-staff?role=summarizer')).status).toBe(403);
    expect((await get('acmeAdmin', '/cases/assignable-staff?role=summarizer')).status).toBe(403);
  });

  it('lets the case manager assign a summarizer and QA reviewer; audits and notifies them', async () => {
    const res = await assign('cm', ids.overdue!, {
      summarizerId: users.sum!.id,
      qaReviewerId: users.qa!.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summarizerId).toBe(users.sum!.id);
    expect(res.body.assignees.qaReviewer.id).toBe(users.qa!.id);
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'Case', entityId: ids.overdue!, action: 'case.assign' },
    });
    expect(audits.map((a) => (a.metadata as { role: string }).role).sort()).toEqual([
      'qa_reviewer',
      'summarizer',
    ]);
    const notes = await prisma.notification.findMany({
      where: { type: 'assigned_to_you', userId: { in: [users.sum!.id, users.qa!.id] } },
    });
    expect(notes).toHaveLength(2);
    // now on the summarizer's queue
    const theirs = mine((await get('sum', `/cases?${q}&assigneeId=me`)).body).map((r) => r.id);
    expect(theirs).toEqual([ids.overdue]);
  });

  it('rejects the same person as summarizer and QA reviewer, and ineligible people', async () => {
    const same = await assign('cm', ids.soon!, {
      summarizerId: users.sum!.id,
      qaReviewerId: users.sum!.id,
    });
    expect(same.status).toBe(409);
    expect(JSON.stringify(same.body)).toContain('same_person');
    const wrong = await assign('cm', ids.soon!, { summarizerId: users.qa!.id });
    expect(wrong.status).toBe(400);
    const client = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
    expect((await assign('cm', ids.soon!, { summarizerId: client.id })).status).toBe(400);
  });

  it('keeps other managers off a case; they may claim an unmanaged one but not move it', async () => {
    expect((await assign('cm2', ids.soon!, { summarizerId: users.sum!.id })).status).toBe(403);
    expect((await assign('cm2', ids.soon!, { caseManagerId: users.cm2!.id })).status).toBe(403);
    const claim = await assign('cm2', ids.later!, { caseManagerId: users.cm2!.id });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect((await assign('cm2', ids.later!, { caseManagerId: users.cm!.id })).status).toBe(403);
  });

  it('lets ops reassign anything', async () => {
    const res = await assign('ops', ids.soon!, { caseManagerId: users.cm2!.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.caseManagerId).toBe(users.cm2!.id);
    expect(res.body.can.reassignAny).toBe(true);
  });

  it('refuses summarizers, client admins, sales and draft cases', async () => {
    expect((await assign('sum', ids.overdue!, { qaReviewerId: null })).status).toBe(403);
    expect((await assign('acmeAdmin', ids.overdue!, { qaReviewerId: null })).status).toBe(403);
    expect((await assign('sales', ids.overdue!, { qaReviewerId: null })).status).toBe(403);
    const draft = await assign('ops', ids.draft!, { summarizerId: users.sum!.id });
    expect(draft.status).toBe(409);
  });
});
