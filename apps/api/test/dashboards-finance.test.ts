import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED, bearer, buildApp, login, prisma } from './helpers';

const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) => request(app).get(path).set(bearer(tokens[who]!));

const D = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * D);
const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// a currency no other test (or an earlier, interrupted run) uses, so every total below is exact
const CUR = `Q${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(
  65 + Math.floor(Math.random() * 26),
)}`;
const FINANCE = '/api/v1/dashboards/finance';

const orgs: { id: string; name: string }[] = [];
let planId = '';
let n = 0;

async function invoice(
  org: number,
  status: 'draft' | 'issued' | 'paid' | 'void' | 'overdue',
  total: string,
  extra: { dueAt?: Date; paidAt?: Date; refunded?: string } = {},
) {
  const i = n++;
  const inv = await prisma.invoice.create({
    data: {
      organizationId: orgs[org]!.id,
      number: `DSHF-${STAMP}-${i}`,
      status,
      subtotal: total,
      tax: '0',
      total,
      currency: CUR,
      issuedAt: status === 'draft' ? null : ago(30),
      dueAt: extra.dueAt,
      paidAt: extra.paidAt,
    },
  });
  if (status === 'paid') {
    await prisma.payment.create({
      data: {
        invoiceId: inv.id,
        gateway: 'fake',
        gatewayRef: `dash_${STAMP}_${i}`,
        amount: total,
        currency: CUR,
        status: 'succeeded',
        refundedAmount: extra.refunded ?? '0',
      },
    });
  }
}

beforeAll(async () => {
  for (let i = 0; i < 15; i++) {
    const name = `Synthetic Firm ${STAMP} ${String(i).padStart(2, '0')}`;
    orgs.push(await prisma.organization.create({ data: { name, type: 'client', currency: CUR } }));
  }
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Dashboard plan ${STAMP}`,
      priceMonthly: '199.50',
      currency: CUR,
      includedPages: 100,
      overagePerPage: '0.1',
      active: false,
    },
  });
  planId = plan.id;
  const period = { currentPeriodStart: ago(10), currentPeriodEnd: ago(-20) };
  for (const [org, status] of [
    [0, 'active'],
    [1, 'trialing'],
    [2, 'canceled'],
    [3, 'past_due'],
  ] as const) {
    await prisma.subscription.create({
      data: { organizationId: orgs[org]!.id, planId, status, ...period },
    });
  }

  await invoice(0, 'issued', '100.00', { dueAt: ago(-10) });
  await invoice(0, 'issued', '20.00', { dueAt: ago(1) }); // past due, not yet marked overdue
  await invoice(1, 'overdue', '50.25', { dueAt: ago(5) });
  await invoice(0, 'draft', '999.00');
  await invoice(1, 'void', '77.00');
  await invoice(0, 'paid', '300.00', { paidAt: ago(1) });
  await invoice(1, 'paid', '80.00', { paidAt: ago(2), refunded: '30.00' }); // net 50
  await invoice(2, 'paid', '500.00', { paidAt: ago(200) }); // outside the 90-day window
  for (let org = 4; org < 15; org++) await invoice(org, 'paid', '1.00', { paidAt: ago(3) });

  for (const [k, email] of Object.entries({
    ops: SEED.internal('ops_manager'),
    finance: SEED.internal('finance'),
    sales: SEED.internal('sales'),
    cm: SEED.internal('case_manager'),
    acmeAdmin: SEED.acmeAdmin,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  const invoices = { number: { startsWith: `DSHF-${STAMP}-` } };
  await prisma.payment.deleteMany({ where: { invoice: invoices } });
  await prisma.invoice.deleteMany({ where: invoices });
  await prisma.subscription.deleteMany({ where: { planId } });
  await prisma.subscriptionPlan.delete({ where: { id: planId } });
  await prisma.organization.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
  await prisma.$disconnect();
});

type Money = { currency: string; amount: string };
type Finance = {
  days: number;
  mrr: (Money & { subscriptions: number })[];
  subscriptions: { status: string; count: number }[];
  outstanding: (Money & { count: number })[];
  overdue: (Money & { count: number })[];
  revenue: {
    total: Money[];
    byClient: (Money & { organizationId: string | null; name: string | null; payments: number })[];
  };
};
const mine = <T extends { currency: string }>(rows: T[]) => rows.filter((r) => r.currency === CUR);

describe('GET /dashboards/finance', () => {
  it('is for finance and ops managers (dashboard_finance), not other staff or clients', async () => {
    for (const who of ['finance', 'ops']) {
      expect((await get(who, FINANCE)).status, who).toBe(200);
    }
    for (const who of ['sales', 'cm', 'acmeAdmin']) {
      expect((await get(who, FINANCE)).status, who).toBe(403);
    }
    expect((await request(app).get(FINANCE)).status).toBe(401);
  });

  it('MRR from live subscriptions, outstanding and overdue invoices per currency', async () => {
    const res = await get('finance', FINANCE);
    expect(res.status).toBe(200);
    const d = res.body as Finance;
    expect(d.days).toBe(90);
    // active + trialing + past_due at 199.50; the canceled one doesn't count
    expect(mine(d.mrr)).toEqual([{ currency: CUR, amount: '598.50', subscriptions: 3 }]);
    expect(d.subscriptions.map((s) => s.status)).toEqual([
      'trialing',
      'active',
      'past_due',
      'canceled',
    ]);
    expect(mine(d.outstanding)).toEqual([{ currency: CUR, count: 3, amount: '170.25' }]);
    expect(mine(d.overdue)).toEqual([{ currency: CUR, count: 2, amount: '70.25' }]);
  });

  it('revenue by client, net of refunds, top ten then the rest', async () => {
    const d = (await get('finance', FINANCE)).body as Finance;
    expect(mine(d.revenue.total)).toEqual([{ currency: CUR, amount: '361.00' }]);
    const rows = mine(d.revenue.byClient);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toEqual({
      organizationId: orgs[0]!.id,
      name: orgs[0]!.name,
      currency: CUR,
      amount: '300.00',
      payments: 1,
    });
    expect(rows[1]).toMatchObject({ organizationId: orgs[1]!.id, amount: '50.00' });
    expect(rows.at(-1)).toEqual({
      organizationId: null,
      name: null,
      currency: CUR,
      amount: '3.00',
      payments: 3,
    });

    const year = (await get('finance', `${FINANCE}?days=365`)).body as Finance;
    expect(mine(year.revenue.total)).toEqual([{ currency: CUR, amount: '861.00' }]);
    expect(mine(year.revenue.byClient)[0]).toMatchObject({
      organizationId: orgs[2]!.id,
      amount: '500.00',
    });
  });

  it('returns aggregates only, never invoice details', async () => {
    const body = JSON.stringify((await get('ops', FINANCE)).body);
    expect(body).not.toContain(`DSHF-${STAMP}`);
    expect(body).not.toContain(`dash_${STAMP}`);
    expect(body).not.toMatch(/@/);
  });

  it('rejects a bad window', async () => {
    expect((await get('finance', `${FINANCE}?days=0`)).status).toBe(400);
    expect((await get('finance', `${FINANCE}?days=731`)).status).toBe(400);
  });
});
