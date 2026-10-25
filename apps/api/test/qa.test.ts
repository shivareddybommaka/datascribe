import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

/** M6 part 4 (§5.4, D-088): submit for QA, approve / request changes. Synthetic data only. */
const { app } = buildApp();
const tokens: Record<string, string> = {};
const post = (who: string, path: string, body: object = {}) =>
  request(app).post(`/api/v1${path}`).set(bearer(tokens[who]!)).send(body);
const get = (who: string, path: string) =>
  request(app).get(`/api/v1${path}`).set(bearer(tokens[who]!));

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const users: Record<string, { id: string; email: string }> = {};
const ids = { case: '', noQa: '', uncited: '', doc: '' };
const enc = (v: string) => encrypt(v, testPhiKey);

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

const chronology = (description: string, documentId: string, cited = true) => ({
  kind: 'chronology',
  entries: [
    {
      date: '2026-03-01',
      provider: null,
      facility: 'Synthetic General',
      eventType: 'er',
      description,
      codes: [],
      ...(cited
        ? { citation: { documentId, fileName: 'synthetic-records.pdf', pageNumber: 1 } }
        : {}),
    },
  ],
});
const summary = {
  kind: 'summary',
  sections: [{ heading: 'Overview', paragraphs: ['Synthetic overview.'] }],
  provider: 'template',
};

