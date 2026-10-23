import { createOneOffInvoice, recordUsage } from '@datascribe/billing';
import type { Prisma } from '@datascribe/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD } from './constants';
import {
  SEED,
  bearer,
  buildApp,
  caseIdByNumber,
  login,
  orgId,
  prisma,
  uniqueEmail,
} from './helpers';

const { app, mailer, gateway, store } = buildApp();
const tok: Record<string, string> = {};
const get = (path: string, token: string) => request(app).get(path).set(bearer(token));
const post = (path: string, token: string, body: object = {}) =>
  request(app).post(path).set(bearer(token)).send(body);
const patch = (path: string, token: string, body: object) =>
  request(app).patch(path).set(bearer(token)).send(body);

let companyBefore: Prisma.JsonValue | undefined;

/** A fresh client firm with one client_admin, so tests don't depend on each other's data. */
async function makeFirm(label: string, currency = 'USD') {
  const org = await prisma.organization.create({
    data: { name: `${label} ${Date.now().toString(36)} (synthetic)`, type: 'client', currency },
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_admin' } });
  const email = uniqueEmail('billing-admin');
  await prisma.user.create({
    data: {
      email,
      name: `${label} Admin`,
      organizationId: org.id,
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  return { org, email, token: (await login(app, email)).token };
}

const plan = (name: string) => prisma.subscriptionPlan.findUniqueOrThrow({ where: { name } });

beforeAll(async () => {
  const roles = ['super_admin', 'finance', 'sales', 'ops_manager', 'case_manager', 'summarizer'];
  for (const role of roles) tok[role] = (await login(app, SEED.internal(role as never))).token;
  tok.acmeAdmin = (await login(app, SEED.acmeAdmin)).token;
  tok.acmeUser = (await login(app, SEED.acmeUser)).token;
  tok.harborAdmin = (await login(app, SEED.harborAdmin)).token;

  // GST 10% so the tax line is visible in assertions (restored afterwards)
  const company = await prisma.setting.findUnique({ where: { key: 'company' } });
  companyBefore = company?.value;
  await prisma.setting.upsert({
    where: { key: 'company' },
    update: {
      value: {
        name: 'Datascribe',
        address: '1 Example Street, Sydney NSW 2000',
        email: 'billing@datascribe.example',
        taxLabel: 'GST',
        taxRatePercent: 10,
      },
    },
    create: { key: 'company', value: { name: 'Datascribe', taxLabel: 'GST', taxRatePercent: 10 } },
  });
});

afterAll(async () => {
  if (companyBefore !== undefined) {
    await prisma.setting.update({
      where: { key: 'company' },
      data: { value: companyBefore as Prisma.InputJsonValue },
    });
  }
  await prisma.$disconnect();
});

describe('plans (§5.6: managed by finance / super_admin)', () => {
  it('any signed-in user can list active plans', async () => {
    const res = await get('/api/v1/plans', tok.acmeUser!);
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['Starter', 'Professional', 'Enterprise']),
    );
    expect(res.body.items[0]).toMatchObject({ priceMonthly: '499.00', overagePerPage: '0.9000' });
  });

  it('finance creates and edits plans; deactivated plans disappear for clients', async () => {
    const name = `Boutique ${Date.now()}`;
    const created = await post('/api/v1/plans', tok.finance!, {
      name,
      priceMonthly: '250',
      currency: 'usd',
      includedPages: 200,
      overagePerPage: 1.1,
      features: ['Index only'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      currency: 'USD',
      priceMonthly: '250.00',
      overagePerPage: '1.1000',
    });
    expect(
      (
        await post('/api/v1/plans', tok.super_admin!, {
          ...created.body,
          id: undefined,
          createdAt: undefined,
          updatedAt: undefined,
        })
      ).status,
    ).toBe(409);

    const off = await patch(`/api/v1/plans/${created.body.id}`, tok.finance!, { active: false });
    expect(off.status).toBe(200);
    const clientView = await get('/api/v1/plans', tok.acmeAdmin!);
    expect(clientView.body.items.some((p: { id: string }) => p.id === created.body.id)).toBe(false);
    const financeView = await get('/api/v1/plans?includeInactive=true', tok.finance!);
    expect(financeView.body.items.some((p: { id: string }) => p.id === created.body.id)).toBe(true);
    // clients can't use includeInactive to see hidden plans
    const sneaky = await get('/api/v1/plans?includeInactive=true', tok.acmeAdmin!);
    expect(sneaky.body.items.some((p: { id: string }) => p.id === created.body.id)).toBe(false);

    const audit = await prisma.auditLog.findMany({ where: { entityId: created.body.id } });
    expect(audit.map((a) => a.action).sort()).toEqual(['plan.create', 'plan.update']);
  });

  it('everyone else is refused, and input is validated', async () => {
    const body = { name: 'Nope', priceMonthly: '1', includedPages: 1, overagePerPage: '1' };
    for (const t of ['acmeAdmin', 'sales', 'ops_manager', 'case_manager']) {
      expect((await post('/api/v1/plans', tok[t]!, body)).status, t).toBe(403);
    }
    const bad = await post('/api/v1/plans', tok.finance!, { ...body, priceMonthly: '-5' });
    expect(bad.status).toBe(400);
    expect((await patch('/api/v1/plans/nope', tok.finance!, { active: false })).status).toBe(404);
  });
});

describe('subscriptions (§5.3, §5.6)', () => {
  it('client_admin sees their own firm’s plan and usage, never another firm’s', async () => {
    const res = await get('/api/v1/subscriptions/current', tok.acmeAdmin!);
    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(await orgId('acme'));
    expect(res.body.subscription.plan.name).toBe('Professional');
    expect(res.body.usage).toMatchObject({ includedPages: 2000 });
    const other = await get(
      `/api/v1/subscriptions/current?organizationId=${await orgId('harbor')}`,
      tok.acmeAdmin!,
    );
    expect(other.status).toBe(404);
    expect((await get('/api/v1/subscriptions/current', tok.acmeUser!)).status).toBe(403);
  });

  it('staff pick the firm; sales and ops can view but not change', async () => {
    expect((await get('/api/v1/subscriptions/current', tok.finance!)).status).toBe(400);
    const harbor = await orgId('harbor');
    for (const t of ['finance', 'sales', 'ops_manager']) {
      const res = await get(`/api/v1/subscriptions/current?organizationId=${harbor}`, tok[t]!);
      expect(res.status, t).toBe(200);
      expect(res.body.subscription.plan.name).toBe('Starter');
    }
    const list = await get('/api/v1/subscriptions', tok.sales!);
    expect(list.body.total).toBeGreaterThanOrEqual(2);
    const starter = await plan('Starter');
    for (const t of ['sales', 'ops_manager']) {
      expect(
        (
          await post('/api/v1/subscriptions/change', tok[t]!, {
            organizationId: harbor,
            planId: starter.id,
          })
        ).status,
      ).toBe(403);
    }
    expect((await get('/api/v1/subscriptions/current', tok.case_manager!)).status).toBe(403);
  });

  it('client_admin changes their own plan and cancels at period end; finance can do any firm', async () => {
    const { org, token } = await makeFirm('Plan Changer');
    const starter = await plan('Starter');
    const pro = await plan('Professional');

    const first = await post('/api/v1/subscriptions/change', token, { planId: starter.id });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.subscription.plan.name).toBe('Starter');
    const up = await post('/api/v1/subscriptions/change', token, { planId: pro.id });
    expect(up.body.subscription.id).toBe(first.body.subscription.id);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).planId).toBe(
      pro.id,
    );

    const cancel = await post('/api/v1/subscriptions/cancel', token, {});
    expect(cancel.body.subscription.cancelAtPeriodEnd).toBe(true);
    const resume = await post('/api/v1/subscriptions/cancel', token, { cancelAtPeriodEnd: false });
    expect(resume.body.subscription.cancelAtPeriodEnd).toBe(false);

    // another firm: 404 for the client admin, fine for finance
    const harbor = await orgId('harbor');
    expect(
      (
        await post('/api/v1/subscriptions/change', token, {
          organizationId: harbor,
          planId: pro.id,
        })
      ).status,
    ).toBe(404);
    const byFinance = await post('/api/v1/subscriptions/change', tok.finance!, {
      organizationId: org.id,
      planId: starter.id,
    });
    expect(byFinance.status).toBe(200);

    const actions = await prisma.auditLog.findMany({
      where: { organizationId: org.id, entity: 'Subscription' },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'subscription.change_plan',
        'subscription.cancel',
        'subscription.resume',
      ]),
    );
  });

  it('refuses inactive plans and plans in another currency', async () => {
    const { token } = await makeFirm('Rupee Firm', 'INR');
    const pro = await plan('Professional');
    const res = await post('/api/v1/subscriptions/change', token, { planId: pro.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('currency_mismatch');
    const hidden = await prisma.subscriptionPlan.create({
      data: {
        name: `Hidden ${Date.now()}`,
        priceMonthly: '1',
        currency: 'INR',
        includedPages: 1,
        overagePerPage: '1',
        active: false,
      },
    });
    expect(
      (await post('/api/v1/subscriptions/change', token, { planId: hidden.id })).body.error.code,
    ).toBe('invalid_plan');
    expect((await post('/api/v1/subscriptions/cancel', token, {})).status).toBe(404);
  });
});

describe('usage (§5.6: recorded per case on delivery)', () => {
  it('counts a case once, in the current period', async () => {
    const acme = await orgId('acme');
    const caseId = await caseIdByNumber('DS-SEED-0001');
    const first = await recordUsage(prisma, { organizationId: acme, caseId, pages: 120 });
    const again = await recordUsage(prisma, { organizationId: acme, caseId, pages: 120 });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, id: first.id });
    const res = await get('/api/v1/subscriptions/current', tok.acmeAdmin!);
    expect(res.body.usage.pagesUsed).toBeGreaterThanOrEqual(120);
  });

  it('rejects a case from another firm and silly page counts', async () => {
    const harborCase = await caseIdByNumber('DS-SEED-0003');
    await expect(
      recordUsage(prisma, { organizationId: await orgId('acme'), caseId: harborCase, pages: 5 }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      recordUsage(prisma, { organizationId: await orgId('acme'), pages: -1 }),
    ).rejects.toThrow(/whole number/);
  });

  it('manual entries are finance-only', async () => {
    const body = { organizationId: await orgId('acme'), pages: 1 };
    expect((await post('/api/v1/usage', tok.acmeAdmin!, body)).status).toBe(403);
    expect((await post('/api/v1/usage', tok.sales!, body)).status).toBe(403);
    expect(
      (await post('/api/v1/usage', tok.finance!, { ...body, organizationId: 'nope' })).status,
    ).toBe(404);
  });
});

describe('M8 DoD: monthly invoice with overage, paid through the gateway', () => {
  let firm: Awaited<ReturnType<typeof makeFirm>>;
  let subId: string;
  let invoiceId: string;

  beforeAll(async () => {
    firm = await makeFirm('Overage Firm');
    const pro = await plan('Professional');
    const sub = await prisma.subscription.create({
      data: {
        organizationId: firm.org.id,
        planId: pro.id,
        currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
      },
    });
    subId = sub.id;
    await recordUsage(prisma, {
      organizationId: firm.org.id,
      pages: 1500,
      at: new Date('2026-05-10T00:00:00Z'),
    });
    const manual = await post('/api/v1/usage', tok.finance!, {
      organizationId: firm.org.id,
      pages: 847,
    });
    expect(manual.status).toBe(201);
    // the manual entry is "now" (outside May); file it under May for this scenario
    await prisma.usageRecord.update({
      where: { id: manual.body.id },
      data: { periodStart: new Date('2026-05-01T00:00:00Z') },
    });
  });

  it('the monthly run issues plan fee + overage + GST with a sequential number', async () => {
    const run = await post('/api/v1/billing/run-invoicing', tok.finance!, {
      asOf: '2026-06-02T03:00:00Z',
    });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { subscriptionId: subId },
      include: { lines: { orderBy: { createdAt: 'asc' } } },
    });
    invoiceId = inv.id;
    expect(run.body.invoiceIds).toContain(inv.id);
    expect(inv.number).toMatch(/^INV-2026-\d{5}$/);
    expect(inv).toMatchObject({
      kind: 'subscription',
      status: 'issued',
      currency: 'USD',
      taxLabel: 'GST',
    });
    expect(
      inv.lines.map((l) => [l.quantity.toFixed(2), l.unitPrice.toFixed(4), l.amount.toFixed(2)]),
    ).toEqual([
      ['1.00', '1499.0000', '1499.00'],
      ['347.00', '0.7500', '260.25'],
    ]);
    expect([inv.subtotal.toFixed(2), inv.tax.toFixed(2), inv.total.toFixed(2)]).toEqual([
      '1759.25',
      '175.93',
      '1935.18',
    ]);
    expect(inv.dueAt?.toISOString()).toBe('2026-06-16T00:00:00.000Z');
    expect(store.objects.has(inv.pdfS3Key!)).toBe(true);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.currentPeriodStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(sub.currentPeriodEnd.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('re-running the job does not bill the same period twice', async () => {
    await post('/api/v1/billing/run-invoicing', tok.finance!, { asOf: '2026-06-02T04:00:00Z' });
    expect(await prisma.invoice.count({ where: { subscriptionId: subId } })).toBe(1);
  });

  it('only staff with finance rights can trigger runs', async () => {
    for (const t of ['acmeAdmin', 'sales', 'ops_manager']) {
      expect((await post('/api/v1/billing/run-invoicing', tok[t]!, {})).status, t).toBe(403);
      expect((await post('/api/v1/billing/run-dunning', tok[t]!, {})).status, t).toBe(403);
    }
  });

  it('client_admin starts a checkout; the signed webhook marks the invoice paid exactly once', async () => {
    const pay = await post(`/api/v1/invoices/${invoiceId}/pay`, firm.token);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body).toMatchObject({ gateway: 'fake' });
    expect(pay.body.url).toContain('/api/v1/payments/fake-checkout/fcs_');
    expect(gateway.checkouts.at(-1)).toMatchObject({
      invoiceId,
      amount: '1935.18',
      currency: 'USD',
    });

    const hook = gateway.webhook({
      invoiceId,
      amount: '1935.18',
      currency: 'USD',
      paymentRef: 'fpi_dod',
    });
    const send = () =>
      request(app).post('/api/v1/payments/webhook/stripe').set(hook.headers).send(hook.body);
    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.outcome).toBe('recorded');
    const second = await send();
    expect(second.body.outcome).toBe('duplicate');

    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    expect(inv.status).toBe('paid');
    expect(inv.paidAt).toBeTruthy();
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0]).toMatchObject({
      gateway: 'fake',
      gatewayRef: 'fpi_dod',
      status: 'succeeded',
    });
    const audit = await prisma.auditLog.count({
      where: { action: 'payment.succeeded', entityId: inv.payments[0]!.id },
    });
    expect(audit).toBe(1);

    expect((await post(`/api/v1/invoices/${invoiceId}/pay`, firm.token)).status).toBe(409);
  });

  it('rejects unsigned, forged and tampered webhooks', async () => {
    const hook = gateway.webhook({ invoiceId, amount: '1.00', currency: 'USD' });
    const url = '/api/v1/payments/webhook/stripe';
    expect(
      (await request(app).post(url).set('content-type', 'application/json').send(hook.body)).status,
    ).toBe(400);
    const tampered = hook.body.replace('"1.00"', '"9.00"');
    const res = await request(app).post(url).set(hook.headers).send(tampered);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_signature');
    // a valid signature for an unknown invoice is acknowledged and ignored
    const unknown = gateway.webhook({ invoiceId: 'cnope', amount: '1.00', currency: 'USD' });
    const ok = await request(app).post(url).set(unknown.headers).send(unknown.body);
    expect(ok.body.outcome).toBe('ignored');
  });

  it('client users and sales cannot pay; other firms get 404', async () => {
    expect((await post(`/api/v1/invoices/${invoiceId}/pay`, tok.acmeUser!)).status).toBe(403);
    expect((await post(`/api/v1/invoices/${invoiceId}/pay`, tok.sales!)).status).toBe(403);
    expect((await post(`/api/v1/invoices/${invoiceId}/pay`, tok.acmeAdmin!)).status).toBe(404);
  });

  it('finance refunds part, then the rest; the invoice ends refunded', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId } });
    const url = `/api/v1/payments/${payment.id}/refund`;
    expect((await post(url, tok.sales!, { reason: 'x' })).status).toBe(403);
    expect((await post(url, firm.token, { reason: 'x' })).status).toBe(403);
    expect((await post(url, tok.finance!, {})).status).toBe(400); // reason required
    expect(
      (await post(url, tok.finance!, { amount: '5000', reason: 'too much' })).body.error.code,
    ).toBe('invalid_amount');

    gateway.failNextRefund = true;
    const declined = await post(url, tok.finance!, { amount: '10', reason: 'goodwill' });
    expect(declined.status).toBe(502);
    expect(
      (
        await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
      ).refundedAmount.toFixed(2),
    ).toBe('0.00');

    const part = await post(url, tok.finance!, { amount: '100', reason: 'goodwill' });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(part.body.payment).toMatchObject({ status: 'succeeded', refundedAmount: '100.00' });
    expect(part.body.invoiceStatus).toBe('paid');

    const rest = await post(url, tok.finance!, { reason: 'cancelled engagement' });
    expect(rest.body.payment).toMatchObject({ status: 'refunded', refundedAmount: '1935.18' });
    expect(rest.body.invoiceStatus).toBe('refunded');
    expect(gateway.refunds.slice(-2).map((r) => r.amount)).toEqual(['100.00', '1835.18']);
    expect((await post(url, tok.finance!, { reason: 'again' })).status).toBe(409);
    expect(
      await prisma.auditLog.count({ where: { action: 'payment.refund', entityId: payment.id } }),
    ).toBe(2);
  });

  it('the simulated checkout page pays through the same webhook path', async () => {
    const inv = await createOneOffInvoice(prisma, {
      organizationId: firm.org.id,
      lines: [{ description: 'Rush fee', quantity: 1, unitPrice: '99' }],
    });
    const pay = await post(`/api/v1/invoices/${inv.id}/pay`, firm.token);
    const path = new URL(pay.body.url).pathname;
    const page = await request(app).get(path);
    expect(page.status).toBe(200);
    expect(page.text).toContain(inv.number);
    const done = await request(app).post(`${path}/complete`);
    expect(done.text).toContain('Payment received');
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('paid');
    expect((await request(app).get('/api/v1/payments/fake-checkout/fcs_nope_x')).status).toBe(404);
  });
});

