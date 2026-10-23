import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD } from './constants';
import {
  SEED,
  bearer,
  buildApp,
  caseIdByNumber,
  login,
  orgId,
  prisma,
  uniqueEmail,
} from './helpers';

const { app, mailer } = buildApp();
const get = (path: string, token: string) => request(app).get(path).set(bearer(token));

let acmeCase1: string; // Acme, created by acme client_user, draft
let acmeCase2: string; // Acme, created by acme client_user, assigned to summarizer + qa_reviewer
let harborCase: string; // Harbor
const tokens: Record<string, string> = {};

beforeAll(async () => {
  acmeCase1 = await caseIdByNumber('DS-SEED-0001');
  acmeCase2 = await caseIdByNumber('DS-SEED-0002');
  harborCase = await caseIdByNumber('DS-SEED-0003');
  for (const email of [
    SEED.acmeAdmin,
    SEED.acmeUser,
    SEED.harborAdmin,
    SEED.internal('super_admin'),
    SEED.internal('ops_manager'),
    SEED.internal('case_manager'),
    SEED.internal('summarizer'),
    SEED.internal('qa_reviewer'),
    SEED.internal('sales'),
    SEED.internal('finance'),
  ]) {
    tokens[email] = (await login(app, email)).token;
  }
});

afterAll(() => prisma.$disconnect());

/**
 * Every client-data route that takes an id (§13: "generated from the route list").
 * Add new client-data routes here as they are built; the isolation tests below run against all of them.
 */
const CLIENT_DATA_ROUTES: { name: string; path: (caseId: string) => string }[] = [
  { name: 'case detail', path: (id) => `/api/v1/cases/${id}` },
  { name: 'case documents', path: (id) => `/api/v1/cases/${id}/documents` },
  { name: 'case deliverables', path: (id) => `/api/v1/cases/${id}/deliverables` },
];

