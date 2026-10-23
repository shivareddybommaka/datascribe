import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { encryptLegacyPhi } from '../src/services/phi-backfill';
import { TEST_PASSWORD, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';
import { syntheticRecordPdf } from './synthetic-pdf';
import { uploadFile } from './upload-helpers';

const { app, mailer, storageReady } = buildApp();
const tokens: Record<string, string> = {};

const VALID = {
  matterName: 'Hammes v. Northside Transit (synthetic)',
  reference: 'ACME-PI-9001',
  patientName: 'Alethea838 Hammes673',
  incidentDate: '2025-02-11',
  caseType: 'personal_injury',
  requested: ['index', 'chronology', 'chronology'],
  priority: 'high',
  dueAt: '2026-12-01',
  notes: 'Client reports treatment at two synthetic clinics.',
};

const post = (path: string, token: string, body: object = {}) =>
  request(app).post(`/api/v1${path}`).set(bearer(token)).send(body);
const get = (path: string, token: string) => request(app).get(`/api/v1${path}`).set(bearer(token));

async function clientUser(prefix: string, role: 'client_user' | 'client_admin' = 'client_user') {
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const email = uniqueEmail(prefix);
  const user = await prisma.user.create({
    data: {
      email,
      name: `Acme ${prefix} (synthetic)`,
      organizationId: await orgId('acme'),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: r.id } },
    },
  });
  return { user, token: (await login(app, email)).token };
}

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
});

afterAll(() => prisma.$disconnect());

