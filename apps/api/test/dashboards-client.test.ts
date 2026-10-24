import { encrypt } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) => request(app).get(path).set(bearer(tokens[who]!));

const D = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * D);
const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const CLIENT = '/api/v1/dashboards/client';
const PATIENT = `Zebulon${STAMP} Quarry (synthetic)`;

// two fresh firms, so every count below is exact and B's data must never show up for A
const org: Record<'a' | 'b', string> = { a: '', b: '' };
const users: Record<string, string> = {};
const caseIds: string[] = [];
let n = 0;

async function user(key: string, firm: 'a' | 'b', role: 'client_admin' | 'client_user') {
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const email = uniqueEmail(`dash.${key.toLowerCase()}`); // sign-in lowercases the email
  const u = await prisma.user.create({
    data: {
      email,
      name: `Dashboard ${key} (synthetic)`,
      organizationId: org[firm],
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: r.id } },
    },
  });
  users[key] = u.id;
  tokens[key] = (await login(app, email)).token;
}

async function kase(
  firm: 'a' | 'b',
  by: string,
  status: 'draft' | 'submitted' | 'in_review' | 'delivered',
  extra: { pages?: number; pagesAt?: Date; sharedWith?: string } = {},
) {
  const c = await prisma.case.create({
    data: {
      organizationId: org[firm],
      number: `DSHC-${STAMP}-${n++}`,
      matterName: 'Synthetic v. Dashboard',
      patientName: encrypt(PATIENT, testPhiKey),
      caseType: 'personal_injury',
      requested: ['index'],
      status,
      createdById: users[by]!,
      submittedAt: status === 'draft' ? null : ago(10),
      shares: extra.sharedWith ? { create: { userId: users[extra.sharedWith]! } } : undefined,
    },
  });
  caseIds.push(c.id);
  if (extra.pages) await usage(firm, extra.pages, extra.pagesAt ?? new Date(), c.id);
}

async function usage(firm: 'a' | 'b', quantity: number, at: Date, caseId: string | null = null) {
  await prisma.usageRecord.create({
    data: {
      organizationId: org[firm],
      caseId,
      metric: 'pages_processed',
      quantity,
      periodStart: at,
      createdAt: at,
    },
  });
}

async function paid(
  firm: 'a' | 'b',
  currency: string,
  total: string,
  paidAt: Date,
  refunded = '0',
) {
  const i = n++;
  const inv = await prisma.invoice.create({
    data: {
      organizationId: org[firm],
      number: `DSHC-${STAMP}-${i}`,
      status: 'paid',
      subtotal: total,
      tax: '0',
      total,
      currency,
      issuedAt: ago(90),
      paidAt,
    },
  });
  await prisma.payment.create({
    data: {
      invoiceId: inv.id,
      gateway: 'fake',
      gatewayRef: `dashc_${STAMP}_${i}`,
      amount: total,
      currency,
      status: 'succeeded',
      refundedAmount: refunded,
    },
  });
}

beforeAll(async () => {
  for (const k of ['a', 'b'] as const) {
    org[k] = (
      await prisma.organization.create({
        data: { name: `Synthetic Client ${k.toUpperCase()} ${STAMP}`, type: 'client' },
      })
    ).id;
  }
  await user('adminA', 'a', 'client_admin');
  await user('x', 'a', 'client_user');
  await user('y', 'a', 'client_user');
  await user('adminB', 'b', 'client_admin');

  // firm A: 5 cases; x sees the two they created plus one y shared with them
  await kase('a', 'x', 'submitted');
  await kase('a', 'x', 'delivered', { pages: 120 });
  await kase('a', 'y', 'in_review', { pages: 500, pagesAt: ago(60), sharedWith: 'x' });
  await kase('a', 'y', 'delivered', { pages: 30 });
  await kase('a', 'adminA', 'draft');
  await usage('a', 7, ago(3)); // not tied to a case: firm-wide viewers only

  await paid('a', 'USD', '300.00', ago(1));
  await paid('a', 'USD', '80.00', ago(2), '30.00'); // net 50
  await paid('a', 'USD', '500.00', ago(60)); // outside the 30-day window
  await paid('a', 'AUD', '10.00', ago(5));
  await prisma.invoice.create({
    data: {
      organizationId: org.a,
      number: `DSHC-${STAMP}-${n++}`,
      status: 'issued',
      subtotal: '100.00',
      tax: '0',
      total: '100.00',
      currency: 'USD',
      issuedAt: ago(5),
    },
  });

  // firm B: must never leak into A's numbers
  await kase('b', 'adminB', 'delivered', { pages: 999 });
  await kase('b', 'adminB', 'submitted');
  await paid('b', 'USD', '444.00', ago(1));

  tokens.ops = (await login(app, SEED.internal('ops_manager'))).token;
  tokens.acmeAdmin = (await login(app, SEED.acmeAdmin)).token;
});

