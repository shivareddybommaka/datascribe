import { SEED_PLANS } from '@datascribe/db/seed';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, prisma } from './helpers';

const { app } = buildApp();

afterAll(async () => {
  await prisma.subscriptionPlan.deleteMany({
    where: { name: { startsWith: 'Retired test plan' } },
  });
});

describe('GET /api/v1/public/plans', () => {
  it('lists active plans without authentication, in sort order', async () => {
    const res = await request(app).get('/api/v1/public/plans');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const names = res.body.plans.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      [...SEED_PLANS].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.name),
    );

    const starter = res.body.plans.find((p: { name: string }) => p.name === 'Starter');
    expect(starter).toEqual({
      id: expect.any(String),
      name: 'Starter',
      priceMonthly: '499.00',
      currency: 'USD',
      includedPages: 500,
      overagePerPage: '0.9000',
      features: ['Medical index', 'Chronology', '5-day turnaround'],
    });
  });

  it('only exposes public fields', async () => {
    const res = await request(app).get('/api/v1/public/plans');
    for (const plan of res.body.plans) {
      expect(Object.keys(plan).sort()).toEqual(
        [
          'currency',
          'features',
          'id',
          'includedPages',
          'name',
          'overagePerPage',
          'priceMonthly',
        ].sort(),
      );
    }
  });

  it('hides inactive plans', async () => {
    const name = `Retired test plan ${Date.now()}`;
    await prisma.subscriptionPlan.create({
      data: { name, priceMonthly: '1.00', includedPages: 1, overagePerPage: '1', active: false },
    });
    const res = await request(app).get('/api/v1/public/plans');
    expect(res.body.plans.map((p: { name: string }) => p.name)).not.toContain(name);
  });

  it('is read-only', async () => {
    const res = await request(app).post('/api/v1/public/plans').send({ name: 'Free' });
    expect(res.status).toBe(404);
  });
});
