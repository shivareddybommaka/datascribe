import { Readable } from 'node:stream';
import type { Prisma } from '@datascribe/db';
import {
  RETENTION_ACTION,
  retentionDaysOf,
  runRetention,
  type SourceObject,
} from '@datascribe/db/retention';
import { encrypt } from '@datascribe/shared';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, testPhiKey } from './constants';
import { bearer, buildApp, login, prisma, uniqueEmail } from './helpers';

/** D-128: the retention / hard-delete job, on synthetic orgs, cases and documents only. */
const { app, storage, storageReady } = buildApp();
const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-25T03:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
let seq = 0;

async function makeOrg(settings: Prisma.InputJsonObject) {
  const org = await prisma.organization.create({
    data: { name: `Retention test ${seq++} (synthetic)`, type: 'client', settings },
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_admin' } });
  const email = uniqueEmail('retention');
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email,
      name: 'Retention Admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
      status: 'active',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });
  return { orgId: org.id, userId: user.id, email };
}

type Org = Awaited<ReturnType<typeof makeOrg>>;

async function makeCase(
  org: Org,
  status: 'closed' | 'delivered',
  closedAt: Date | null,
  docs = 1,
  docData: { uploadId?: string } = {},
) {
  const c = await prisma.case.create({
    data: {
      organizationId: org.orgId,
      number: `RT-${Date.now().toString(36)}-${seq++}`,
      matterName: 'Synthetic retention matter',
      patientName: encrypt('Synthetic Patient', testPhiKey),
      caseType: 'personal_injury',
      requested: ['chronology'],
      status,
      closedAt,
      createdById: org.userId,
    },
  });
  const documents = [];
  for (let i = 0; i < docs; i++) {
    const s3Key = `orgs/${org.orgId}/cases/${c.id}/retention-${seq++}.pdf`;
    const doc = await prisma.document.create({
      data: {
        organizationId: org.orgId,
        caseId: c.id,
        fileName: `Synthetic Patient record ${i}.pdf`,
        s3Key,
        mimeType: 'application/pdf',
        sizeBytes: BigInt(64),
        scanStatus: 'clean',
        uploadedById: org.userId,
        uploadedAt: docData.uploadId ? null : daysAgo(400),
        uploadId: docData.uploadId ?? null,
        pages: {
          create: [1, 2].map((pageNumber) => ({
            pageNumber,
            text: encrypt(`synthetic page ${pageNumber}`, testPhiKey),
          })),
        },
      },
    });
    documents.push(doc);
  }
  return { caseId: c.id, documents };
}

const fakeDelete = () => vi.fn(async (_doc: SourceObject) => {});

describe('retentionDaysOf', () => {
  it('accepts only whole days within the admin bounds', () => {
    expect(retentionDaysOf({ retentionDays: 180 })).toBe(180);
    expect(retentionDaysOf({ retentionDays: 30 })).toBe(30);
    expect(retentionDaysOf({ retentionDays: 3650 })).toBe(3650);
    for (const bad of [{}, null, [], 'x', { retentionDays: '180' }, { retentionDays: 29 }]) {
      expect(retentionDaysOf(bad)).toBeNull();
    }
    expect(retentionDaysOf({ retentionDays: 3651 })).toBeNull();
    expect(retentionDaysOf({ retentionDays: 90.5 })).toBeNull();
    expect(retentionDaysOf({ retentionDays: null })).toBeNull();
  });
});

