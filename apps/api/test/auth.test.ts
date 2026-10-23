import { encrypt } from '@datascribe/shared';
import { authenticator } from 'otplib';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { tokenFromMail } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/password';
import { TEST_PASSWORD, testPhiKey } from './constants';
import {
  CSRF,
  SEED,
  bearer,
  buildApp,
  login,
  orgId,
  prisma,
  testEnv,
  uniqueEmail,
} from './helpers';

const { app, mailer } = buildApp();
const api = () => request(app);
const loginReq = (email: string, password = TEST_PASSWORD) =>
  api().post('/api/v1/auth/login').send({ email, password });
const cookieOf = (res: request.Response) => String(res.headers['set-cookie']).split(';')[0]!;

afterAll(() => prisma.$disconnect());

/** A fresh, verified client user in Acme (no MFA) for tests that mutate account state. */
async function makeClientUser(opts: { mfaSecret?: string } = {}) {
  const email = uniqueEmail('client');
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_user' } });
  await prisma.user.create({
    data: {
      email,
      name: 'Synthetic Test User',
      organizationId: await orgId('acme'),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      mfaEnabled: !!opts.mfaSecret,
      mfaSecret: opts.mfaSecret ? encrypt(opts.mfaSecret, testPhiKey) : null,
      roles: { create: { roleId: role.id } },
    },
  });
  return email;
}

