import { encrypt } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma } from './helpers';

/** M6 part 5b (§5.4, D-099): clients download the delivered report and never see drafts. */
const { app } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) =>
  request(app).get(`/api/v1${path}`).set(bearer(tokens[who]!));

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ids = { delivered: '', review: '' };
const enc = (v: string) => encrypt(v, testPhiKey);
const content = enc(JSON.stringify({ kind: 'summary', sections: [], provider: 'template' }));
const reportKey = () => `reports/test/${ids.delivered}/DSR-${STAMP}-s2c1.pdf`;

beforeAll(async () => {
  const acme = await orgId('acme');
  const creator = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
  const kase = (key: string, status: 'delivered' | 'in_review') =>
    prisma.case.create({
      data: {
        organizationId: acme,
        number: `DSR-${STAMP}-${key}`,
        matterName: `Synthetic Report Matter ${STAMP}`,
        patientName: enc('Riley Synthetic'),
        caseType: 'personal_injury',
        requested: ['chronology', 'summary'],
        createdById: creator.id,
        submittedAt: new Date(),
        status,
        deliveredAt: status === 'delivered' ? new Date() : null,
      },
    });
  ids.delivered = (await kase('delivered', 'delivered')).id;
  ids.review = (await kase('review', 'in_review')).id;
  await prisma.deliverable.createMany({
    data: [
      // an older approved draft stays staff-only; the delivered versions carry the report key
      { caseId: ids.delivered, type: 'summary', version: 1, status: 'approved', content },
      {
        caseId: ids.delivered,
        type: 'summary',
        version: 2,
        status: 'delivered',
        content,
        lockedAt: new Date(),
        pdfS3Key: reportKey(),
      },
      {
        caseId: ids.delivered,
        type: 'chronology',
        status: 'delivered',
        content,
        lockedAt: new Date(),
        pdfS3Key: reportKey(),
      },
      { caseId: ids.review, type: 'summary', content },
    ],
  });
  for (const [k, email] of Object.entries({
    client: SEED.acmeUser,
    harbor: SEED.harborAdmin,
    ops: SEED.internal('ops_manager'),
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  const caseIds = Object.values(ids);
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.$disconnect();
});

describe('GET /cases/:id/deliverables', () => {
  it('shows clients only delivered versions', async () => {
    const review = await get('client', `/cases/${ids.review}/deliverables`).expect(200);
    expect(review.body.items).toEqual([]);
    const done = await get('client', `/cases/${ids.delivered}/deliverables`).expect(200);
    expect(
      done.body.items.map((d: { type: string; version: number }) => [d.type, d.version]),
    ).toEqual([
      ['chronology', 1],
      ['summary', 2],
    ]);
  });

  it('shows staff every version', async () => {
    const review = await get('ops', `/cases/${ids.review}/deliverables`).expect(200);
    expect(review.body.items).toHaveLength(1);
    const done = await get('ops', `/cases/${ids.delivered}/deliverables`).expect(200);
    expect(done.body.items).toHaveLength(3);
  });
});

describe('GET /cases/:id/report/download-url', () => {
  it('gives the client a short-lived signed URL to the report, audited', async () => {
    const detail = await get('client', `/cases/${ids.delivered}`).expect(200);
    expect(detail.body.can.downloadReport).toBe(true);
    const res = await get('client', `/cases/${ids.delivered}/report/download-url`).expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const url = new URL(res.body.url);
    expect(decodeURIComponent(url.pathname)).toContain(reportKey());
    expect(decodeURIComponent(url.search)).toContain(`DSR-${STAMP}-delivered-report.pdf`);
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'report.download', entityId: ids.delivered },
    });
    expect(audit?.metadata).toEqual({ deliverableId: expect.any(String) });
  });

  it('works for staff too', async () => {
    await get('ops', `/cases/${ids.delivered}/report/download-url`).expect(200);
  });

  it('is 404 before delivery and for other firms', async () => {
    const detail = await get('client', `/cases/${ids.review}`).expect(200);
    expect(detail.body.can.downloadReport).toBe(false);
    await get('client', `/cases/${ids.review}/report/download-url`).expect(404);
    await get('harbor', `/cases/${ids.delivered}/report/download-url`).expect(404);
  });
});