describe('retention job', () => {
  beforeAll(() => storageReady);

  it('deletes the S3 object and page text of a long-closed case, keeps the rest, audits it', async () => {
    const org = await makeOrg({ retentionDays: 30 });
    const { caseId, documents } = await makeCase(org, 'closed', daysAgo(31));
    const doc = documents[0]!;
    // a real object in the test bucket (SeaweedFS)
    const body = Buffer.from('%PDF-1.4 synthetic retention test');
    const uploadId = await storage.createMultipart(doc.s3Key, 'application/pdf');
    const etag = await storage.uploadPart(doc.s3Key, uploadId, 1, Readable.from(body), body.length);
    await storage.completeMultipart(doc.s3Key, uploadId, [
      { partNumber: 1, etag, size: body.length },
    ]);
    expect(await storage.head(doc.s3Key)).not.toBeNull();
    await prisma.clinicalEvent.create({
      data: { caseId, documentId: doc.id, pageNumber: 1, description: encrypt('x', testPhiKey) },
    });
    await prisma.deliverable.create({
      data: { caseId, type: 'chronology', content: encrypt('{}', testPhiKey), status: 'delivered' },
    });

    const result = await runRetention(prisma, {
      now,
      organizationIds: [org.orgId],
      deleteObject: ({ s3Key, uploadId: id }) =>
        id ? storage.abortMultipart(s3Key, id) : storage.delete(s3Key),
    });
    expect(result).toEqual({
      dryRun: false,
      orgs: 1,
      skippedOrgs: 0,
      eligible: 1,
      deleted: 1,
      failed: 0,
    });

    expect(await storage.head(doc.s3Key)).toBeNull();
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.purgedAt).toEqual(now);
    expect(await prisma.documentPage.count({ where: { documentId: doc.id } })).toBe(0);
    // the case, its clinical events (citations) and deliverables are kept
    expect(await prisma.case.count({ where: { id: caseId } })).toBe(1);
    expect(await prisma.clinicalEvent.count({ where: { caseId } })).toBe(1);
    expect(await prisma.deliverable.count({ where: { caseId } })).toBe(1);

    const audits = await prisma.auditLog.findMany({
      where: { action: RETENTION_ACTION, entityId: doc.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: null,
      organizationId: org.orgId,
      entity: 'Document',
      metadata: { actor: 'system', caseId, retentionDays: 30, pagesDeleted: 2 },
    });
    expect(JSON.stringify(audits[0]!.metadata)).not.toMatch(/Synthetic Patient|\.pdf/);

    // the portal lists it as a tombstone; downloading says it is gone
    const { token } = await login(app, org.email);
    const list = await request(app).get(`/api/v1/cases/${caseId}/documents`).set(bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: doc.id, state: 'purged' });
    expect(list.body.items[0].purgedAt).toBe(now.toISOString());
    const dl = await request(app)
      .get(`/api/v1/documents/${doc.id}/download-url`)
      .set(bearer(token));
    expect(dl.status).toBe(410);
    expect(dl.body.error.code).toBe('purged');
  });

  it('never touches open cases, recently closed cases or cases without a close date', async () => {
    const org = await makeOrg({ retentionDays: 30 });
    const open = await makeCase(org, 'delivered', daysAgo(400));
    const recent = await makeCase(org, 'closed', daysAgo(29));
    const undated = await makeCase(org, 'closed', null);
    const del = fakeDelete();
    const result = await runRetention(prisma, {
      now,
      organizationIds: [org.orgId],
      deleteObject: del,
    });
    expect(result).toMatchObject({ orgs: 1, eligible: 0, deleted: 0 });
    expect(del).not.toHaveBeenCalled();
    const ids = [open, recent, undated].flatMap((c) => c.documents.map((d) => d.id));
    expect(await prisma.document.count({ where: { id: { in: ids }, purgedAt: null } })).toBe(3);
    expect(await prisma.documentPage.count({ where: { documentId: { in: ids } } })).toBe(6);
  });

  it('deletes nothing for orgs whose retentionDays is unset or invalid', async () => {
    const orgs = await Promise.all(
      [{}, { retentionDays: '180' }, { retentionDays: 5 }, { retentionDays: 99_999 }].map(makeOrg),
    );
    for (const org of orgs) await makeCase(org, 'closed', daysAgo(5_000));
    const del = fakeDelete();
    const result = await runRetention(prisma, {
      now,
      organizationIds: orgs.map((o) => o.orgId),
      deleteObject: del,
    });
    expect(result).toMatchObject({ orgs: 0, skippedOrgs: 4, eligible: 0, deleted: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it('dry run counts only', async () => {
    const org = await makeOrg({ retentionDays: 60 });
    const { documents } = await makeCase(org, 'closed', daysAgo(61), 2);
    const del = fakeDelete();
    const info = vi.fn();
    const result = await runRetention(prisma, {
      now,
      dryRun: true,
      organizationIds: [org.orgId],
      deleteObject: del,
      log: { info, warn: vi.fn() },
    });
    expect(result).toMatchObject({ dryRun: true, orgs: 1, eligible: 2, deleted: 0, failed: 0 });
    expect(del).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { organizationId: org.orgId, retentionDays: 60, eligible: 2 },
      'retention dry run',
    );
    const ids = documents.map((d) => d.id);
    expect(await prisma.document.count({ where: { id: { in: ids }, purgedAt: null } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityId: { in: ids } } })).toBe(0);
  });

  it('is batch-limited and idempotent across reruns', async () => {
    const org = await makeOrg({ retentionDays: 30 });
    const { documents } = await makeCase(org, 'closed', daysAgo(90), 3);
    const del = fakeDelete();
    const run = () =>
      runRetention(prisma, { now, batchSize: 2, organizationIds: [org.orgId], deleteObject: del });
    expect(await run()).toMatchObject({ eligible: 3, deleted: 2 });
    expect(await run()).toMatchObject({ eligible: 1, deleted: 1 });
    expect(await run()).toMatchObject({ eligible: 0, deleted: 0 });
    expect(del).toHaveBeenCalledTimes(3);
    const ids = documents.map((d) => d.id);
    expect(
      await prisma.auditLog.count({ where: { action: RETENTION_ACTION, entityId: { in: ids } } }),
    ).toBe(3);
  });

  it('keeps going when one file fails and retries it next run', async () => {
    const org = await makeOrg({ retentionDays: 30 });
    const { documents } = await makeCase(org, 'closed', daysAgo(90), 3);
    const broken = documents[1]!;
    const warn = vi.fn();
    const failing = vi.fn(async (d: SourceObject) => {
      if (d.s3Key === broken.s3Key) throw new Error('S3 unavailable');
    });
    const first = await runRetention(prisma, {
      now,
      organizationIds: [org.orgId],
      deleteObject: failing,
      log: { info: vi.fn(), warn },
    });
    expect(first).toMatchObject({ eligible: 3, deleted: 2, failed: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: broken.id }),
      'retention delete failed; retried next run',
    );
    const kept = await prisma.document.findUniqueOrThrow({ where: { id: broken.id } });
    expect(kept.purgedAt).toBeNull();
    expect(await prisma.documentPage.count({ where: { documentId: broken.id } })).toBe(2);

    const second = await runRetention(prisma, {
      now,
      organizationIds: [org.orgId],
      deleteObject: fakeDelete(),
    });
    expect(second).toMatchObject({ eligible: 1, deleted: 1, failed: 0 });
  });

  it('aborts an unfinished multipart upload instead of deleting an object', async () => {
    const org = await makeOrg({ retentionDays: 30 });
    const { documents } = await makeCase(org, 'closed', daysAgo(90), 1, { uploadId: 'up-123' });
    const del = fakeDelete();
    await runRetention(prisma, { now, organizationIds: [org.orgId], deleteObject: del });
    expect(del).toHaveBeenCalledWith({ s3Key: documents[0]!.s3Key, uploadId: 'up-123' });
    const after = await prisma.document.findUniqueOrThrow({ where: { id: documents[0]!.id } });
    expect(after).toMatchObject({ purgedAt: now, uploadId: null });
  });
});