describe('login', () => {
  it('client user without MFA gets an access token and a hardened refresh cookie', async () => {
    const res = await loginReq(SEED.acmeUser);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ds_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('wrong password and unknown email give the same 401', async () => {
    const wrong = await loginReq(SEED.acmeUser, 'nope-nope-nope');
    const unknown = await loginReq('nobody@test.example', 'nope-nope-nope');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error.code).toBe('invalid_credentials');
  });

  it('rejects malformed input with field paths only', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  it('rejects invalid JSON bodies', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_body');
  });

  it('locks the account for 15 minutes after 5 failed attempts (§5.2)', async () => {
    const email = await makeClientUser();
    for (let i = 0; i < 5; i++)
      expect((await loginReq(email, 'wrong-password-x')).status).toBe(401);
    const locked = await loginReq(email);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('account_locked');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const minutes = (user.lockedUntil!.getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(
      await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.lockout' } }),
    ).toBe(1);
  });

  it('refuses suspended users', async () => {
    const email = await makeClientUser();
    await prisma.user.update({ where: { email }, data: { status: 'suspended' } });
    expect((await loginReq(email)).status).toBe(403);
  });

  it('rate-limits login per IP', async () => {
    const limited = buildApp({
      rateLimits: { windowMs: 60_000, authPerWindow: 2, publicPerWindow: 2 },
    });
    const body = { email: 'nobody@test.example', password: 'x' };
    await request(limited.app).post('/api/v1/auth/login').send(body);
    await request(limited.app).post('/api/v1/auth/login').send(body);
    const third = await request(limited.app).post('/api/v1/auth/login').send(body);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
  });

  it('without a trusted proxy, X-Forwarded-For cannot reset the per-IP limit (audit M6)', async () => {
    const limited = buildApp({
      rateLimits: { windowMs: 60_000, authPerWindow: 2, publicPerWindow: 2 },
      envOverrides: { TRUST_PROXY: 'false' },
    });
    const body = { email: 'nobody@test.example', password: 'x' };
    const send = (ip: string) =>
      request(limited.app).post('/api/v1/auth/login').set('x-forwarded-for', ip).send(body);
    await send('203.0.113.1');
    await send('203.0.113.2');
    expect((await send('203.0.113.3')).status).toBe(429);
  });

  it('TRUST_PROXY=true is refused; the default trusts only the loopback proxy', () => {
    expect(() => testEnv({ TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(testEnv().TRUST_PROXY).toBe('loopback');
    expect(testEnv({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });

  it('limits attempts per account even when they come from many IPs (audit M6)', async () => {
    const limited = buildApp({
      rateLimits: {
        windowMs: 60_000,
        authPerWindow: 100,
        publicPerWindow: 100,
        accountPerWindow: 3,
      },
    });
    const email = await makeClientUser();
    const send = (i: number, target = email) =>
      request(limited.app)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', `198.51.100.${i}`)
        .send({ email: target.toUpperCase(), password: 'wrong-password-x' });
    for (let i = 1; i <= 3; i++) expect((await send(i)).status).toBe(401);
    const blocked = await send(4);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    // other accounts are unaffected
    expect((await send(5, 'nobody@test.example')).status).toBe(401);
    // reset mails to one inbox are capped the same way
    for (let i = 0; i < 3; i++)
      await request(limited.app).post('/api/v1/auth/forgot').send({ email: SEED.harborAdmin });
    expect(
      (await request(limited.app).post('/api/v1/auth/forgot').send({ email: SEED.harborAdmin }))
        .status,
    ).toBe(429);
  });
});

describe('MFA (§5.2)', () => {
  it('internal users with MFA must pass a TOTP step', async () => {
    const first = await loginReq(SEED.internal('sales'));
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    const bad = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: first.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_mfa_code');
    const { token } = await login(app, SEED.internal('sales'));
    expect(token).toBeTruthy();
  });

  it('internal users without MFA must enrol before getting a session', async () => {
    const email = uniqueEmail('staff');
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'sales' } });
    await prisma.user.create({
      data: {
        email,
        name: 'Synthetic Staff',
        organizationId: await orgId('internal'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const first = await loginReq(email);
    expect(first.body).toMatchObject({ mfaSetupRequired: true });

    const setup = await api()
      .post('/api/v1/auth/mfa/setup')
      .send({ mfaToken: first.body.mfaToken });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.mfaSecret).toMatch(/^v1:/); // encrypted at rest
    expect(stored.mfaSecret).not.toContain(setup.body.secret);

    const verify = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: first.body.mfaToken, code: authenticator.generate(setup.body.secret) });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).mfaEnabled).toBe(true);

    const again = await loginReq(email);
    expect(again.body).toMatchObject({ mfaRequired: true });
    const reSetup = await api()
      .post('/api/v1/auth/mfa/setup')
      .send({ mfaToken: again.body.mfaToken });
    expect(reSetup.status).toBe(409);
  });

  it('client users can enrol voluntarily while signed in', async () => {
    const email = await makeClientUser();
    const { token } = await login(app, email);
    const setup = await api().post('/api/v1/auth/mfa/setup').set(bearer(token)).send({});
    expect(setup.status).toBe(200);
    const verify = await api()
      .post('/api/v1/auth/mfa/verify')
      .set(bearer(token))
      .send({ code: authenticator.generate(setup.body.secret) });
    expect(verify.body).toEqual({ mfaEnabled: true });
    expect((await loginReq(email)).body.mfaRequired).toBe(true);
  });

  it('org policy can enforce MFA for client users', async () => {
    const email = await makeClientUser();
    const org = await prisma.organization.create({
      data: { name: 'Enforcing Firm (synthetic)', settings: { enforceMfa: true } },
    });
    await prisma.user.update({ where: { email }, data: { organizationId: org.id } });
    expect((await loginReq(email)).body.mfaSetupRequired).toBe(true);
  });

  it('rejects a forged MFA token', async () => {
    const res = await api()
      .post('/api/v1/auth/mfa/verify')
      .send({ mfaToken: 'forged.token.value', code: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('sessions', () => {
  it('/auth/me returns roles and permission keys', async () => {
    const { token } = await login(app, SEED.acmeAdmin);
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.roles).toEqual(['client_admin']);
    expect(me.body.permissions).toContain('cases:view:firm');
    expect(me.body.user.orgType).toBe('client');
  });

  it('rejects missing and malformed tokens', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('refresh rotates the token within the same family', async () => {
    const email = await makeClientUser();
    const { agent } = await login(app, email);
    const refreshed = await agent.post('/api/v1/auth/refresh').set(CSRF);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    const sessions = await prisma.session.findMany({
      where: { user: { email } },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[1]!.revokedAt).toBeNull();
    expect(sessions[1]!.familyId).toBe(sessions[0]!.familyId);
  });

  it('presenting a rotated refresh token revokes every session in its family', async () => {
    const email = await makeClientUser();
    const original = cookieOf(await loginReq(email));
    const rotated = await api().post('/api/v1/auth/refresh').set(CSRF).set('cookie', original);
    expect(rotated.status).toBe(200);
    const newCookie = cookieOf(rotated);

    const replay = await api().post('/api/v1/auth/refresh').set(CSRF).set('cookie', original);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('refresh_token_reused');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const reuseCount = () =>
      prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected', actorId: user.id } });
    expect(await reuseCount()).toBe(1);

    // The newest token was revoked with its family, so presenting it is also a reuse.
    expect(
      (await api().post('/api/v1/auth/refresh').set(CSRF).set('cookie', newCookie)).status,
    ).toBe(401);
    expect(await prisma.session.count({ where: { user: { email }, revokedAt: null } })).toBe(0);
    expect(await reuseCount()).toBe(2);
  });

  it('rotation keeps the sign-in expiry: a family cannot outlive 7 days (audit M5)', async () => {
    const email = await makeClientUser();
    const { agent } = await login(app, email);
    const first = await prisma.session.findFirstOrThrow({ where: { user: { email } } });
    // pretend the sign-in was 6 days 23 h ago: one hour of family lifetime is left
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await prisma.session.update({ where: { id: first.id }, data: { expiresAt } });

    const refreshed = await agent.post('/api/v1/auth/refresh').set(CSRF);
    expect(refreshed.status).toBe(200);
    const next = await prisma.session.findFirstOrThrow({
      where: { user: { email }, revokedAt: null },
    });
    expect(next.expiresAt.getTime()).toBe(expiresAt.getTime());
    const maxAge = Number(/Max-Age=(\d+)/i.exec(String(refreshed.headers['set-cookie']))?.[1]);
    expect(maxAge).toBeLessThanOrEqual(3600);

    await prisma.session.update({
      where: { id: next.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await agent.post('/api/v1/auth/refresh').set(CSRF);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('session_expired');
  });

  it('refresh re-checks MFA policy: an org that starts enforcing MFA ends unenrolled sessions (audit M5)', async () => {
    const email = await makeClientUser();
    const org = await prisma.organization.create({ data: { name: 'Late MFA Firm (synthetic)' } });
    await prisma.user.update({ where: { email }, data: { organizationId: org.id } });
    const { agent } = await login(app, email);
    expect((await agent.post('/api/v1/auth/refresh').set(CSRF)).status).toBe(200);

    await prisma.organization.update({
      where: { id: org.id },
      data: { settings: { enforceMfa: true } },
    });
    const res = await agent.post('/api/v1/auth/refresh').set(CSRF);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('mfa_required');
    expect(await prisma.session.count({ where: { user: { email }, revokedAt: null } })).toBe(0);
    expect((await loginReq(email)).body.mfaSetupRequired).toBe(true);
  });

  it('two concurrent refreshes with one token cannot both succeed (audit M1)', async () => {
    const email = await makeClientUser();
    const cookie = cookieOf(await loginReq(email));
    const send = () => api().post('/api/v1/auth/refresh').set(CSRF).set('cookie', cookie);
    const results = await Promise.all([send(), send(), send()]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    if (results.some((r) => r.body?.error?.code === 'refresh_token_reused')) {
      expect(await prisma.session.count({ where: { user: { email }, revokedAt: null } })).toBe(0);
    }
  });

  it('refresh and logout require the CSRF header and a matching Origin', async () => {
    const { agent } = await login(app, SEED.acmeUser);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(403);
    expect(
      (await agent.post('/api/v1/auth/refresh').set(CSRF).set('origin', 'https://evil.example'))
        .status,
    ).toBe(403);
    expect((await agent.post('/api/v1/auth/logout')).status).toBe(403);
  });

  it('trusts EXTRA_TRUSTED_ORIGINS for the CSRF origin check, nothing else', async () => {
    const extra = 'http://127.0.0.1:55704';
    const { app: previewApp } = buildApp({ envOverrides: { EXTRA_TRUSTED_ORIGINS: extra } });
    const agent = (await login(previewApp, SEED.acmeUser)).agent;
    expect((await agent.post('/api/v1/auth/refresh').set(CSRF).set('origin', extra)).status).toBe(
      200,
    );
    expect(
      (await agent.post('/api/v1/auth/refresh').set(CSRF).set('origin', 'https://evil.example'))
        .status,
    ).toBe(403);
  });

  it('refresh without a cookie, or with an unknown one, is 401', async () => {
    expect((await api().post('/api/v1/auth/refresh').set(CSRF)).status).toBe(401);
    const res = await api()
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('cookie', 'ds_refresh=unknown');
    expect(res.status).toBe(401);
  });

  it('logout revokes the session so refresh and the access token stop working', async () => {
    const email = await makeClientUser();
    const { agent, token } = await login(app, email);
    expect((await agent.post('/api/v1/auth/logout').set(CSRF)).status).toBe(204);
    expect((await agent.post('/api/v1/auth/refresh').set(CSRF)).status).toBe(401);
    const me = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('session_revoked');
  });

  it('revoke-all ends every session for the user', async () => {
    const email = await makeClientUser();
    const a = await login(app, email);
    const b = await login(app, email);
    expect((await api().post('/api/v1/auth/sessions/revoke-all').set(bearer(a.token))).status).toBe(
      204,
    );
    expect((await api().get('/api/v1/auth/me').set(bearer(b.token))).status).toBe(401);
  });

  it('idle timeout: 30 min in the portal (§5.2)', async () => {
    const email = await makeClientUser();
    const { token, agent } = await login(app, email);
    const s = await prisma.session.findFirstOrThrow({
      where: { user: { email }, revokedAt: null },
    });
    expect(s.surface).toBe('portal');
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    await prisma.session.update({ where: { id: s.id }, data: { lastUsedAt: ago(29) } });
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).status).toBe(200);
    await prisma.session.update({ where: { id: s.id }, data: { lastUsedAt: ago(31) } });
    const idle = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(idle.status).toBe(401);
    expect(idle.body.error.code).toBe('session_idle');
    expect((await agent.post('/api/v1/auth/refresh').set(CSRF)).status).toBe(401);
  });

  it('idle timeout: 15 min in the staff console (§5.2)', async () => {
    const { token } = await login(app, SEED.internal('finance'));
    const s = await prisma.session.findFirstOrThrow({
      where: { user: { email: SEED.internal('finance') }, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(s.surface).toBe('console');
    await prisma.session.update({
      where: { id: s.id },
      data: { lastUsedAt: new Date(Date.now() - 16 * 60_000) },
    });
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe('registration and email verification (§5.2)', () => {
  it('creates an Organization + client_admin; login waits for email verification', async () => {
    const email = uniqueEmail('founder');
    const reg = await api().post('/api/v1/auth/register').send({
      organizationName: 'New Firm (synthetic)',
      name: 'Founder',
      email,
      password: TEST_PASSWORD,
    });
    expect(reg.status).toBe(202);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { organization: true, roles: { include: { role: true } } },
    });
    expect(user.organization.type).toBe('client');
    expect(user.roles.map((r) => r.role.key)).toEqual(['client_admin']);

    const blocked = await loginReq(email);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_not_verified');

    const token = tokenFromMail(mailer.lastTo(email));
    expect((await api().post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await api().post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);

    const ok = await loginReq(email);
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('does not reveal whether an email is already registered', async () => {
    const before = await prisma.organization.count();
    const res = await api().post('/api/v1/auth/register').send({
      organizationName: 'Dup Firm',
      name: 'Dup',
      email: SEED.acmeUser,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(202);
    expect(await prisma.organization.count()).toBe(before);
    expect(mailer.lastTo(SEED.acmeUser)?.subject).toMatch(/sign-up attempt/);
  });

  it('enforces the password policy', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({
        organizationName: 'Weak Firm',
        name: 'W',
        email: uniqueEmail('weak'),
        password: 'short',
      });
    expect(res.status).toBe(400);
  });
});

describe('forgot / reset password (§5.2)', () => {
  it('unknown emails get the same 202 and no mail', async () => {
    const count = mailer.sent.length;
    expect(
      (await api().post('/api/v1/auth/forgot').send({ email: 'ghost@test.example' })).status,
    ).toBe(202);
    expect(mailer.sent.length).toBe(count);
  });

  it('resets the password, clears lockout, revokes sessions; the link is single-use', async () => {
    const email = await makeClientUser();
    const { token: oldAccess } = await login(app, email);
    await prisma.user.update({
      where: { email },
      data: { lockedUntil: new Date(Date.now() + 600_000) },
    });

    expect((await api().post('/api/v1/auth/forgot').send({ email })).status).toBe(202);
    const resetToken = tokenFromMail(mailer.lastTo(email));
    const newPassword = 'Brand-new-password-456!';
    const reset = () =>
      api().post('/api/v1/auth/reset').send({ token: resetToken, password: newPassword });
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(400);

    expect((await api().get('/api/v1/auth/me').set(bearer(oldAccess))).status).toBe(401);
    expect((await loginReq(email)).status).toBe(401);
    expect((await loginReq(email, newPassword)).status).toBe(200);
    expect(mailer.lastTo(email)?.subject).toMatch(/password was changed/);
  });

  it('rejects an unknown reset token', async () => {
    const res = await api()
      .post('/api/v1/auth/reset')
      .send({ token: 'x'.repeat(43), password: TEST_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('token_invalid');
  });
});
