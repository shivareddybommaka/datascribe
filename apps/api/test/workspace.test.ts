import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { pageImageKey } from '../src/lib/storage';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';
import { TEST_S3 } from './s3';

/** M6 part 2 (§5.4, D-084/D-085): workspace read API, page text and images. Synthetic data only. */
const { app, storageReady } = buildApp();
const tokens: Record<string, string> = {};
const get = (who: string, path: string) =>
  request(app).get(`/api/v1${path}`).set(bearer(tokens[who]!));

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: TEST_S3.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: TEST_S3.S3_ACCESS_KEY_ID,
    secretAccessKey: TEST_S3.S3_SECRET_ACCESS_KEY,
  },
});
const put = (key: string, body: Buffer) =>
  s3.send(new PutObjectCommand({ Bucket: TEST_S3.S3_BUCKET_DOCUMENTS, Key: key, Body: body }));

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const users: Record<string, { id: string; email: string }> = {};
const ids = { case: '', other: '', doc: '', purged: '', png: '' };

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

const enc = (v: string) => encrypt(v, testPhiKey);

beforeAll(async () => {
  users.sum = await makeStaff('summarizer', 'Synthetic Workspace Summarizer');
  users.sum2 = await makeStaff('summarizer', 'Synthetic Other Summarizer');
  users.qa = await makeStaff('qa_reviewer', 'Synthetic Workspace Reviewer');

  const acme = await orgId('acme');
  const creator = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
  const kase = (key: string, data: Record<string, unknown> = {}) =>
    prisma.case.create({
      data: {
        organizationId: acme,
        number: `DSW-${STAMP}-${key}`,
        matterName: `Synthetic Workspace Matter ${STAMP}`,
        patientName: enc('Riley Synthetic'),
        caseType: 'personal_injury',
        requested: ['index', 'chronology', 'summary'],
        createdById: creator.id,
        submittedAt: new Date(),
        status: 'in_review',
        ...data,
      },
    });
  const c = await kase('main', { summarizerId: users.sum.id, qaReviewerId: users.qa.id });
  ids.case = c.id;
  ids.other = (await kase('other')).id;

  const doc = (key: string, data: Record<string, unknown> = {}) =>
    prisma.document.create({
      data: {
        organizationId: acme,
        caseId: c.id,
        fileName: `synthetic-${key}.pdf`,
        s3Key: `test/workspace/${STAMP}/${key}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 1024n,
        pageCount: 2,
        scanStatus: 'clean',
        uploadedById: creator.id,
        uploadedAt: new Date(),
        ...data,
      },
    });
  ids.doc = (await doc('records')).id;
  ids.purged = (await doc('purged', { purgedAt: new Date() })).id;
  ids.png = (
    await doc('scan', {
      fileName: 'synthetic-scan.png',
      s3Key: `test/workspace/${STAMP}/scan.png`,
      mimeType: 'image/png',
      pageCount: 1,
    })
  ).id;
  await doc('unfinished', { uploadedAt: null, uploadId: 'synthetic-upload' });
  await prisma.documentPage.createMany({
    data: [
      { documentId: ids.doc, pageNumber: 1, text: enc('Synthetic ER visit, lumbar strain.') },
      { documentId: ids.doc, pageNumber: 2, text: enc('Synthetic follow-up.'), ocrConfidence: 0.9 },
    ],
  });
  await prisma.clinicalEvent.createMany({
    data: [
      {
        caseId: c.id,
        documentId: ids.doc,
        pageNumber: 2,
        eventDate: new Date('2026-03-04'),
        provider: 'Dr Synthetic',
        eventType: 'office_visit',
        description: enc('Follow-up visit'),
      },
      {
        caseId: c.id,
        documentId: ids.doc,
        pageNumber: 1,
        eventDate: new Date('2026-03-01'),
        facility: 'Synthetic General',
        eventType: 'er',
        description: enc('ER visit for lumbar strain'),
      },
    ],
  });
  const content = (v: number) =>
    enc(JSON.stringify({ kind: 'chronology', entries: [{ description: `v${v}` }] }));
  await prisma.deliverable.createMany({
    data: [
      { caseId: c.id, type: 'chronology', version: 1, content: content(1) },
      { caseId: c.id, type: 'chronology', version: 2, content: content(2) },
      { caseId: c.id, type: 'summary', content: enc(JSON.stringify({ kind: 'summary' })) },
    ],
  });

  for (const [k, email] of Object.entries({
    sum: users.sum.email,
    sum2: users.sum2.email,
    qa: users.qa.email,
    ops: SEED.internal('ops_manager'),
    sales: SEED.internal('sales'),
    acmeAdmin: SEED.acmeAdmin,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});

afterAll(async () => {
  const caseIds = [ids.case, ids.other];
  await prisma.clinicalEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.document.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.$disconnect();
});

describe('GET /cases/:id/workspace', () => {
  it('gives the assigned summarizer documents, latest deliverables and cited events', async () => {
    const res = await get('sum', `/cases/${ids.case}/workspace`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.case.id).toBe(ids.case);
    expect(res.body.case.patientName).toBe('Riley Synthetic');

    const docs = res.body.documents as { id: string; state: string }[];
    expect(docs.map((d) => d.state).sort()).toEqual(['clean', 'clean', 'purged']);
    expect(docs.map((d) => d.id)).toContain(ids.doc);

    const dels = res.body.deliverables as { type: string; version: number; content: unknown }[];
    expect(dels.map((d) => [d.type, d.version])).toEqual([
      ['chronology', 2],
      ['summary', 1],
    ]);
    expect(dels[0]!.content).toEqual({ kind: 'chronology', entries: [{ description: 'v2' }] });

    const events = res.body.clinicalEvents as {
      description: string;
      documentId: string;
      pageNumber: number;
    }[];
    expect(events.map((e) => e.description)).toEqual([
      'ER visit for lumbar strain',
      'Follow-up visit',
    ]);
    expect(events[0]).toMatchObject({ documentId: ids.doc, pageNumber: 1 });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'case.workspace_view', entityId: ids.case, actorId: users.sum!.id },
    });
    expect(audit?.metadata).toEqual({ documents: 3, deliverables: 2, events: 2 });
  });

  it('works for the assigned QA reviewer and ops manager', async () => {
    expect((await get('qa', `/cases/${ids.case}/workspace`)).status).toBe(200);
    expect((await get('ops', `/cases/${ids.case}/workspace`)).status).toBe(200);
  });

  it('hides the workspace from unassigned staff, sales and clients', async () => {
    expect((await get('sum2', `/cases/${ids.case}/workspace`)).status).toBe(404);
    expect((await get('qa', `/cases/${ids.other}/workspace`)).status).toBe(404);
    expect([403, 404]).toContain((await get('sales', `/cases/${ids.case}/workspace`)).status);
    expect((await get('acmeAdmin', `/cases/${ids.case}/workspace`)).status).toBe(404);
  });
});

describe('versioned deliverable edits (D-086)', () => {
  const save = (who: string, type: string, body: unknown) =>
    request(app)
      .put(`/api/v1/cases/${ids.case}/deliverables/${type}`)
      .set(bearer(tokens[who]!))
      .send(body as object);
  const chronology = (description: string, pageNumber = 1, documentId = ids.doc) => ({
    kind: 'chronology',
    entries: [
      {
        date: '2026-03-01',
        provider: null,
        facility: 'Synthetic General',
        eventType: 'er',
        description,
        codes: [{ system: 'ICD-10-CM', code: 'S39.012A', display: 'Lumbar strain' }],
        citation: { documentId, fileName: 'synthetic-records.pdf', pageNumber },
      },
    ],
  });

  it('saves an edit as a new version, encrypted and audited without content', async () => {
    const res = await save('sum', 'chronology', {
      baseVersion: 2,
      content: chronology('Edited synthetic ER visit'),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'chronology', version: 3, status: 'draft' });
    expect(res.body.editedBy).toEqual({
      id: users.sum!.id,
      name: 'Synthetic Workspace Summarizer',
    });

    const row = await prisma.deliverable.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.content).not.toContain('Edited synthetic');
    expect(row.editedById).toBe(users.sum!.id);
    const v2 = await prisma.deliverable.findFirstOrThrow({
      where: { caseId: ids.case, type: 'chronology', version: 2 },
    });
    expect(v2.content).toBeTruthy(); // the earlier version is kept

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deliverable.edit', entityId: res.body.id },
    });
    expect(audit?.metadata).toEqual({
      caseId: ids.case,
      type: 'chronology',
      version: 3,
      entries: 1,
    });
    expect(JSON.stringify(audit)).not.toContain('Edited synthetic');

    const ws = await get('sum', `/cases/${ids.case}/workspace`);
    const latest = (
      ws.body.deliverables as { type: string; version: number; content: unknown }[]
    )[0];
    expect(latest).toMatchObject({ type: 'chronology', version: 3 });
    expect(latest!.content).toEqual(chronology('Edited synthetic ER visit'));
  });

  it('rejects a stale base version with 409', async () => {
    const res = await save('sum', 'chronology', { baseVersion: 2, content: chronology('Stale') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('version_conflict');
  });

  it('rejects citations outside the case or past the last page, and bad shapes', async () => {
    const outside = await save('sum', 'chronology', {
      baseVersion: 3,
      content: chronology('x', 1, ids.other),
    });
    expect(outside.status).toBe(400);
    const pastEnd = await save('sum', 'chronology', {
      baseVersion: 3,
      content: chronology('x', 3),
    });
    expect(pastEnd.status).toBe(400);
    const uncited = chronology('x');
    delete (uncited.entries[0] as Partial<(typeof uncited.entries)[0]>).citation;
    expect((await save('sum', 'chronology', { baseVersion: 3, content: uncited })).status).toBe(
      400,
    );
    expect(
      (await save('sum', 'chronology', { baseVersion: 3, content: { kind: 'summary' } })).status,
    ).toBe(400);
    expect((await save('sum', 'report', { baseVersion: 1, content: {} })).status).toBe(404);
  });

  it('only lets staff who may edit the case save', async () => {
    const body = { baseVersion: 3, content: chronology('Not allowed') };
    expect((await save('qa', 'chronology', body)).status).toBe(403);
    expect((await save('sum2', 'chronology', body)).status).toBe(404);
    expect([403, 404]).toContain((await save('acmeAdmin', 'chronology', body)).status);
  });

  it('refuses edits once a version is with QA or the case left review', async () => {
    const v3 = { caseId: ids.case, type: 'chronology' as const, version: 3 };
    await prisma.deliverable.updateMany({ where: v3, data: { status: 'in_qa' } });
    const locked = await save('sum', 'chronology', { baseVersion: 3, content: chronology('x') });
    expect(locked.status).toBe(409);
    await prisma.deliverable.updateMany({ where: v3, data: { status: 'draft' } });

    await prisma.case.update({ where: { id: ids.case }, data: { status: 'qa' } });
    const closed = await save('sum', 'chronology', { baseVersion: 3, content: chronology('x') });
    expect(closed.status).toBe(409);
    await prisma.case.update({ where: { id: ids.case }, data: { status: 'in_review' } });
  });

  it('saves summary paragraphs', async () => {
    const content = {
      kind: 'summary',
      sections: [{ heading: 'Overview', paragraphs: ['Synthetic edited paragraph.'] }],
      provider: 'template',
    };
    const res = await save('sum', 'summary', { baseVersion: 1, content });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, content });
  });

  it('lists versions and returns an earlier version for compare / restore', async () => {
    const list = await get('sum', `/cases/${ids.case}/deliverables/chronology/versions`);
    expect(list.status).toBe(200);
    const items = list.body.items as { version: number; editedBy: { id: string } | null }[];
    expect(items.map((i) => i.version)).toEqual([3, 2, 1]);
    expect(items[0]!.editedBy?.id).toBe(users.sum!.id);
    expect(items[2]!.editedBy).toBeNull();

    const v1 = await get('qa', `/cases/${ids.case}/deliverables/chronology/versions/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.content).toEqual({ kind: 'chronology', entries: [{ description: 'v1' }] });
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'deliverable.version_view', entityId: v1.body.id, actorId: users.qa!.id },
    });
    expect(audit?.metadata).toEqual({ caseId: ids.case, type: 'chronology', version: 1 });

    expect((await get('sum', `/cases/${ids.case}/deliverables/chronology/versions/9`)).status).toBe(
      404,
    );
    expect(
      (await get('acmeAdmin', `/cases/${ids.case}/deliverables/chronology/versions`)).status,
    ).toBe(404);
  });
});