describe('one-off invoices, PDF, void (§5.6)', () => {
  it('finance issues one-off invoices with consecutive numbers', async () => {
    const acme = await orgId('acme');
    const body = {
      organizationId: acme,
      notes: 'Thank you',
      lines: [
        { description: 'Expert deposition prep', quantity: 2, unitPrice: '150' },
        { description: 'Courier', quantity: '1', unitPrice: 12.5 },
      ],
    };
    const a = await post('/api/v1/invoices', tok.finance!, body);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      kind: 'one_off',
      subtotal: '312.50',
      tax: '31.25',
      total: '343.75',
    });
    expect(a.body.lines).toHaveLength(2);
    const b = await post('/api/v1/invoices', tok.super_admin!, body);
    const n = (s: string) => Number(s.split('-').at(-1));
    expect(n(b.body.number)).toBe(n(a.body.number) + 1);
    expect(
      await prisma.auditLog.count({ where: { action: 'invoice.create', entityId: a.body.id } }),
    ).toBe(1);
  });

  it('numbers stay unique and gap-free under concurrency', async () => {
    const acme = await orgId('acme');
    const made = await Promise.all(
      Array.from({ length: 6 }, () =>
        createOneOffInvoice(prisma, {
          organizationId: acme,
          lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
        }),
      ),
    );
    const nums = made.map((i) => Number(i.number.split('-').at(-1))).sort((x, y) => x - y);
    expect(new Set(nums).size).toBe(6);
    expect(nums.at(-1)! - nums[0]!).toBe(5);
  });

  it('refuses non-finance users and bad input', async () => {
    const acme = await orgId('acme');
    const body = { organizationId: acme, lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] };
    for (const t of ['acmeAdmin', 'sales', 'ops_manager']) {
      expect((await post('/api/v1/invoices', tok[t]!, body)).status, t).toBe(403);
    }
    expect((await post('/api/v1/invoices', tok.finance!, { ...body, lines: [] })).status).toBe(400);
    expect(
      (
        await post('/api/v1/invoices', tok.finance!, {
          ...body,
          organizationId: await orgId('internal'),
        })
      ).status,
    ).toBe(404);
  });

  it('serves the PDF to whoever can see the invoice', async () => {
    const inv = await createOneOffInvoice(prisma, {
      organizationId: await orgId('acme'),
      lines: [{ description: 'Records retrieval', quantity: 1, unitPrice: '75' }],
    });
    const res = await get(`/api/v1/invoices/${inv.id}/pdf`, tok.acmeAdmin!)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(`/api/v1/invoices/${inv.id}/pdf`, tok.harborAdmin!)).status).toBe(404);
  });

  it('finance voids an unpaid invoice with a reason; it can no longer be paid', async () => {
    const inv = await createOneOffInvoice(prisma, {
      organizationId: await orgId('acme'),
      lines: [{ description: 'Mistake', quantity: 1, unitPrice: '10' }],
    });
    expect((await post(`/api/v1/invoices/${inv.id}/void`, tok.finance!, {})).status).toBe(400);
    expect(
      (await post(`/api/v1/invoices/${inv.id}/void`, tok.acmeAdmin!, { reason: 'x' })).status,
    ).toBe(403);
    const v = await post(`/api/v1/invoices/${inv.id}/void`, tok.finance!, { reason: 'duplicate' });
    expect(v.body.status).toBe('void');
    expect((await post(`/api/v1/invoices/${inv.id}/pay`, tok.acmeAdmin!)).status).toBe(409);
    expect(
      (await post(`/api/v1/invoices/${inv.id}/void`, tok.finance!, { reason: 'again' })).status,
    ).toBe(409);
  });
});

