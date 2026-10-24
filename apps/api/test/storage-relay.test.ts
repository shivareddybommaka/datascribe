/** Staging's storage relay (D-122): uploads and downloads through the API, same origin. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactPath } from '../src/app';
import { openRelayToken, relayKey, sealRelayToken } from '../src/lib/relay-token';
import { SEED, bearer, buildApp, login, prisma, testEnv } from './helpers';
import { syntheticRecordPdf } from './synthetic-pdf';
import { startUpload } from './upload-helpers';

const { app, storageReady } = buildApp({ envOverrides: { S3_BROWSER_ACCESS: 'relay' } });
let token: string;
let caseId: string;

beforeAll(async () => {
  await storageReady;
  token = (await login(app, SEED.acmeUser)).token;
  const res = await request(app)
    .post('/api/v1/cases')
    .set(bearer(token))
    .send({
      matterName: 'Relay test v. Synthetic Co',
      patientName: 'Synthetic Patient',
      caseType: 'personal_injury',
      requested: ['chronology'],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  caseId = res.body.id;
});

afterAll(() => prisma.$disconnect());

describe('storage relay (D-122)', () => {
  it('uploads parts and downloads the file through same-origin relay URLs', async () => {
    const pdf = await syntheticRecordPdf({ pages: 3 });
    const upload = await startUpload(app, token, caseId, pdf.bytes);
    const parts = await request(app)
      .post(`/api/v1/uploads/${upload.id}/parts`)
      .set(bearer(token))
      .send({ partNumbers: [1] });
    expect(parts.status).toBe(200);
    const url = parts.body.parts[0].url as string;
    expect(url.startsWith('/api/v1/storage-relay/')).toBe(true);
    // the token hides the object key
    expect(url).not.toContain(upload.id);

    // no bearer token: the sealed URL is the credential, like a presigned S3 URL
    const put = await request(app)
      .put(url)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(pdf.bytes));
    expect(put.status, put.text).toBe(200);
    expect(put.headers.etag).toBeTruthy();

    const done = await request(app)
      .post(`/api/v1/uploads/${upload.id}/complete`)
      .set(bearer(token))
      .send({});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.scanStatus).toBe('clean');

    const link = await request(app)
      .get(`/api/v1/documents/${upload.id}/download-url`)
      .set(bearer(token));
    expect(link.status).toBe(200);
    expect(link.body.url.startsWith('/api/v1/storage-relay/')).toBe(true);
    const file = await request(app)
      .get(link.body.url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, Buffer.from(pdf.bytes))).toBe(0);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="records\.pdf"/);
    expect(file.headers['cache-control']).toBe('private, no-store');

    // an upload token can't be used to read, and a tampered token is refused
    expect((await request(app).get(url)).status).toBe(404);
    const good = link.body.url as string;
    const i = good.length - 5;
    const tampered = `${good.slice(0, i)}${good[i] === 'A' ? 'B' : 'A'}${good.slice(i + 1)}`;
    expect((await request(app).get(tampered)).status).toBe(403);
    expect((await request(app).get('/api/v1/storage-relay/nope')).status).toBe(403);
  });

  it('refuses a part without a usable Content-Length', async () => {
    const key = relayKey(testEnv().JWT_ACCESS_SECRET);
    const url = `/api/v1/storage-relay/${sealRelayToken(
      { op: 'put', k: 'x', u: 'y', p: 1, e: Date.now() + 60_000 },
      key,
    )}`;
    const res = await request(app).put(url).set('content-type', 'application/octet-stream');
    expect(res.status).toBe(411);
  });

  it('tokens expire, and only open with their own key', () => {
    const key = relayKey('a'.repeat(40));
    const sealed = sealRelayToken(
      { op: 'get', k: 'k', n: 'n', t: 'application/pdf', e: 1_000 },
      key,
    );
    expect(openRelayToken(sealed, key, 999)?.k).toBe('k');
    expect(openRelayToken(sealed, key, 1_000)).toBeNull();
    expect(openRelayToken(sealed, relayKey('b'.repeat(40)), 999)).toBeNull();
    expect(openRelayToken('', key)).toBeNull();
  });

  it('is not mounted unless enabled, and production refuses it', async () => {
    const direct = buildApp();
    expect((await request(direct.app).get('/api/v1/storage-relay/x')).status).toBe(404);
    expect(() =>
      testEnv({
        NODE_ENV: 'production',
        CLAMAV_HOST: 'clamav',
        STRIPE_SECRET_KEY: 'sk_test_x',
        S3_SSE: 'aws:kms',
        S3_BROWSER_ACCESS: 'relay',
      }),
    ).toThrow(/S3_BROWSER_ACCESS/);
  });

  it('keeps relay tokens out of the logs', () => {
    expect(redactPath('/api/v1/storage-relay/abcDEF123?x=1')).toBe('/api/v1/storage-relay/[token]');
  });
});
