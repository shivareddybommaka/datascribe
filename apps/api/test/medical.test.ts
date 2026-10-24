import {
  ATTRIBUTION,
  PrismaCacheStore,
  createMedicalData,
  requestHash,
  type CodeMatch,
  type MedicalData,
} from '@datascribe/medical-data';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app } = buildApp(); // default deps → mock medical providers
const tokens: Record<string, string> = {};
const get = (path: string, who: string) => request(app).get(path).set(bearer(tokens[who]!));

const SUMM = SEED.internal('summarizer');
const CM = SEED.internal('case_manager');
const QA = SEED.internal('qa_reviewer'); // medical_lookups:view, cases view-only (D-129)
const DENIED = [SEED.internal('sales'), SEED.internal('finance'), SEED.acmeAdmin, SEED.acmeUser];

beforeAll(async () => {
  for (const email of [SUMM, CM, QA, ...DENIED]) tokens[email] = (await login(app, email)).token;
});

/** An internal user on a new custom role holding exactly `keys` ("module:action:scope"). */
async function customRoleToken(keys: string[]) {
  const perms = await prisma.permission.findMany({
    where: {
      OR: keys.map((k) => {
        const [module, action, scope] = k.split(':');
        return { module, action, scope };
      }),
    },
  });
  expect(perms).toHaveLength(keys.length);
  const role = await prisma.role.create({
    data: {
      key: `custom_lookup_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: 'Custom lookup role',
      isInternal: true,
      permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
    },
  });
  // internal → MFA required; reuse the seeded users' test secret
  const { mfaSecret } = await prisma.user.findUniqueOrThrow({ where: { email: SUMM } });
  const email = uniqueEmail('lookup');
  await prisma.user.create({
    data: {
      email,
      name: 'Custom Lookup User',
      organizationId: await orgId('internal'),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      mfaEnabled: true,
      mfaSecret,
      roles: { create: { roleId: role.id } },
    },
  });
  return (await login(app, email)).token;
}
afterAll(() => prisma.$disconnect());

const ROUTES = [
  '/api/v1/medical/icd10?q=lumbar%20radiculopathy',
  '/api/v1/medical/rxnorm?q=gabapentin',
  '/api/v1/medical/drug-label?q=gabapentin',
  '/api/v1/medical/define?code=M54.16',
];

describe('access control (§9: staff only)', () => {
  it('requires authentication', async () => {
    for (const path of ROUTES) expect((await request(app).get(path)).status).toBe(401);
  });

  it('sales, finance and client users get 403 on every medical route', async () => {
    for (const who of DENIED) {
      for (const path of ROUTES) {
        const res = await get(path, who);
        expect(res.status, `${who} ${path}`).toBe(403);
      }
    }
  });

  it('summarizer, case manager and QA reviewer can use every route', async () => {
    for (const who of [SUMM, CM, QA]) {
      for (const path of ROUTES) expect((await get(path, who)).status, `${who} ${path}`).toBe(200);
    }
  });

  it('QA reviewer gets attributed, de-identified results like any coder', async () => {
    const q = encodeURIComponent('Mr. John Smith lumbar radiculopathy');
    const res = await get(`/api/v1/medical/icd10?q=${q}&limit=1`, QA);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('lumbar radiculopathy');
    expect(res.body.items[0]).toMatchObject({ system: 'ICD10CM', code: 'M54.16' });
    expect(res.body.attribution).toEqual(ATTRIBUTION.mock);
  });

  it('custom roles: medical_lookups:view or (legacy) cases:edit admits, neither is 403', async () => {
    const path = ROUTES[0]!;
    const lookupOnly = await customRoleToken(['medical_lookups:view:all']);
    expect((await request(app).get(path).set(bearer(lookupOnly))).status).toBe(200);
    const legacy = await customRoleToken(['cases:edit:assigned']);
    expect((await request(app).get(path).set(bearer(legacy))).status).toBe(200);
    const neither = await customRoleToken(['cases:view:all', 'qa_reviews:edit:all']);
    expect((await request(app).get(path).set(bearer(neither))).status).toBe(403);
  });
});

describe('GET /medical/icd10', () => {
  it('returns codes with source attribution', async () => {
    const res = await get('/api/v1/medical/icd10?q=lumbar%20radiculopathy&limit=3', SUMM);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('lumbar radiculopathy');
    expect(res.body.items[0]).toMatchObject({ system: 'ICD10CM', code: 'M54.16' });
    expect(res.body.attribution).toEqual(ATTRIBUTION.mock);
  });

  it('de-identifies the query and reports what was removed (not the values)', async () => {
    const q = encodeURIComponent('Mr. John Smith DOB 01/02/1950 lumbar radiculopathy');
    const res = await get(`/api/v1/medical/icd10?q=${q}`, SUMM);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('lumbar radiculopathy');
    expect(res.body.removed).toEqual(expect.arrayContaining(['name', 'date']));
    expect(JSON.stringify(res.body)).not.toMatch(/Smith|1950/);
  });

  it('refuses identifier-only and free-text input with 422, without echoing it', async () => {
    const onlyIds = await get(
      `/api/v1/medical/icd10?q=${encodeURIComponent('MRN 00123456')}`,
      SUMM,
    );
    expect(onlyIds.status).toBe(422);
    expect(onlyIds.body.error).toMatchObject({
      code: 'term_refused',
      details: { reason: 'empty' },
    });
    expect(JSON.stringify(onlyIds.body)).not.toContain('00123456');

    const sentence = encodeURIComponent(
      'patient reports worsening low back pain radiating to the left leg after lifting boxes',
    );
    const long = await get(`/api/v1/medical/icd10?q=${sentence}`, SUMM);
    expect(long.status).toBe(422);
    expect(long.body.error.details.reason).toBe('too_long');
  });

  it('validates input with Zod', async () => {
    expect((await get('/api/v1/medical/icd10', SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/icd10?q=a', SUMM)).status).toBe(400);
    expect((await get(`/api/v1/medical/icd10?q=${'a'.repeat(201)}`, SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/icd10?q=neck%20pain&limit=500', SUMM)).status).toBe(400);
  });
});

describe('GET /medical/rxnorm, /medical/drug-label, /medical/define', () => {
  it('normalises medications to RxCUIs', async () => {
    const res = await get('/api/v1/medical/rxnorm?q=gabapentin%20300%20mg', SUMM);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ system: 'RXNORM', code: '25480' });
    expect(res.body.attribution.source).toBeTruthy();
  });

  it('drug-label accepts a name or an RxCUI, but not both or neither', async () => {
    const byName = await get('/api/v1/medical/drug-label?q=ibuprofen', SUMM);
    expect(byName.body.label).toMatchObject({ source: ATTRIBUTION.mock.source });
    const byRxcui = await get('/api/v1/medical/drug-label?rxcui=25480', SUMM);
    expect(byRxcui.status).toBe(200);
    expect(byRxcui.body.label.indications).toMatch(/gabapentin/);
    expect((await get('/api/v1/medical/drug-label', SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/drug-label?q=x1&rxcui=1', SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/drug-label?rxcui=12a', SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/drug-label?q=unknownium', SUMM)).body.label).toBeNull();
  });

  it('define validates the code shape per system', async () => {
    const res = await get('/api/v1/medical/define?code=m54.16', SUMM);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'M54.16', system: 'ICD10CM' });
    expect(res.body.definition.title).toBe('Radiculopathy, lumbar region');
    expect((await get('/api/v1/medical/define?code=25480&system=RXNORM', SUMM)).status).toBe(200);
    expect((await get('/api/v1/medical/define?code=John%20Smith', SUMM)).status).toBe(400);
    expect((await get('/api/v1/medical/define?code=M54.16&system=HCPCS', SUMM)).status).toBe(400);
  });
});

describe('PrismaCacheStore on the MedicalApiCache table', () => {
  it('stores, reads, expires and purges rows by provider + request hash', async () => {
    const provider = `test-${Date.now().toString(36)}`;
    let now = Date.now();
    const store = new PrismaCacheStore(prisma.medicalApiCache, () => now);
    const hash = requestHash(['icd10cm', 'neck pain', 5]);
    await store.set(provider, hash, [{ code: 'M54.2' }], 60_000);
    await store.set(provider, hash, [{ code: 'M54.2', v: 2 }], 60_000); // upsert
    await store.set(provider, requestHash(['none']), null, 1_000);
    expect(await store.get(provider, hash)).toEqual([{ code: 'M54.2', v: 2 }]);
    expect(await store.get(provider, requestHash(['none']))).toBeNull();
    const rows = await prisma.medicalApiCache.findMany({ where: { provider } });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('neck pain'); // keys are hashes
    now += 2_000;
    expect(await store.get(provider, requestHash(['none']))).toBeUndefined();
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    await prisma.medicalApiCache.deleteMany({ where: { provider } });
  });
});

describe('adapters only ever see de-identified terms', () => {
  it('passes the cleaned term to the provider', async () => {
    const seen: string[] = [];
    const base = createMedicalData({ provider: 'mock' });
    const spy: MedicalData = {
      ...base,
      diagnosis: Object.assign(
        {
          search: async (term: string): Promise<CodeMatch[]> => {
            seen.push(term);
            return [];
          },
        },
        { attribution: base.diagnosis.attribution },
      ),
    };
    const { app: spyApp } = buildApp({ medical: spy });
    const { token } = await login(spyApp, SUMM);
    const q = encodeURIComponent('Ramiro608 Jacobs452 (555) 123-4567 neck pain');
    const res = await request(spyApp).get(`/api/v1/medical/icd10?q=${q}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]); // uncoded is a normal answer
    expect(seen).toEqual(['neck pain']);
  });
});