describe('invoice visibility (§4.3: finance F, client_admin firm, sales/ops view, others none)', () => {
  it('client_admin lists only their firm; staff with view see all; others are refused', async () => {
    const acme = await orgId('acme');
    const a = await get('/api/v1/invoices?limit=500', tok.acmeAdmin!);
    expect(a.status).toBe(200);
    expect(a.body.items.length).toBeGreaterThan(0);
    expect(a.body.items.every((i: { organizationId: string }) => i.organizationId === acme)).toBe(
      true,
    );
    // a client asking for another firm's invoices by filter gets nothing
    const sneaky = await get(
      `/api/v1/invoices?organizationId=${await orgId('harbor')}`,
      tok.acmeAdmin!,
    );
    expect(sneaky.body.items).toEqual([]);

    for (const t of ['finance', 'sales', 'ops_manager', 'super_admin']) {
      const res = await get('/api/v1/invoices?limit=500', tok[t]!);
      expect(res.status, t).toBe(200);
      expect(
        new Set(res.body.items.map((i: { organizationId: string }) => i.organizationId)).size,
      ).toBeGreaterThan(1);
    }
    for (const t of ['acmeUser', 'case_manager', 'summarizer']) {
      expect((await get('/api/v1/invoices', tok[t]!)).status, t).toBe(403);
      expect((await get('/api/v1/payments', tok[t]!)).status, t).toBe(403);
    }
  });

  it('detail shows payments only to roles holding payments:view', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { payments: { some: {} } } });
    const fin = await get(`/api/v1/invoices/${inv.id}`, tok.finance!);
    expect(fin.body.payments.length).toBeGreaterThan(0);
    expect(fin.body.lines.length).toBeGreaterThan(0);
  });
});