afterAll(async () => {
  const numbers = { number: { startsWith: `DSHC-${STAMP}-` } };
  await prisma.payment.deleteMany({ where: { invoice: numbers } });
  await prisma.invoice.deleteMany({ where: numbers });
  await prisma.usageRecord.deleteMany({ where: { organizationId: { in: [org.a, org.b] } } });
  await prisma.caseShare.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.$disconnect();
});

type Client = {
  days: number;
  scope: 'firm' | 'own' | null;
  cases: { total: number; byStatus: { status: string; count: number }[] } | null;
  pages: { processed: number; cases: number } | null;
  spend: { currency: string; amount: string; payments: number }[] | null;
};
const counts = (d: Client) =>
  Object.fromEntries(d.cases!.byStatus.filter((s) => s.count).map((s) => [s.status, s.count]));

describe('GET /dashboards/client', () => {
  it('is for client-org users only', async () => {
    for (const who of ['adminA', 'x', 'acmeAdmin']) {
      expect((await get(who, CLIENT)).status, who).toBe(200);
    }
    expect((await get('ops', CLIENT)).status).toBe(403);
    expect((await request(app).get(CLIENT)).status).toBe(401);
    // the staff dashboards stay internal
    expect((await get('adminA', '/api/v1/dashboards/ops')).status).toBe(403);
  });

  it('client admin: every firm case, firm pages in the window, spend net of refunds', async () => {
    const d = (await get('adminA', CLIENT)).body as Client;
    expect(d.days).toBe(30);
    expect(d.scope).toBe('firm');
    expect(d.cases!.total).toBe(5);
    expect(counts(d)).toEqual({ draft: 1, submitted: 1, in_review: 1, delivered: 2 });
    expect(d.pages).toEqual({ processed: 157, cases: 3 });
    expect(d.spend).toEqual([
      { currency: 'AUD', amount: '10.00', payments: 1 },
      { currency: 'USD', amount: '350.00', payments: 2 },
    ]);

    const q = (await get('adminA', `${CLIENT}?days=90`)).body as Client;
    expect(q.pages).toEqual({ processed: 657, cases: 4 });
    expect(q.spend).toEqual([
      { currency: 'AUD', amount: '10.00', payments: 1 },
      { currency: 'USD', amount: '850.00', payments: 3 },
    ]);
  });

  it('client user: only own and shared cases and their pages, no spend', async () => {
    const x = (await get('x', `${CLIENT}?days=90`)).body as Client;
    expect(x.scope).toBe('own');
    expect(x.cases!.total).toBe(3);
    expect(counts(x)).toEqual({ submitted: 1, in_review: 1, delivered: 1 });
    expect(x.pages).toEqual({ processed: 620, cases: 2 });
    expect(x.spend).toBeNull();

    const y = (await get('y', CLIENT)).body as Client;
    expect(counts(y)).toEqual({ in_review: 1, delivered: 1 });
    expect(y.pages).toEqual({ processed: 30, cases: 1 });
  });

  it("never shows another firm's cases, pages or spend", async () => {
    const b = (await get('adminB', CLIENT)).body as Client;
    expect(b.cases!.total).toBe(2);
    expect(counts(b)).toEqual({ submitted: 1, delivered: 1 });
    expect(b.pages).toEqual({ processed: 999, cases: 1 });
    expect(b.spend).toEqual([{ currency: 'USD', amount: '444.00', payments: 1 }]);

    // a seeded firm's admin sees none of the synthetic firms' numbers
    const acme = (await get('acmeAdmin', `${CLIENT}?days=90`)).body as Client;
    const acmeCases = await prisma.case.count({ where: { organizationId: await orgId('acme') } });
    expect(acme.cases!.total).toBe(acmeCases);
    expect(acme.spend!.find((s) => s.amount === '444.00')).toBeUndefined();
  });

  it('returns aggregates only, never case or patient details', async () => {
    const body = JSON.stringify((await get('adminA', CLIENT)).body);
    expect(body).not.toContain(PATIENT);
    expect(body).not.toContain(`DSHC-${STAMP}`);
    expect(body).not.toContain('Synthetic v. Dashboard');
    expect(body).not.toMatch(/@/);
  });

  it('rejects a bad window', async () => {
    expect((await get('adminA', `${CLIENT}?days=0`)).status).toBe(400);
    expect((await get('adminA', `${CLIENT}?days=731`)).status).toBe(400);
  });
});