describe('§4.4 rule 1: a client user can never read another organisation’s data', () => {
  for (const route of CLIENT_DATA_ROUTES) {
    it(`Acme admin and user get 404 for Harbor's ${route.name}`, async () => {
      for (const email of [SEED.acmeAdmin, SEED.acmeUser]) {
        const res = await get(route.path(harborCase), tokens[email]!);
        expect(res.status, `${email} ${route.name}`).toBe(404);
      }
    });

    it(`Harbor admin gets 404 for Acme's ${route.name}`, async () => {
      expect((await get(route.path(acmeCase1), tokens[SEED.harborAdmin]!)).status).toBe(404);
    });
  }

  it('case lists only ever contain the caller’s own organisation', async () => {
    const acme = await orgId('acme');
    const harbor = await orgId('harbor');
    const a = await get('/api/v1/cases', tokens[SEED.acmeAdmin]!);
    expect(a.status).toBe(200);
    expect(a.body.items.length).toBeGreaterThanOrEqual(2);
    expect(a.body.items.every((c: { organizationId: string }) => c.organizationId === acme)).toBe(
      true,
    );
    const h = await get('/api/v1/cases', tokens[SEED.harborAdmin]!);
    expect(h.body.items.every((c: { organizationId: string }) => c.organizationId === harbor)).toBe(
      true,
    );
  });

  it('even a custom role with all-scope grants cannot cross organisations for a client user', async () => {
    const perms = await prisma.permission.findMany({
      where: {
        module: { in: ['cases', 'documents', 'deliverables'] },
        action: 'view',
        scope: 'all',
      },
    });
    const role = await prisma.role.create({
      data: {
        key: `custom_wide_${Date.now()}`,
        name: 'Misconfigured wide role',
        permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
      },
    });
    const email = uniqueEmail('wide');
    await prisma.user.create({
      data: {
        email,
        name: 'Wide Role User',
        organizationId: await orgId('acme'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const { token } = await login(app, email);
    for (const route of CLIENT_DATA_ROUTES) {
      expect((await get(route.path(harborCase), token)).status).toBe(404);
      expect((await get(route.path(acmeCase1), token)).status).toBe(200);
    }
    const list = await get('/api/v1/cases', token);
    const acme = await orgId('acme');
    expect(
      list.body.items.every((c: { organizationId: string }) => c.organizationId === acme),
    ).toBe(true);
  });
});

describe('§4.4 rule 2: sales and finance can never read medical records or deliverables', () => {
  for (const role of ['sales', 'finance'] as const) {
    it(`${role} is refused on every case, document and deliverable route`, async () => {
      const token = tokens[SEED.internal(role)]!;
      expect((await get('/api/v1/cases', token)).status).toBe(403);
      for (const route of CLIENT_DATA_ROUTES) {
        for (const id of [acmeCase1, acmeCase2, harborCase]) {
          const res = await get(route.path(id), token);
          expect(res.status, `${role} ${route.name}`).toBe(403);
          expect(JSON.stringify(res.body)).not.toMatch(/patientName|Jacobs|Okuneva|Schmeler/);
        }
      }
    });
  }
});

describe('scopes', () => {
  it('summarizer and QA reviewer see only cases assigned to them', async () => {
    for (const role of ['summarizer', 'qa_reviewer'] as const) {
      const token = tokens[SEED.internal(role)]!;
      expect((await get(`/api/v1/cases/${acmeCase2}`, token)).status).toBe(200);
      expect((await get(`/api/v1/cases/${acmeCase1}`, token)).status).toBe(404);
      const list = await get('/api/v1/cases', token);
      expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([acmeCase2]);
    }
  });

  it('super_admin, ops_manager and case_manager see every organisation', async () => {
    for (const role of ['super_admin', 'ops_manager', 'case_manager'] as const) {
      const token = tokens[SEED.internal(role)]!;
      expect((await get(`/api/v1/cases/${harborCase}`, token)).status).toBe(200);
      expect((await get(`/api/v1/cases/${acmeCase1}`, token)).status).toBe(200);
    }
  });

  it('client_user sees own cases and shared cases, not the rest of the firm', async () => {
    const email = uniqueEmail('colleague');
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_user' } });
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Acme Colleague',
        organizationId: await orgId('acme'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const { token } = await login(app, email);
    expect((await get(`/api/v1/cases/${acmeCase1}`, token)).status).toBe(404);
    expect((await get('/api/v1/cases', token)).body.items).toEqual([]);

    await prisma.caseShare.create({ data: { caseId: acmeCase1, userId: user.id } });
    expect((await get(`/api/v1/cases/${acmeCase1}`, token)).status).toBe(200);
    expect((await get(`/api/v1/cases/${acmeCase2}`, token)).status).toBe(404);
  });

  it('decrypts patient names only for callers who may see the case', async () => {
    const res = await get(`/api/v1/cases/${acmeCase1}`, tokens[SEED.acmeAdmin]!);
    expect(res.body.patientName).toBe('Ramiro608 Jacobs452');
    const row = await prisma.case.findUniqueOrThrow({ where: { id: acmeCase1 } });
    expect(row.patientName).toMatch(/^v1:/);
  });

  it('custom role changes take effect on the next request, without restart', async () => {
    const email = uniqueEmail('custom');
    const role = await prisma.role.create({
      data: { key: `custom_${Date.now()}`, name: 'Custom' },
    });
    await prisma.user.create({
      data: {
        email,
        name: 'Custom Role User',
        organizationId: await orgId('internal'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    // internal → MFA enrolment required; enable directly with the shared test secret
    const finance = await prisma.user.findUniqueOrThrow({
      where: { email: SEED.internal('finance') },
    });
    await prisma.user.update({
      where: { email },
      data: { mfaEnabled: true, mfaSecret: finance.mfaSecret },
    });
    const { token } = await login(app, email);
    expect((await get('/api/v1/cases', token)).status).toBe(403);

    const perm = await prisma.permission.findUniqueOrThrow({
      where: { module_action_scope: { module: 'cases', action: 'view', scope: 'all' } },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    expect((await get('/api/v1/cases', token)).status).toBe(200);
  });
});

describe('§4.4 rule 3: document and deliverable views are audited', () => {
  it('writes an AuditLog row per view with actor, entity and IP', async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeAdmin } });
    const before = await prisma.auditLog.count({ where: { actorId: actor.id } });
    await get(`/api/v1/cases/${acmeCase1}/documents`, tokens[SEED.acmeAdmin]!);
    await get(`/api/v1/cases/${acmeCase1}/deliverables`, tokens[SEED.acmeAdmin]!);
    const rows = await prisma.auditLog.findMany({
      where: { actorId: actor.id },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    expect(await prisma.auditLog.count({ where: { actorId: actor.id } })).toBe(before + 2);
    expect(rows.map((r) => r.action).sort()).toEqual(['deliverable.list', 'document.list']);
    expect(rows.every((r) => r.entityId === acmeCase1 && r.ip)).toBe(true);
  });

  it('refused attempts do not produce view audit rows', async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeAdmin } });
    const before = await prisma.auditLog.count({
      where: { actorId: actor.id, entityId: harborCase },
    });
    await get(`/api/v1/cases/${harborCase}/documents`, tokens[SEED.acmeAdmin]!);
    expect(
      await prisma.auditLog.count({ where: { actorId: actor.id, entityId: harborCase } }),
    ).toBe(before);
  });
});

describe('invites (§5.2)', () => {
  const invite = (token: string, body: object) =>
    request(app).post('/api/v1/invites').set(bearer(token)).send(body);

  it('client_admin invites a colleague; the link creates a verified user in that firm', async () => {
    const email = uniqueEmail('invitee');
    const res = await invite(tokens[SEED.acmeAdmin]!, {
      organizationId: await orgId('acme'),
      email,
      roleKey: 'client_user',
    });
    expect(res.status).toBe(201);
    const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThanOrEqual(72);

    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
    const accept = await request(app)
      .post(`/api/v1/invites/${token}/accept`)
      .send({ name: 'Invited Colleague', password: TEST_PASSWORD });
    expect(accept.status).toBe(201);
    const again = await request(app)
      .post(`/api/v1/invites/${token}/accept`)
      .send({ name: 'Invited Colleague', password: TEST_PASSWORD });
    expect(again.status).toBe(400);

    const { token: access } = await login(app, email);
    const me = await get('/api/v1/auth/me', access);
    expect(me.body.user.organizationId).toBe(await orgId('acme'));
    expect(me.body.roles).toEqual(['client_user']);
  });

  it('client_admin cannot invite into another firm or grant internal roles', async () => {
    const t = tokens[SEED.acmeAdmin]!;
    const other = await invite(t, {
      organizationId: await orgId('harbor'),
      email: uniqueEmail('x'),
      roleKey: 'client_user',
    });
    expect(other.status).toBe(404);
    const internalRole = await invite(t, {
      organizationId: await orgId('acme'),
      email: uniqueEmail('x'),
      roleKey: 'case_manager',
    });
    expect(internalRole.status).toBe(403);
  });

  it('ops_manager cannot grant super_admin; super_admin can', async () => {
    const internal = await orgId('internal');
    const ops = await invite(tokens[SEED.internal('ops_manager')]!, {
      organizationId: internal,
      email: uniqueEmail('sa'),
      roleKey: 'super_admin',
    });
    expect(ops.status).toBe(403);
    const sa = await invite(tokens[SEED.internal('super_admin')]!, {
      organizationId: internal,
      email: uniqueEmail('sa'),
      roleKey: 'super_admin',
    });
    expect(sa.status).toBe(201);
  });

  it('roles must match the organisation type', async () => {
    const res = await invite(tokens[SEED.internal('ops_manager')]!, {
      organizationId: await orgId('acme'),
      email: uniqueEmail('x'),
      roleKey: 'sales',
    });
    expect(res.status).toBe(403);
  });

  it('roles without users:create are refused', async () => {
    const res = await invite(tokens[SEED.internal('sales')]!, {
      organizationId: await orgId('acme'),
      email: uniqueEmail('x'),
      roleKey: 'client_user',
    });
    expect(res.status).toBe(403);
  });

  it('rejects existing emails, unknown roles and expired invites', async () => {
    const t = tokens[SEED.acmeAdmin]!;
    const acme = await orgId('acme');
    expect(
      (await invite(t, { organizationId: acme, email: SEED.acmeUser, roleKey: 'client_user' }))
        .status,
    ).toBe(409);
    expect(
      (await invite(t, { organizationId: acme, email: uniqueEmail('x'), roleKey: 'nope' })).status,
    ).toBe(400);

    const email = uniqueEmail('late');
    await invite(t, { organizationId: acme, email, roleKey: 'client_user' });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)!.text)![1]!;
    await prisma.invite.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app)
      .post(`/api/v1/invites/${token}/accept`)
      .send({ name: 'Late', password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invite_invalid');
  });
});

describe('GET /permissions', () => {
  it('is available to user managers and refused to others', async () => {
    const ok = await get('/api/v1/permissions', tokens[SEED.internal('super_admin')]!);
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(448);
    expect((await get('/api/v1/permissions', tokens[SEED.acmeUser]!)).status).toBe(403);
  });
});