describe('dunning (§5.6: due date, +7, +14 days; Mailpit only)', () => {
  it('emails the firm’s client admins once per stage and marks the invoice overdue', async () => {
    const firm = await makeFirm('Slow Payer');
    const inv = await createOneOffInvoice(prisma, {
      organizationId: firm.org.id,
      lines: [{ description: 'Summary', quantity: 1, unitPrice: '400' }],
      now: new Date('2026-07-01T09:00:00Z'),
      dueDays: 14,
    });
    expect(inv.dueAt?.toISOString()).toBe('2026-07-15T00:00:00.000Z');
    const run = (asOf: string) => post('/api/v1/billing/run-dunning', tok.finance!, { asOf });
    const mailsTo = () => mailer.sent.filter((m) => m.to === firm.email);

    await run('2026-07-14T10:00:00Z');
    expect(mailsTo()).toHaveLength(0);

    await run('2026-07-15T10:00:00Z');
    expect(mailsTo().map((m) => m.subject)).toEqual([`Invoice ${inv.number} is due today`]);
    await run('2026-07-15T18:00:00Z');
    expect(mailsTo()).toHaveLength(1);

    await run('2026-07-22T10:00:00Z');
    expect(mailsTo().at(-1)!.subject).toBe(`Reminder: invoice ${inv.number} is 7 days overdue`);
    expect(mailsTo().at(-1)!.text).toContain(`/portal/billing/invoices/${inv.id}`);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(
      'overdue',
    );

    await run('2026-07-29T10:00:00Z');
    await run('2026-08-30T10:00:00Z');
    expect(mailsTo().map((m) => m.subject.split(' is ')[1])).toEqual([
      'due today',
      '7 days overdue',
      '14 days overdue',
    ]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).remindersSent).toBe(
      3,
    );
  });

  it('paid invoices get no reminders', async () => {
    const firm = await makeFirm('Prompt Payer');
    const inv = await createOneOffInvoice(prisma, {
      organizationId: firm.org.id,
      lines: [{ description: 'Index', quantity: 1, unitPrice: '50' }],
      now: new Date('2026-07-01T09:00:00Z'),
    });
    const hook = gateway.webhook({
      invoiceId: inv.id,
      amount: inv.total.toFixed(2),
      currency: 'USD',
    });
    await request(app).post('/api/v1/payments/webhook/stripe').set(hook.headers).send(hook.body);
    await post('/api/v1/billing/run-dunning', tok.finance!, { asOf: '2026-07-20T10:00:00Z' });
    expect(mailer.sent.filter((m) => m.to === firm.email)).toHaveLength(0);
  });
});