describe('GET /documents/:id/pages/:n', () => {
  it('returns the decrypted page text and audits the view', async () => {
    const res = await get('sum', `/documents/${ids.doc}/pages/2`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      documentId: ids.doc,
      pageNumber: 2,
      pageCount: 2,
      text: 'Synthetic follow-up.',
      ocrConfidence: 0.9,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'document.page_view', entityId: ids.doc, actorId: users.sum!.id },
    });
    expect(audit?.metadata).toEqual({ caseId: ids.case, pageNumber: 2 });
  });

  it('404s for a missing page, 400s for a bad number, 410s once purged', async () => {
    expect((await get('sum', `/documents/${ids.doc}/pages/3`)).status).toBe(404);
    expect((await get('sum', `/documents/${ids.doc}/pages/0`)).status).toBe(400);
    expect((await get('sum', `/documents/${ids.doc}/pages/x`)).status).toBe(400);
    expect((await get('sum', `/documents/${ids.purged}/pages/1`)).status).toBe(410);
  });

  it('is staff only and follows case assignment', async () => {
    expect((await get('acmeAdmin', `/documents/${ids.doc}/pages/1`)).status).toBe(404);
    expect((await get('sum2', `/documents/${ids.doc}/pages/1`)).status).toBe(404);
  });
});

