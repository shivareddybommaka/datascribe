import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EICAR, quarantineKey, type VirusScanner } from '@datascribe/scan';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';
import { syntheticRecordPdf } from './synthetic-pdf';
import { allParts, complete, putParts, startUpload, uploadFile } from './upload-helpers';

const { app, storage, storageReady } = buildApp();
const tokens: Record<string, string> = {};
const MiB = 1024 * 1024;

const newCase = async (token: string, matterName = 'Upload test v. Synthetic Co') => {
  const res = await request(app)
    .post('/api/v1/cases')
    .set(bearer(token))
    .send({
      matterName,
      patientName: 'Leida517 Okuneva707',
      caseType: 'personal_injury',
      requested: ['chronology'],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

const audits = (entityId: string) =>
  prisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

let acmeCase: string;

beforeAll(async () => {
  await storageReady;
  for (const email of [
    SEED.acmeAdmin,
    SEED.acmeUser,
    SEED.harborAdmin,
    SEED.internal('case_manager'),
    SEED.internal('sales'),
    SEED.internal('finance'),
  ]) {
    tokens[email] = (await login(app, email)).token;
  }
  acmeCase = await newCase(tokens[SEED.acmeUser]!);
});

afterAll(() => prisma.$disconnect());

describe('M4 DoD: a client uploads a 300-page synthetic PDF with a resumable upload', () => {
  it('uploads in parts, is interrupted, resumes, completes and verifies sha256 + pageCount', async () => {
    const token = tokens[SEED.acmeUser]!;
    // ~12 MB with filler, so it needs 3 parts of 5 MiB
    const pdf = await syntheticRecordPdf({ pages: 300, padBytes: 11 * MiB });
    const upload = await startUpload(app, token, acmeCase, pdf.bytes, {
      fileName: 'Synthetic records 2025.pdf',
    });
    expect(upload.partSize).toBe(5 * MiB);
    expect(upload.partCount).toBe(3);
    expect(upload.uploadedParts).toEqual([]);

    // first part only, then the connection "drops"
    await putParts(app, token, upload, pdf.bytes, [1]);
    const early = await complete(app, token, upload.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('upload_incomplete');
    expect(early.body.error.details.missingParts).toEqual([2, 3]);

    // resume: ask S3 what it has, send only the rest
    const state = await request(app).get(`/api/v1/uploads/${upload.id}`).set(bearer(token));
    expect(state.status).toBe(200);
    expect(state.body.uploadedParts).toEqual([1]);
    const missing = allParts(upload).filter((n) => !state.body.uploadedParts.includes(n));
    await putParts(app, token, upload, pdf.bytes, missing);

    const done = await complete(app, token, upload.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.completed).toBe(true);
    expect(done.body.scanStatus).toBe('clean');
    expect(done.body.sha256).toBe(pdf.sha256);
    expect(done.body.pageCount).toBe(300);
    expect(done.body.sizeBytes).toBe(pdf.bytes.length);

    // a retried /complete is harmless
    expect((await complete(app, token, upload.id)).status).toBe(200);

    // signed download URL (5 min) returns the exact bytes
    const link = await request(app)
      .get(`/api/v1/documents/${upload.id}/download-url`)
      .set(bearer(token));
    expect(link.status).toBe(200);
    expect(link.headers['cache-control']).toContain('no-store');
    const url = new URL(link.body.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    const file = await fetch(link.body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    const got = createHash('sha256')
      .update(Buffer.from(await file.arrayBuffer()))
      .digest('hex');
    expect(got).toBe(pdf.sha256);

    // §4.4: create, completion, scan and download are audited, without the file name
    const rows = await audits(upload.id);
    expect(rows.map((r) => r.action)).toEqual([
      'document.create',
      'document.upload_complete',
      'document.scan',
      'document.download',
    ]);
    expect(JSON.stringify(rows)).not.toContain('Synthetic records');
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: upload.id } });
    expect(doc.s3Key).not.toContain('Synthetic');
    expect(doc.s3Key.startsWith(`org/${await orgId('acme')}/cases/${acmeCase}/`)).toBe(true);

    // it shows in the case's document list
    const list = await request(app).get(`/api/v1/cases/${acmeCase}/documents`).set(bearer(token));
    expect(list.body.items.find((d: { id: string }) => d.id === upload.id)).toMatchObject({
      state: 'clean',
      pageCount: 300,
      fileName: 'Synthetic records 2025.pdf',
    });
  });
});

describe('§10 file validation', () => {
  it('rejects files whose content is not PDF/PNG/JPEG/TIFF, whatever the name says', async () => {
    const token = tokens[SEED.acmeUser]!;
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 1)]);
    const upload = await startUpload(app, token, acmeCase, zip, { fileName: 'records.pdf' });
    await putParts(app, token, upload, zip, [1]);
    const res = await complete(app, token, upload.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('file_type_not_allowed');
    expect(await prisma.document.findUnique({ where: { id: upload.id } })).toBeNull();
    expect((await audits(upload.id)).map((r) => r.action)).toContain('document.rejected');
  });

  it('uses the detected type when the browser declared another allowed type', async () => {
    const pdf = await syntheticRecordPdf({ pages: 2 });
    const res = await uploadFile(app, tokens[SEED.acmeUser]!, acmeCase, pdf.bytes, {
      fileName: 'scan.png',
      mimeType: 'image/png',
    });
    expect(res.status).toBe(200);
    expect(res.body.mimeType).toBe('application/pdf');
    expect(res.body.pageCount).toBe(2);
  });

  it('accepts PNG, JPEG and TIFF images', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    // minimal little-endian TIFF: header → one IFD with 0 entries → next IFD 0
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const [bytes, mimeType, pages] of [
      [png, 'image/png', 1],
      [jpeg, 'image/jpeg', 1],
      [tiff, 'image/tiff', 1],
    ] as const) {
      const res = await uploadFile(app, tokens[SEED.acmeUser]!, acmeCase, bytes, {
        fileName: `img.${mimeType.split('/')[1]}`,
        mimeType,
      });
      expect(res.status, mimeType).toBe(200);
      expect(res.body.mimeType).toBe(mimeType);
      expect(res.body.pageCount).toBe(pages);
    }
  });

  it('enforces the 500 MB limit and allowed types up front', async () => {
    const t = tokens[SEED.acmeUser]!;
    const start = (body: object) =>
      request(app).post(`/api/v1/cases/${acmeCase}/uploads`).set(bearer(t)).send(body);
    expect(
      (await start({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 500 * MiB + 1 }))
        .status,
    ).toBe(400);
    expect(
      (await start({ fileName: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 }))
        .status,
    ).toBe(400);
    expect(
      (await start({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 0 })).status,
    ).toBe(400);
    // the largest allowed file is fine and gets ≤ 10,000 parts
    const ok = await start({
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 500 * MiB,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.partCount).toBe(100);
    await request(app).delete(`/api/v1/uploads/${ok.body.id}`).set(bearer(t));
  });

  it('rejects an upload whose bytes do not match the declared size', async () => {
    const t = tokens[SEED.acmeUser]!;
    const pdf = await syntheticRecordPdf({ pages: 1 });
    const upload = await startUpload(app, t, acmeCase, pdf.bytes, {
      sizeBytes: pdf.bytes.length + 10,
    });
    await putParts(app, t, upload, pdf.bytes, [1]);
    const res = await complete(app, t, upload.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('size_mismatch');
    expect(await prisma.document.findUnique({ where: { id: upload.id } })).toBeNull();
  });
});

describe('virus scanning', () => {
  it('quarantines an infected file: moved under quarantine/ and never downloadable', async () => {
    const t = tokens[SEED.acmeUser]!;
    const infected = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from(EICAR),
      Buffer.alloc(10),
    ]);
    const res = await uploadFile(app, t, acmeCase, infected);
    expect(res.status).toBe(200);
    expect(res.body.scanStatus).toBe('infected');
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(doc.s3Key.startsWith('quarantine/')).toBe(true);
    expect(await storage.head(doc.s3Key.replace(/^quarantine\//, ''))).toBeNull();
    expect(await storage.head(doc.s3Key)).not.toBeNull();
    expect(quarantineKey('org/x')).toBe('quarantine/org/x');

    const link = await request(app)
      .get(`/api/v1/documents/${res.body.id}/download-url`)
      .set(bearer(t));
    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe('quarantined');
    const scan = (await audits(res.body.id)).find((r) => r.action === 'document.scan');
    expect(scan?.metadata).toMatchObject({ result: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('fails closed when the scanner is unavailable', async () => {
    const broken: VirusScanner = {
      name: 'broken',
      async scan(input: Readable) {
        input.resume();
        throw new Error('clamd unavailable: ECONNREFUSED');
      },
    };
    const other = buildApp({ scanner: broken });
    const { token } = await login(other.app, SEED.acmeUser);
    const pdf = await syntheticRecordPdf({ pages: 1 });
    const res = await uploadFile(other.app, token, acmeCase, pdf.bytes);
    expect(res.body.scanStatus).toBe('error');
    const link = await request(other.app)
      .get(`/api/v1/documents/${res.body.id}/download-url`)
      .set(bearer(token));
    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe('scan_failed');
  });
});

describe('document access (§4.3 documents row, §4.4)', () => {
  let docId: string;

  beforeAll(async () => {
    const pdf = await syntheticRecordPdf({ pages: 3 });
    docId = (await uploadFile(app, tokens[SEED.acmeUser]!, acmeCase, pdf.bytes)).body.id;
  });

  it('another firm gets 404 on every document and upload route', async () => {
    const t = tokens[SEED.harborAdmin]!;
    for (const [method, path] of [
      ['get', `/api/v1/documents/${docId}`],
      ['get', `/api/v1/documents/${docId}/download-url`],
      ['get', `/api/v1/uploads/${docId}`],
      ['post', `/api/v1/uploads/${docId}/complete`],
      ['patch', `/api/v1/documents/${docId}`],
      ['delete', `/api/v1/documents/${docId}`],
      ['post', `/api/v1/cases/${acmeCase}/uploads`],
    ] as const) {
      const res = await request(app)[method](path).set(bearer(t)).send({
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('sales and finance are refused (no medical records)', async () => {
    for (const role of ['sales', 'finance'] as const) {
      const t = tokens[SEED.internal(role)]!;
      expect((await request(app).get(`/api/v1/documents/${docId}`).set(bearer(t))).status).toBe(
        403,
      );
      expect(
        (await request(app).get(`/api/v1/documents/${docId}/download-url`).set(bearer(t))).status,
      ).toBe(403);
    }
  });

  it('client_user: only own and shared cases; case_manager: any firm', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_user' } });
    const email = uniqueEmail('uploader');
    const colleague = await prisma.user.create({
      data: {
        email,
        name: 'Acme Paralegal (synthetic)',
        organizationId: await orgId('acme'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const { token } = await login(app, email);
    const pdf = await syntheticRecordPdf({ pages: 1 });
    const start = () =>
      request(app).post(`/api/v1/cases/${acmeCase}/uploads`).set(bearer(token)).send({
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdf.bytes.length,
      });
    expect((await start()).status).toBe(404);
    expect((await request(app).get(`/api/v1/documents/${docId}`).set(bearer(token))).status).toBe(
      404,
    );
    await prisma.caseShare.create({ data: { caseId: acmeCase, userId: colleague.id } });
    expect((await start()).status).toBe(201);
    expect((await request(app).get(`/api/v1/documents/${docId}`).set(bearer(token))).status).toBe(
      200,
    );
    const staff = await request(app)
      .get(`/api/v1/documents/${docId}`)
      .set(bearer(tokens[SEED.internal('case_manager')]!));
    expect(staff.status).toBe(200);
  });

  it('views, renames and deletes are audited; client_user cannot delete, client_admin can', async () => {
    const view = await request(app)
      .get(`/api/v1/documents/${docId}`)
      .set(bearer(tokens[SEED.acmeUser]!));
    expect(view.status).toBe(200);
    const rename = await request(app)
      .patch(`/api/v1/documents/${docId}`)
      .set(bearer(tokens[SEED.acmeUser]!))
      .send({ fileName: '../../ER visit.pdf' });
    expect(rename.body.fileName).toBe('ER visit.pdf');
    expect(
      (await request(app).delete(`/api/v1/documents/${docId}`).set(bearer(tokens[SEED.acmeUser]!)))
        .status,
    ).toBe(403);
    const key = (await prisma.document.findUniqueOrThrow({ where: { id: docId } })).s3Key;
    const del = await request(app)
      .delete(`/api/v1/documents/${docId}`)
      .set(bearer(tokens[SEED.acmeAdmin]!));
    expect(del.status).toBe(204);
    expect(await storage.head(key)).toBeNull();
    const actions = (await audits(docId)).map((r) => r.action);
    for (const a of ['document.view', 'document.edit', 'document.delete']) {
      expect(actions).toContain(a);
    }
  });

  it('cancelling an unfinished upload removes it', async () => {
    const t = tokens[SEED.acmeUser]!;
    const pdf = await syntheticRecordPdf({ pages: 1 });
    const upload = await startUpload(app, t, acmeCase, pdf.bytes);
    const res = await request(app).delete(`/api/v1/uploads/${upload.id}`).set(bearer(t));
    expect(res.status).toBe(204);
    expect(await prisma.document.findUnique({ where: { id: upload.id } })).toBeNull();
  });

  it('records are locked once processing starts', async () => {
    const t = tokens[SEED.acmeUser]!;
    const id = await newCase(t, 'Locked v. Synthetic');
    await prisma.case.update({ where: { id }, data: { status: 'processing' } });
    const res = await request(app)
      .post(`/api/v1/cases/${id}/uploads`)
      .set(bearer(t))
      .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('case_locked');
  });
});