describe('creating cases (§5.3)', () => {
  it('client_user creates a draft case with a sequential number; PHI is encrypted at rest', async () => {
    const a = await post('/cases', tokens[SEED.acmeUser]!, VALID);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      status: 'draft',
      patientName: VALID.patientName,
      notes: VALID.notes,
      requested: ['index', 'chronology'],
      priority: 'high',
      organizationId: await orgId('acme'),
      can: { edit: true, submit: true, share: true, upload: true },
    });
    const year = new Date().getUTCFullYear();
    expect(a.body.number).toMatch(new RegExp(`^DS-${year}-\\d{6}$`));
    const b = await post('/cases', tokens[SEED.acmeUser]!, VALID);
    expect(Number(b.body.number.slice(-6))).toBe(Number(a.body.number.slice(-6)) + 1);

    const row = await prisma.case.findUniqueOrThrow({ where: { id: a.body.id } });
    expect(row.patientName).toMatch(/^v1:/);
    expect(row.notes).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain('Hammes673');
    expect(a.body.timeline).toEqual([
      expect.objectContaining({ action: 'case.create', status: 'draft' }),
    ]);
  });

  it('validates input', async () => {
    const t = tokens[SEED.acmeUser]!;
    for (const bad of [
      { ...VALID, matterName: '' },
      { ...VALID, patientName: undefined },
      { ...VALID, caseType: 'divorce' },
      { ...VALID, requested: [] },
      { ...VALID, requested: ['report'] },
      { ...VALID, incidentDate: '2999-01-01' },
      { ...VALID, incidentDate: '11/02/2025' },
      { ...VALID, notes: 'x'.repeat(5001) },
    ]) {
      expect((await post('/cases', t, bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
  });

  it('staff create on behalf of a firm; clients cannot target another firm', async () => {
    const acme = await orgId('acme');
    const cm = tokens[SEED.internal('case_manager')]!;
    expect((await post('/cases', cm, VALID)).status).toBe(400);
    const ok = await post('/cases', cm, { ...VALID, organizationId: acme });
    expect(ok.status).toBe(201);
    expect(ok.body.organizationId).toBe(acme);
    expect(
      (await post('/cases', cm, { ...VALID, organizationId: await orgId('internal') })).status,
    ).toBe(404);
    expect(
      (
        await post('/cases', tokens[SEED.acmeUser]!, {
          ...VALID,
          organizationId: await orgId('harbor'),
        })
      ).status,
    ).toBe(404);
  });

  it('sales and finance cannot create or list cases', async () => {
    for (const role of ['sales', 'finance'] as const) {
      const t = tokens[SEED.internal(role)]!;
      expect((await post('/cases', t, VALID)).status).toBe(403);
      expect((await get('/cases', t)).status).toBe(403);
    }
  });
});

describe('editing and submitting', () => {
  it('edits only while draft; submit needs an uploaded record; the timeline records it', async () => {
    const t = tokens[SEED.acmeUser]!;
    const c = (await post('/cases', t, VALID)).body;
    const patch = await request(app)
      .patch(`/api/v1/cases/${c.id}`)
      .set(bearer(t))
      .send({ matterName: 'Renamed (synthetic)', notes: '', priority: 'urgent' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body).toMatchObject({ matterName: 'Renamed (synthetic)', notes: null });
    expect(patch.body.patientName).toBe(VALID.patientName);
    const edit = await prisma.auditLog.findFirst({
      where: { entityId: c.id, action: 'case.edit' },
    });
    expect(edit?.metadata).toEqual({ fields: ['matterName', 'notes', 'priority'] });

    const early = await post(`/cases/${c.id}/submit`, t);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('no_documents');

    const pdf = await syntheticRecordPdf({ pages: 2 });
    expect((await uploadFile(app, t, c.id, pdf.bytes)).status).toBe(200);
    const sub = await post(`/cases/${c.id}/submit`, t);
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('submitted');
    expect(sub.body.submittedAt).toBeTruthy();
    expect(sub.body.timeline.map((e: { status: string }) => e.status)).toEqual([
      'draft',
      'submitted',
    ]);
    expect(sub.body.can).toMatchObject({ edit: false, submit: false, upload: true });

    expect((await post(`/cases/${c.id}/submit`, t)).status).toBe(409);
    const locked = await request(app)
      .patch(`/api/v1/cases/${c.id}`)
      .set(bearer(t))
      .send({ matterName: 'Too late' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('case_locked');
  });
});

describe('listing and filtering', () => {
  it('filters by status, type and text, and audits the list (L4)', async () => {
    const t = tokens[SEED.acmeAdmin]!;
    const marker = `Filterable ${Date.now()}`;
    const c = (await post('/cases', t, { ...VALID, matterName: marker, caseType: 'med_mal' })).body;
    const byText = await get(`/cases?q=${encodeURIComponent(marker)}`, t);
    expect(byText.body.items.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(byText.body.total).toBe(1);
    const drafts = await get('/cases?status=draft,submitted&caseType=med_mal&limit=100', t);
    expect(drafts.body.items.every((x: { caseType: string }) => x.caseType === 'med_mal')).toBe(
      true,
    );
    expect(drafts.body.items.some((x: { id: string }) => x.id === c.id)).toBe(true);
    expect((await get('/cases?status=nope', t)).status).toBe(400);
    const sorted = await get('/cases?sort=due&open=true', t);
    expect(sorted.status).toBe(200);
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeAdmin } });
    expect(
      await prisma.auditLog.count({ where: { actorId: actor.id, action: 'case.list' } }),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('sharing within the firm (CaseShare)', () => {
  it('owner shares with a colleague, who then sees it but cannot re-share; unshare revokes', async () => {
    const owner = tokens[SEED.acmeUser]!;
    const c = (await post('/cases', owner, VALID)).body;
    const colleague = await clientUser('sharee');
    const third = await clientUser('third');
    expect((await get(`/cases/${c.id}`, colleague.token)).status).toBe(404);

    const candidates = await get(`/cases/${c.id}/share-candidates`, owner);
    const ids = candidates.body.items.map((u: { id: string }) => u.id);
    expect(ids).toContain(colleague.user.id);
    expect(ids).not.toContain(c.createdById);
    const harborUser = await prisma.user.findUniqueOrThrow({ where: { email: SEED.harborAdmin } });
    expect(ids).not.toContain(harborUser.id);

    const share = await post(`/cases/${c.id}/shares`, owner, { userId: colleague.user.id });
    expect(share.status).toBe(201);
    expect(share.body.shares.map((u: { id: string }) => u.id)).toEqual([colleague.user.id]);
    const seen = await get(`/cases/${c.id}`, colleague.token);
    expect(seen.status).toBe(200);
    expect(seen.body.can.share).toBe(false);
    expect(
      (await post(`/cases/${c.id}/shares`, colleague.token, { userId: third.user.id })).status,
    ).toBe(403);

    // other firms' users look like unknown ids
    expect((await post(`/cases/${c.id}/shares`, owner, { userId: harborUser.id })).status).toBe(
      400,
    );
    // the firm admin can manage sharing on any firm case
    expect(
      (await post(`/cases/${c.id}/shares`, tokens[SEED.acmeAdmin]!, { userId: third.user.id }))
        .status,
    ).toBe(201);

    const un = await request(app)
      .delete(`/api/v1/cases/${c.id}/shares/${colleague.user.id}`)
      .set(bearer(owner));
    expect(un.status).toBe(204);
    expect((await get(`/cases/${c.id}`, colleague.token)).status).toBe(404);
    const actions = (
      await prisma.auditLog.findMany({ where: { entityId: c.id }, select: { action: true } })
    ).map((a) => a.action);
    expect(actions.filter((a) => a === 'case.share')).toHaveLength(2);
    expect(actions).toContain('case.unshare');
  });

  it('another firm cannot see or share the case', async () => {
    const c = (await post('/cases', tokens[SEED.acmeUser]!, VALID)).body;
    const h = tokens[SEED.harborAdmin]!;
    expect((await get(`/cases/${c.id}/share-candidates`, h)).status).toBe(404);
    expect((await post(`/cases/${c.id}/shares`, h, { userId: 'x' })).status).toBe(404);
  });
});

describe('messages with Datascribe staff', () => {
  it('internal-only notes are hidden from clients; bodies are encrypted at rest', async () => {
    const client = tokens[SEED.acmeUser]!;
    const staff = tokens[SEED.internal('case_manager')]!;
    const c = (await post('/cases', client, VALID)).body;

    const m1 = await post(`/cases/${c.id}/messages`, client, {
      body: 'Records from the synthetic ER are attached.',
    });
    expect(m1.status).toBe(201);
    expect(m1.body.author.staff).toBe(false);
    expect(
      (await post(`/cases/${c.id}/messages`, staff, { body: 'Thanks, received.' })).status,
    ).toBe(201);
    expect(
      (
        await post(`/cases/${c.id}/messages`, staff, {
          body: 'Internal: check page 40 handwriting.',
          internalOnly: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (await post(`/cases/${c.id}/messages`, client, { body: 'sneaky', internalOnly: true }))
        .status,
    ).toBe(403);
    expect((await post(`/cases/${c.id}/messages`, client, { body: '  ' })).status).toBe(400);

    const seenByClient = await get(`/cases/${c.id}/messages`, client);
    expect(seenByClient.body.items.map((m: { body: string }) => m.body)).toEqual([
      'Records from the synthetic ER are attached.',
      'Thanks, received.',
    ]);
    expect(seenByClient.body.items[1].author.staff).toBe(true);
    const seenByStaff = await get(`/cases/${c.id}/messages`, staff);
    expect(seenByStaff.body.items).toHaveLength(3);
    expect(seenByStaff.body.items[2].internalOnly).toBe(true);

    const rows = await prisma.message.findMany({ where: { caseId: c.id } });
    expect(rows.every((r) => r.body.startsWith('v1:'))).toBe(true);
    expect((await get(`/cases/${c.id}/messages`, tokens[SEED.harborAdmin]!)).status).toBe(404);
    expect((await get(`/cases/${c.id}/messages`, tokens[SEED.internal('sales')]!)).status).toBe(
      403,
    );
  });
});

describe('audit L5: plaintext notes and message bodies', () => {
  it('the database refuses plaintext in encrypted columns', async () => {
    const c = await prisma.case.findFirstOrThrow({
      where: { organizationId: await orgId('acme') },
    });
    await expect(
      prisma.message.create({ data: { caseId: c.id, authorId: c.createdById, body: 'plain' } }),
    ).rejects.toThrow();
    await expect(
      prisma.case.update({ where: { id: c.id }, data: { notes: 'plain notes' } }),
    ).rejects.toThrow();
  });

  it('the startup backfill encrypts legacy rows and validates the constraints', async () => {
    const c = await prisma.case.findFirstOrThrow({
      where: { organizationId: await orgId('acme') },
    });
    // recreate a pre-M4 database: constraints absent while legacy rows are written
    await prisma.$executeRawUnsafe('ALTER TABLE "Case" DROP CONSTRAINT "Case_notes_encrypted"');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Message" DROP CONSTRAINT "Message_body_encrypted"',
    );
    await prisma.case.update({ where: { id: c.id }, data: { notes: 'Legacy synthetic note' } });
    const m = await prisma.message.create({
      data: { caseId: c.id, authorId: c.createdById, body: 'Legacy synthetic message' },
    });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Case" ADD CONSTRAINT "Case_notes_encrypted" CHECK ("notes" IS NULL OR "notes" ~ '^v[0-9]+:') NOT VALID`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Message" ADD CONSTRAINT "Message_body_encrypted" CHECK ("body" ~ '^v[0-9]+:') NOT VALID`,
    );

    const result = await encryptLegacyPhi(prisma, testPhiKey);
    expect(result.cases).toBeGreaterThanOrEqual(1);
    expect(result.messages).toBeGreaterThanOrEqual(1);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: c.id } })).notes).toMatch(/^v1:/);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).body).toMatch(/^v1:/);
    const unvalidated = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE contype = 'c' AND NOT convalidated`;
    expect(Number(unvalidated[0]!.n)).toBe(0);
    // idempotent
    expect(await encryptLegacyPhi(prisma, testPhiKey)).toEqual({
      cases: 0,
      messages: 0,
      validated: 0,
    });
    const detail = await get(`/cases/${c.id}`, tokens[SEED.acmeAdmin]!);
    expect(detail.body.notes).toBe('Legacy synthetic note');
  });
});

describe('portal dashboard', () => {
  it('client_admin sees open cases by status, usage vs plan and outstanding invoices', async () => {
    const res = await get('/portal/dashboard', tokens[SEED.acmeAdmin]!);
    expect(res.status).toBe(200);
    const draft = res.body.openCases.find((s: { status: string }) => s.status === 'draft');
    expect(draft.count).toBeGreaterThan(0);
    expect(res.body.usage).toMatchObject({ includedPages: expect.any(Number) });
    expect(res.body.invoices).toMatchObject({ items: expect.any(Array) });
    expect(Array.isArray(res.body.recentDeliverables)).toBe(true);
  });

  it('client_user sees their cases only and no billing; staff are sent to the console', async () => {
    const fresh = await clientUser('dash');
    const res = await get('/portal/dashboard', fresh.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ openCases: [], usage: null, invoices: null });
    expect((await get('/portal/dashboard', tokens[SEED.internal('case_manager')]!)).status).toBe(
      403,
    );
  });
});

describe('firm management (client_admin)', () => {
  it('views and edits the firm profile and MFA policy; users then must set up MFA', async () => {
    const admin = tokens[SEED.acmeAdmin]!;
    const firm = await get('/firm', admin);
    expect(firm.status).toBe(200);
    expect(firm.body).toMatchObject({ id: await orgId('acme'), enforceMfa: false });

    const on = await request(app)
      .patch('/api/v1/firm')
      .set(bearer(admin))
      .send({ enforceMfa: true });
    expect(on.status).toBe(200);
    expect(on.body.enforceMfa).toBe(true);
    const signIn = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: SEED.acmeUser, password: TEST_PASSWORD });
    expect(signIn.body.mfaSetupRequired).toBe(true);

    const off = await request(app)
      .patch('/api/v1/firm')
      .set(bearer(admin))
      .send({ enforceMfa: false });
    expect(off.body.enforceMfa).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'organization.update', entityId: await orgId('acme') },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toEqual({ fields: ['enforceMfa'], enforceMfa: false });
  });

  it('lists pending invites; client_user and staff are refused', async () => {
    const admin = tokens[SEED.acmeAdmin]!;
    const email = uniqueEmail('pending');
    expect(
      (
        await post('/invites', admin, {
          organizationId: await orgId('acme'),
          email,
          roleKey: 'client_user',
        })
      ).status,
    ).toBe(201);
    expect(mailer.lastTo(email)).toBeTruthy();
    const list = await get('/firm/invites', admin);
    expect(list.body.items.some((i: { email: string }) => i.email === email)).toBe(true);
    const harbor = await get('/firm/invites', tokens[SEED.harborAdmin]!);
    expect(harbor.body.items.some((i: { email: string }) => i.email === email)).toBe(false);

    expect((await get('/firm', tokens[SEED.acmeUser]!)).status).toBe(403);
    expect(
      (
        await request(app)
          .patch('/api/v1/firm')
          .set(bearer(tokens[SEED.acmeUser]!))
          .send({ name: 'X Co' })
      ).status,
    ).toBe(403);
    expect((await get('/firm', tokens[SEED.internal('case_manager')]!)).status).toBe(403);
  });
});