describe('GET /documents/:id/pages/:n/image and /thumb (D-085)', () => {
  // synthetic bytes: the route streams whatever the worker stored, it never decodes them
  const JPEG = Buffer.from('\xff\xd8\xff synthetic page image', 'latin1');
  const THUMB = Buffer.from('\xff\xd8\xff synthetic thumb', 'latin1');
  const PNG = Buffer.from('\x89PNG synthetic scan', 'latin1');
  const fetchBytes = (who: string, path: string) =>
    get(who, path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    await storageReady;
    const records = await prisma.document.findUniqueOrThrow({ where: { id: ids.doc } });
    await put(pageImageKey(records.s3Key, 1), JPEG);
    await put(pageImageKey(records.s3Key, 1, true), THUMB);
    await put(`test/workspace/${STAMP}/scan.png`, PNG);
  });

  it('streams the page image and audits it, and the thumbnail without an audit row', async () => {
    const res = await fetchBytes('sum', `/documents/${ids.doc}/pages/1/image`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(res.body as Buffer, JPEG)).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'document.page_image_view', entityId: ids.doc, actorId: users.sum!.id },
    });
    expect(audit?.metadata).toEqual({ caseId: ids.case, pageNumber: 1 });

    const thumb = await fetchBytes('qa', `/documents/${ids.doc}/pages/1/thumb`);
    expect(thumb.status).toBe(200);
    expect(Buffer.compare(thumb.body as Buffer, THUMB)).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'document.page_image_view', entityId: ids.doc, actorId: users.qa!.id },
      }),
    ).toBe(0);
  });

  it('serves a PNG upload as its own page 1', async () => {
    const res = await fetchBytes('sum', `/documents/${ids.png}/pages/1/image`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    expect((await get('sum', `/documents/${ids.png}/pages/2/image`)).status).toBe(404);
  });

  it('404s without a stored image, 410s once purged, and is staff only', async () => {
    expect((await get('sum', `/documents/${ids.doc}/pages/2/image`)).status).toBe(404);
    expect((await get('sum', `/documents/${ids.purged}/pages/1/thumb`)).status).toBe(410);
    expect((await get('sum', `/documents/${ids.doc}/pages/0/image`)).status).toBe(400);
    expect((await get('acmeAdmin', `/documents/${ids.doc}/pages/1/image`)).status).toBe(404);
    expect((await get('sum2', `/documents/${ids.doc}/pages/1/thumb`)).status).toBe(404);
  });
});
