import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED, bearer, buildApp, login, prisma } from './helpers';

const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) => request(app).get(path).set(bearer(tokens[who]!));

const SALES = SEED.internal('sales');
const OPS = SEED.internal('ops_manager');
const CM = SEED.internal('case_manager');
const FIN = SEED.internal('finance');

// a source and a currency no other test uses, so parallel test files can't move these numbers
const SOURCE = `dash_${Math.random().toString(36).slice(2, 8)}`;
const XTS = 'XTS';

beforeAll(async () => {
  for (const email of [SALES, OPS, CM, FIN, SEED.acmeAdmin]) {
    tokens[email] = (await login(app, email)).token;
  }
});
afterAll(async () => {
  await prisma.lead.deleteMany({ where: { source: SOURCE } });
  await prisma.$disconnect();
});

type Sales = {
  days: number;
  pipeline: { stage: string; count: number; value: { currency: string; amount: string }[] }[];
  conversion: { created: number; won: number; lost: number; rate: number | null };
  sources: { source: string; count: number }[];
};
const xts = (body: Sales, stage: string) =>
  body.pipeline.find((p) => p.stage === stage)!.value.find((v) => v.currency === XTS)?.amount;

describe('GET /dashboards/sales', () => {
  it('is for sales and ops (dashboard_sales), not other staff or clients', async () => {
    for (const who of [SALES, OPS]) {
      expect((await get(who, '/api/v1/dashboards/sales')).status, who).toBe(200);
    }
    for (const who of [CM, FIN, SEED.acmeAdmin]) {
      expect((await get(who, '/api/v1/dashboards/sales')).status, who).toBe(403);
    }
    expect((await request(app).get('/api/v1/dashboards/sales')).status).toBe(401);
  });

  it('sums pipeline value per stage and currency, conversion and sources', async () => {
    const before = (await get(SALES, '/api/v1/dashboards/sales')).body as Sales;
    const old = new Date(Date.now() - 200 * 86_400_000);
    const lead = (stage: string, value: number | null, createdAt?: Date) => ({
      source: SOURCE,
      companyName: 'Synthetic Dashboard LLP',
      contactName: 'Pat Example',
      stage: stage as 'new',
      value,
      currency: XTS,
      ...(createdAt ? { createdAt } : {}),
    });
    await prisma.lead.createMany({
      data: [
        lead('qualified', 1000),
        lead('qualified', 250.5),
        lead('proposal', null),
        lead('won', 4000),
        lead('lost', 100),
        lead('won', 900, old), // outside the 90-day window: pipeline yes, conversion no
      ],
    });

    const res = await get(SALES, '/api/v1/dashboards/sales');
    expect(res.status).toBe(200);
    const after = res.body as Sales;
    expect(after.days).toBe(90);
    expect(after.pipeline.map((p) => p.stage)).toEqual([
      'new',
      'contacted',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
    expect(xts(after, 'qualified')).toBe('1250.50');
    expect(xts(after, 'won')).toBe('4900.00');
    expect(xts(after, 'proposal')).toBeUndefined(); // no value: counted, not summed
    const count = (b: Sales, stage: string) => b.pipeline.find((p) => p.stage === stage)!.count;
    expect(count(after, 'proposal') - count(before, 'proposal')).toBeGreaterThanOrEqual(1);

    expect(after.sources.find((s) => s.source === SOURCE)?.count).toBe(5);
    expect(after.conversion.created - before.conversion.created).toBeGreaterThanOrEqual(5);
    expect(after.conversion.won - before.conversion.won).toBeGreaterThanOrEqual(1);

    // a wider window takes in the old lead
    const year = (await get(SALES, '/api/v1/dashboards/sales?days=365')).body as Sales;
    expect(year.sources.find((s) => s.source === SOURCE)?.count).toBe(6);
  });

  it('returns aggregates only, never lead details', async () => {
    const res = await get(SALES, '/api/v1/dashboards/sales');
    expect(JSON.stringify(res.body)).not.toMatch(/Synthetic Dashboard|Pat Example|@/);
  });

  it('rejects a bad window', async () => {
    expect((await get(SALES, '/api/v1/dashboards/sales?days=0')).status).toBe(400);
    expect((await get(SALES, '/api/v1/dashboards/sales?days=abc')).status).toBe(400);
  });
});