beforeAll(async () => {
  users.sum = await makeStaff('summarizer', 'Synthetic QA Summarizer');
  users.qa = await makeStaff('qa_reviewer', 'Synthetic QA Reviewer');
  users.qa2 = await makeStaff('qa_reviewer', 'Synthetic Other Reviewer');

  const acme = await orgId('acme');
  const creator = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
  const kase = async (key: string, data: Record<string, unknown>) => {
    const c = await prisma.case.create({
      data: {
        organizationId: acme,
        number: `DSQ-${STAMP}-${key}`,
        matterName: `Synthetic QA Matter ${STAMP}`,
        patientName: enc('Riley Synthetic'),
        caseType: 'personal_injury',
        requested: ['chronology', 'summary'],
        createdById: creator.id,
        submittedAt: new Date(),
        status: 'in_review',
        summarizerId: users.sum!.id,
        ...data,
      },
    });
    const doc = await prisma.document.create({
      data: {
        organizationId: acme,
        caseId: c.id,
        fileName: 'synthetic-records.pdf',
        s3Key: `test/qa/${STAMP}/${key}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024n,
        pageCount: 2,
        scanStatus: 'clean',
        uploadedById: creator.id,
        uploadedAt: new Date(),
      },
    });
    return { id: c.id, doc: doc.id };
  };
  const main = await kase('main', { qaReviewerId: users.qa.id });
  ids.case = main.id;
  ids.doc = main.doc;
  const noQa = await kase('noqa', {});
  ids.noQa = noQa.id;
  const uncited = await kase('uncited', { qaReviewerId: users.qa.id });
  ids.uncited = uncited.id;

  const content = (v: unknown) => enc(JSON.stringify(v));
  await prisma.deliverable.createMany({
    data: [
      { caseId: main.id, type: 'chronology', content: content(chronology('ER', main.doc)) },
      { caseId: main.id, type: 'summary', content: content(summary) },
      { caseId: noQa.id, type: 'summary', content: content(summary) },
      {
        caseId: uncited.id,
        type: 'chronology',
        content: content(chronology('ER', uncited.doc, false)),
      },
    ],
  });

  for (const [k, email] of Object.entries({
    sum: users.sum.email,
    qa: users.qa.email,
    qa2: users.qa2.email,
    acmeAdmin: SEED.acmeAdmin,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  const caseIds = [ids.case, ids.noQa, ids.uncited];
  await prisma.notification.deleteMany({
    where: { userId: { in: Object.values(users).map((u) => u.id) } },
  });
  await prisma.document.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.$disconnect();
});

const statuses = async (caseId: string) =>
  (
    await prisma.deliverable.findMany({
      where: { caseId },
      orderBy: [{ type: 'asc' }, { version: 'asc' }],
    })
  ).map((d) => [d.type, d.version, d.status, !!d.lockedAt]);

describe('POST /cases/:id/submit-qa', () => {
  it('needs a QA reviewer and a citation on every chronology entry', async () => {
    const noQa = await post('sum', `/cases/${ids.noQa}/submit-qa`);
    expect(noQa.status).toBe(409);
    expect(noQa.body.error.code).toBe('no_qa_reviewer');

    const uncited = await post('sum', `/cases/${ids.uncited}/submit-qa`);
    expect(uncited.status).toBe(409);
    expect(uncited.body.error.code).toBe('not_ready');
    expect(uncited.body.error.message).toBe('1 chronology entry has no source citation');
    expect((await prisma.case.findUniqueOrThrow({ where: { id: ids.uncited } })).status).toBe(
      'in_review',
    );
  });

  it('is for staff who may edit the drafts', async () => {
    expect((await post('qa', `/cases/${ids.case}/submit-qa`)).status).toBe(403);
    expect([403, 404]).toContain((await post('acmeAdmin', `/cases/${ids.case}/submit-qa`)).status);
  });

  it('sends the latest versions to QA and locks editing', async () => {
    const before = await get('sum', `/cases/${ids.case}`);
    expect(before.body.can).toMatchObject({ submitQa: true, decideQa: false });

    const res = await post('sum', `/cases/${ids.case}/submit-qa`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('qa');
    expect(res.body.can).toMatchObject({ submitQa: false, decideQa: false });
    expect(res.body.timeline.at(-1)).toMatchObject({ action: 'case.status', status: 'qa' });
    expect(await statuses(ids.case)).toEqual([
      ['chronology', 1, 'in_qa', false],
      ['summary', 1, 'in_qa', false],
    ]);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'case.status', entityId: ids.case, actorId: users.sum!.id },
    });
    expect(audit?.metadata).toEqual({
      from: 'in_review',
      to: 'qa',
      by: 'submit_qa',
      versions: { chronology: 1, summary: 1 },
    });

    const edit = await request(app)
      .put(`/api/v1/cases/${ids.case}/deliverables/chronology`)
      .set(bearer(tokens.sum!))
      .send({ baseVersion: 1, content: chronology('During QA', ids.doc) });
    expect(edit.status).toBe(409);
    expect((await post('sum', `/cases/${ids.case}/submit-qa`)).status).toBe(409);

    const reviewer = await get('qa', `/cases/${ids.case}`);
    expect(reviewer.body.can).toMatchObject({ decideQa: true });
  });
});

describe('POST /cases/:id/qa', () => {
  it('is only for the assigned QA reviewer, never the summarizer', async () => {
    const body = { result: 'approved' };
    expect((await post('sum', `/cases/${ids.case}/qa`, body)).status).toBe(403);
    expect((await post('qa2', `/cases/${ids.case}/qa`, body)).status).toBe(404);
    expect([403, 404]).toContain((await post('acmeAdmin', `/cases/${ids.case}/qa`, body)).status);
    expect((await post('qa', `/cases/${ids.noQa}/qa`, body)).status).toBe(404);
  });

  it('needs comments to request changes', async () => {
    const res = await post('qa', `/cases/${ids.case}/qa`, { result: 'changes_requested' });
    expect(res.status).toBe(400);
    const blank = await post('qa', `/cases/${ids.case}/qa`, {
      result: 'changes_requested',
      comments: '   ',
    });
    expect(blank.status).toBe(400);
  });

  it('requests changes: comments encrypted, not audited, summarizer notified', async () => {
    const res = await post('qa', `/cases/${ids.case}/qa`, {
      result: 'changes_requested',
      comments: 'Synthetic note: check the ER date on page 1.',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('changes_requested');
    expect(await statuses(ids.case)).toEqual([
      ['chronology', 1, 'changes_requested', false],
      ['summary', 1, 'changes_requested', false],
    ]);
    const rows = await prisma.qaReview.findMany({
      where: { deliverable: { caseId: ids.case } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reviewerId === users.qa!.id)).toBe(true);
    expect(rows[0]!.comments).not.toContain('Synthetic note');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'case.status', entityId: ids.case, actorId: users.qa!.id },
    });
    expect(audit?.metadata).toMatchObject({
      from: 'qa',
      to: 'changes_requested',
      by: 'qa_decision',
      comments: true,
    });
    expect(JSON.stringify(audit)).not.toContain('Synthetic note');

    const note = await prisma.notification.findFirst({
      where: { userId: users.sum!.id, type: 'qa_changes_requested' },
    });
    expect(note).toBeTruthy();
  });

  it('shows the QA history to the summarizer, who fixes and resubmits', async () => {
    const list = await get('sum', `/cases/${ids.case}/qa-reviews`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({
      result: 'changes_requested',
      comments: 'Synthetic note: check the ER date on page 1.',
      reviewer: { id: users.qa!.id, name: 'Synthetic QA Reviewer' },
    });
    expect((await get('qa2', `/cases/${ids.case}/qa-reviews`)).status).toBe(404);

    const edit = await request(app)
      .put(`/api/v1/cases/${ids.case}/deliverables/chronology`)
      .set(bearer(tokens.sum!))
      .send({ baseVersion: 1, content: chronology('ER, date checked', ids.doc) });
    expect(edit.status).toBe(200);
    expect(edit.body.version).toBe(2);

    const res = await post('sum', `/cases/${ids.case}/submit-qa`);
    expect(res.status).toBe(200);
    expect(await statuses(ids.case)).toEqual([
      ['chronology', 1, 'changes_requested', false],
      ['chronology', 2, 'in_qa', false],
      ['summary', 1, 'in_qa', false],
    ]);
  });

  it('approves: locks the reviewed versions and notifies', async () => {
    const res = await post('qa', `/cases/${ids.case}/qa`, { result: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.can).toMatchObject({ submitQa: false, decideQa: false });
    expect(await statuses(ids.case)).toEqual([
      ['chronology', 1, 'changes_requested', false],
      ['chronology', 2, 'approved', true],
      ['summary', 1, 'approved', true],
    ]);
    const note = await prisma.notification.findFirst({
      where: { userId: users.sum!.id, type: 'approved' },
    });
    expect(note).toBeTruthy();

    expect((await post('qa', `/cases/${ids.case}/qa`, { result: 'approved' })).status).toBe(409);
    const edit = await request(app)
      .put(`/api/v1/cases/${ids.case}/deliverables/chronology`)
      .set(bearer(tokens.sum!))
      .send({ baseVersion: 2, content: chronology('After approval', ids.doc) });
    expect(edit.status).toBe(409);
  });
});
