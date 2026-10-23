import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenFromMail } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app, mailer } = buildApp();
const api = () => request(app);

afterAll(() => prisma.$disconnect());

/** A fresh verified user, so tests can suspend/reset without touching shared seed accounts. */
async function makeUser(org: 'acme' | 'harbor' | 'internal', role: RoleKey) {
  const email = uniqueEmail(role);
  const internal = org === 'internal';
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const user = await prisma.user.create({
    data: {
      email,
      name: `Synthetic ${role}`,
      organizationId: await orgId(org),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      mfaEnabled: internal,
      mfaSecret: internal ? encrypt(TEST_TOTP_SECRET, testPhiKey) : null,
      roles: { create: { roleId: r.id } },
    },
  });
  return { id: user.id, email };
}

const tokens: Record<string, string> = {};
beforeAll(async () => {
  for (const [k, email] of Object.entries({
    super: SEED.internal('super_admin'),
    ops: SEED.internal('ops_manager'),
    sales: SEED.internal('sales'),
    acmeAdmin: SEED.acmeAdmin,
    acmeUser: SEED.acmeUser,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});
const as = (who: string) => bearer(tokens[who]!);

describe('GET /admin/users', () => {
  it('super admin sees users across orgs, without secrets', async () => {
    const res = await api().get('/api/v1/admin/users?limit=500').set(as('super'));
    expect(res.status).toBe(200);
    const orgs = new Set(
      res.body.items.map((u: { organization: { id: string } }) => u.organization.id),
    );
    expect(orgs.has(await orgId('acme'))).toBe(true);
    expect(orgs.has(await orgId('harbor'))).toBe(true);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/passwordHash|mfaSecret/);
  });

  it('client admin only sees their own firm, even when asking for another', async () => {
    const harbor = await orgId('harbor');
    const res = await api()
      .get(`/api/v1/admin/users?organizationId=${harbor}`)
      .set(as('acmeAdmin'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    const own = await api().get('/api/v1/admin/users').set(as('acmeAdmin'));
    const acme = await orgId('acme');
    expect(own.body.items.length).toBeGreaterThan(0);
    for (const u of own.body.items) expect(u.organization.id).toBe(acme);
  });

  it('filters by search text and role', async () => {
    const res = await api()
      .get(`/api/v1/admin/users?role=client_admin&q=${encodeURIComponent('harbor')}`)
      .set(as('ops'));
    const items = res.body.items as { email: string; roles: { key: string }[] }[];
    expect(items.map((u) => u.email)).toContain(SEED.harborAdmin);
    for (const u of items) expect(u.roles.map((x) => x.key)).toContain('client_admin');
  });

  it('roles without users:view are refused', async () => {
    expect((await api().get('/api/v1/admin/users').set(as('sales'))).status).toBe(403);
    expect((await api().get('/api/v1/admin/users').set(as('acmeUser'))).status).toBe(403);
    expect((await api().get('/api/v1/admin/users')).status).toBe(401);
  });

  it('client admin gets 404 for a user in another firm', async () => {
    const other = await makeUser('harbor', 'client_user');
    const res = await api().get(`/api/v1/admin/users/${other.id}`).set(as('acmeAdmin'));
    expect(res.status).toBe(404);
  });
});

describe('suspend / reactivate', () => {
  it('suspending ends sessions at once and blocks sign-in; reactivating restores it', async () => {
    const target = await makeUser('acme', 'client_user');
    const session = await login(app, target.email);
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(200);

    const sus = await api().post(`/api/v1/admin/users/${target.id}/suspend`).set(as('acmeAdmin'));
    expect(sus.status).toBe(200);
    expect(sus.body.status).toBe('suspended');
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(401);
    const blocked = await api()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(403);

    const again = await api().post(`/api/v1/admin/users/${target.id}/suspend`).set(as('acmeAdmin'));
    expect(again.body.error.code).toBe('already_suspended');

    const re = await api().post(`/api/v1/admin/users/${target.id}/reactivate`).set(as('acmeAdmin'));
    expect(re.body.status).toBe('active');
    await login(app, target.email);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: target.id, action: { startsWith: 'admin.user.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['admin.user.suspended', 'admin.user.reactivated']);
    expect(audit[0]!.metadata).toMatchObject({ sessionsRevoked: 1 });
  });

  it('nobody can suspend themselves', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeAdmin } });
    const res = await api().post(`/api/v1/admin/users/${me.id}/suspend`).set(as('acmeAdmin'));
    expect(res.status).toBe(403);
  });

  it('ops manager cannot touch a super admin; super admin can', async () => {
    const target = await makeUser('internal', 'super_admin');
    const ops = await api().post(`/api/v1/admin/users/${target.id}/suspend`).set(as('ops'));
    expect(ops.status).toBe(403);
    const sup = await api().post(`/api/v1/admin/users/${target.id}/suspend`).set(as('super'));
    expect(sup.status).toBe(200);
  });

  it('ops manager can manage other internal staff and client users', async () => {
    const staff = await makeUser('internal', 'summarizer');
    expect(
      (await api().post(`/api/v1/admin/users/${staff.id}/suspend`).set(as('ops'))).status,
    ).toBe(200);
    const client = await makeUser('harbor', 'client_user');
    expect(
      (await api().post(`/api/v1/admin/users/${client.id}/suspend`).set(as('ops'))).status,
    ).toBe(200);
  });

  it('client user (no users:edit) is refused', async () => {
    const target = await makeUser('acme', 'client_user');
    const res = await api().post(`/api/v1/admin/users/${target.id}/suspend`).set(as('acmeUser'));
    expect(res.status).toBe(403);
  });
});

describe('reset MFA', () => {
  it('clears the secret, ends sessions, emails the user, and forces re-enrolment', async () => {
    const target = await makeUser('internal', 'summarizer');
    const session = await login(app, target.email);
    const res = await api().post(`/api/v1/admin/users/${target.id}/reset-mfa`).set(as('super'));
    expect(res.status).toBe(200);
    expect(res.body.mfaEnabled).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.mfaSecret).toBeNull();
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(401);
    expect(mailer.lastTo(target.email)?.subject).toMatch(/two-factor/i);

    const next = await api()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(next.body.mfaSetupRequired).toBe(true);
  });
});

describe('force password reset', () => {
  it('ends sessions, refuses sign-in until the emailed link is used', async () => {
    const target = await makeUser('acme', 'client_user');
    const session = await login(app, target.email);
    const res = await api()
      .post(`/api/v1/admin/users/${target.id}/force-password-reset`)
      .set(as('acmeAdmin'));
    expect(res.status).toBe(200);
    expect(res.body.mustResetPassword).toBe(true);
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(401);

    const refused = await api()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('password_reset_required');

    const token = tokenFromMail(mailer.lastTo(target.email));
    const newPassword = 'a-brand-new-synthetic-pass-42';
    const reset = await api().post('/api/v1/auth/reset').send({ token, password: newPassword });
    expect(reset.status).toBe(200);
    await login(app, target.email, newPassword);
  });

  it('a second forced reset invalidates the first link', async () => {
    const target = await makeUser('acme', 'client_user');
    await api().post(`/api/v1/admin/users/${target.id}/force-password-reset`).set(as('acmeAdmin'));
    const first = tokenFromMail(mailer.lastTo(target.email));
    await api().post(`/api/v1/admin/users/${target.id}/force-password-reset`).set(as('acmeAdmin'));
    const res = await api()
      .post('/api/v1/auth/reset')
      .send({ token: first, password: 'another-synthetic-pass-42' });
    expect(res.status).toBe(400);
  });
});