describe('cancel at period end', () => {
  it('the last period is invoiced, then the subscription ends', async () => {
    const firm = await makeFirm('Leaving Firm');
    const starter = await plan('Starter');
    const sub = await prisma.subscription.create({
      data: {
        organizationId: firm.org.id,
        planId: starter.id,
        currentPeriodStart: new Date('2026-03-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
        cancelAtPeriodEnd: true,
      },
    });
    await post('/api/v1/billing/run-invoicing', tok.finance!, { asOf: '2026-05-15T00:00:00Z' });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('canceled');
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: sub.id } });
    expect(invoices).toHaveLength(1); // March only; no April invoice after cancellation
    expect(invoices[0]!.total.toFixed(2)).toBe('548.90'); // 499 + 10% GST
  });

  it('a subscription behind by two periods is caught up one invoice per period', async () => {
    const firm = await makeFirm('Catch Up Firm');
    const starter = await plan('Starter');
    const sub = await prisma.subscription.create({
      data: {
        organizationId: firm.org.id,
        planId: starter.id,
        currentPeriodStart: new Date('2026-01-31T00:00:00Z'),
        currentPeriodEnd: new Date('2026-02-28T00:00:00Z'),
      },
    });
    await post('/api/v1/billing/run-invoicing', tok.finance!, { asOf: '2026-04-01T00:00:00Z' });
    const invoices = await prisma.invoice.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { periodStart: 'asc' },
    });
    expect(invoices.map((i) => i.periodStart?.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.currentPeriodStart.toISOString().slice(0, 10)).toBe('2026-03-28');
  });
});
