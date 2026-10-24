import { getBillingSettings } from '@datascribe/billing';
import { createMedicalData } from '@datascribe/medical-data';
import { encrypt, type RoleKey } from '@datascribe/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { signAccessToken } from '../src/lib/tokens';
import { TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, testEnv, uniqueEmail } from './helpers';

const { app, mailer } = buildApp();
const api = () => request(app);

afterAll(() => prisma.$disconnect());

/** A fresh verified user with the given role keys (system or custom). */
async function makeUser(org: 'acme' | 'harbor' | 'internal', roleKeys: string[]) {
  const email = uniqueEmail(roleKeys[0]!.replace(/_/g, '-'));
  const internal = org === 'internal';
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  const user = await prisma.user.create({
    data: {
      email,
      name: `Synthetic ${roleKeys.join('+')}`,
      organizationId: await orgId(org),
      passwordHash: await hashPassword(TEST_PASSWORD),
      emailVerifiedAt: new Date(),
      mfaEnabled: internal,
      mfaSecret: internal ? encrypt(TEST_TOTP_SECRET, testPhiKey) : null,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
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
    finance: SEED.internal('finance'),
    acmeAdmin: SEED.acmeAdmin,
    acmeUser: SEED.acmeUser,
  })) {
    tokens[k] = (await login(app, email)).token;
  }
});
const as = (who: string) => bearer(tokens[who]!);
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ───────────────────────────── Roles ─────────────────────────────

describe('roles: list and view', () => {
  it('internal admins see every role with its permission keys', async () => {
    const res = await api().get('/api/v1/roles').set(as('ops'));
    expect(res.status).toBe(200);
    const keys = res.body.items.map((r: { key: string }) => r.key);
    for (const k of ['super_admin', 'ops_manager', 'client_admin', 'client_user']) {
      expect(keys).toContain(k);
    }
    const sa = res.body.items.find((r: { key: string }) => r.key === 'super_admin');
    expect(sa).toMatchObject({ isSystem: true, locked: true, group: 'internal' });
    expect(sa.permissions).toContain('system_settings:edit:all');
  });

  it('client admins only see client roles', async () => {
    const res = await api().get('/api/v1/roles').set(as('acmeAdmin'));
    expect(res.status).toBe(200);
    for (const r of res.body.items) expect(r.group).toBe('client');
    const internal = await prisma.role.findUniqueOrThrow({ where: { key: 'sales' } });
    expect((await api().get(`/api/v1/roles/${internal.id}`).set(as('acmeAdmin'))).status).toBe(404);
  });

  it('roles without users:view get 403; GET /permissions lists the catalogue', async () => {
    for (const who of ['sales', 'finance', 'acmeUser']) {
      expect((await api().get('/api/v1/roles').set(as(who))).status).toBe(403);
    }
    const perms = await api().get('/api/v1/permissions').set(as('super'));
    expect(perms.status).toBe(200);
    expect(perms.body.items.length).toBe(16 * 7 * 4);
  });
});

describe('roles: create / edit / delete', () => {
  it('M2 DoD: a custom role takes effect on the next request, no restart', async () => {
    const auditor = await makeUser('internal', ['sales']);
    const { token } = await login(app, auditor.email);
    expect((await api().get('/api/v1/admin/audit-logs').set(bearer(token))).status).toBe(403);

    const created = await api()
      .post('/api/v1/roles')
      .set(as('super'))
      .send({
        name: `Audit reader ${stamp()}`,
        description: 'Reads the audit log (synthetic)',
        group: 'internal',
        permissions: ['audit_log:view:all'],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.key).toMatch(/^custom_audit_reader_/);
    expect(created.body.isSystem).toBe(false);

    const assign = await api()
      .put(`/api/v1/admin/users/${auditor.id}/roles`)
      .set(as('super'))
      .send({ roleKeys: ['sales', created.body.key] });
    expect(assign.status, JSON.stringify(assign.body)).toBe(200);

    // same access token, same process: the next request sees the new grant
    expect((await api().get('/api/v1/admin/audit-logs').set(bearer(token))).status).toBe(200);

    // and removing it from the matrix takes it away again
    const edit = await api()
      .patch(`/api/v1/roles/${created.body.id}`)
      .set(as('super'))
      .send({ permissions: [] });
    expect(edit.status).toBe(200);
    expect((await api().get('/api/v1/admin/audit-logs').set(bearer(token))).status).toBe(403);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: created.body.id, action: { startsWith: 'admin.role.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['admin.role.created', 'admin.role.updated']);
    expect(audit[1]!.metadata).toMatchObject({ removed: ['audit_log:view:all'], added: [] });
  });

  it('validates permission keys and the client-role rules', async () => {
    const post = (body: object) => api().post('/api/v1/roles').set(as('super')).send(body);
    expect(
      (await post({ name: `X ${stamp()}`, group: 'internal', permissions: ['cases:fly:all'] }))
        .status,
    ).toBe(400);
    const allScope = await post({
      name: `Client all ${stamp()}`,
      group: 'client',
      permissions: ['cases:view:all'],
    });
    expect(allScope.status).toBe(400);
    expect(allScope.body.error.code).toBe('client_role_scope');
    const crm = await post({
      name: `Client crm ${stamp()}`,
      group: 'client',
      permissions: ['crm:view:firm'],
    });
    expect(crm.body.error.code).toBe('client_role_scope');
    const reserved = await post({
      name: `Settings ${stamp()}`,
      group: 'internal',
      permissions: ['system_settings:view:all'],
    });
    expect(reserved.body.error.code).toBe('reserved_permission');
    expect(
      (await post({ name: 'Ops clone', key: 'ops_manager', group: 'internal', permissions: [] }))
        .status,
    ).toBe(409);
  });

  it('audit M4: ops manager can only grant permissions it holds', async () => {
    const post = (permissions: string[]) =>
      api()
        .post('/api/v1/roles')
        .set(as('ops'))
        .send({ name: `Ops made ${stamp()}`, group: 'internal', permissions });
    const tooMuch = await post(['crm:view:all', 'documents:edit:all']);
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.error.message).toContain('documents:edit:all');
    // narrower scope of something it holds is fine
    const ok = await post(['crm:view:all', 'cases:view:assigned']);
    expect(ok.status).toBe(201);

    // and it may not widen it later, nor touch built-in roles
    const widen = await api()
      .patch(`/api/v1/roles/${ok.body.id}`)
      .set(as('ops'))
      .send({ permissions: ['crm:view:all', 'audit_log:export:all'] });
    expect(widen.status).toBe(403);
    const builtIn = await prisma.role.findUniqueOrThrow({ where: { key: 'sales' } });
    expect(
      (
        await api()
          .patch(`/api/v1/roles/${builtIn.id}`)
          .set(as('ops'))
          .send({ name: 'Sales people' })
      ).status,
    ).toBe(403);
  });

  it('client admins, sales and finance cannot change roles', async () => {
    for (const who of ['acmeAdmin', 'sales', 'finance']) {
      const res = await api()
        .post('/api/v1/roles')
        .set(as(who))
        .send({ name: `Nope ${stamp()}`, group: 'client', permissions: [] });
      expect(res.status).toBe(403);
    }
  });

  it('system roles cannot be deleted; the super_admin role is locked', async () => {
    const sales = await prisma.role.findUniqueOrThrow({ where: { key: 'sales' } });
    const del = await api().delete(`/api/v1/roles/${sales.id}`).set(as('super'));
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe('system_role');
    const sa = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
    const edit = await api()
      .patch(`/api/v1/roles/${sa.id}`)
      .set(as('super'))
      .send({ permissions: [] });
    expect(edit.body.error.code).toBe('role_locked');
    // super admin may edit other built-in roles
    const desc = await api()
      .patch(`/api/v1/roles/${sales.id}`)
      .set(as('super'))
      .send({ description: 'Leads, accounts, pipeline. NO medical records (synthetic edit)' });
    expect(desc.status).toBe(200);
  });

  it('custom roles in use cannot be deleted; unused ones can (super admin only)', async () => {
    const role = await api()
      .post('/api/v1/roles')
      .set(as('super'))
      .send({ name: `Temp ${stamp()}`, group: 'client', permissions: ['cases:view:own'] });
    const user = await makeUser('acme', [role.body.key]);
    expect((await api().delete(`/api/v1/roles/${role.body.id}`).set(as('super'))).status).toBe(409);
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    expect((await api().delete(`/api/v1/roles/${role.body.id}`).set(as('ops'))).status).toBe(403);
    expect((await api().delete(`/api/v1/roles/${role.body.id}`).set(as('super'))).status).toBe(204);
    expect(
      await prisma.auditLog.count({
        where: { entityId: role.body.id, action: 'admin.role.deleted' },
      }),
    ).toBe(1);
  });
});

// ─────────────────── Users: create (invite) and role assignment ───────────────────

describe('users: create and assign roles', () => {
  it('POST /admin/users invites (and the template renders the link)', async () => {
    const email = uniqueEmail('new.staff');
    const res = await api()
      .post('/api/v1/admin/users')
      .set(as('super'))
      .send({ organizationId: await orgId('internal'), email, roleKey: 'case_manager' });
    expect(res.status).toBe(201);
    expect(mailer.lastTo(email)?.text).toMatch(/invite\/accept\?token=/);
  });

  it('audit M4: invites can only carry permissions the inviter holds', async () => {
    const acme = await orgId('acme');
    // ops_manager has documents:view only, so it can't hand out client_admin (documents:edit)
    const ops = await api()
      .post('/api/v1/admin/users')
      .set(as('ops'))
      .send({ organizationId: acme, email: uniqueEmail('x'), roleKey: 'client_admin' });
    expect(ops.status).toBe(403);
    // but it can invite roles inside its own grants
    const sales = await api()
      .post('/api/v1/admin/users')
      .set(as('ops'))
      .send({ organizationId: await orgId('internal'), email: uniqueEmail('x'), roleKey: 'sales' });
    expect(sales.status).toBe(201);
    // client admin can invite client users into its own firm only
    const own = await api()
      .post('/api/v1/admin/users')
      .set(as('acmeAdmin'))
      .send({ organizationId: acme, email: uniqueEmail('x'), roleKey: 'client_user' });
    expect(own.status).toBe(201);
    const cross = await api()
      .post('/api/v1/admin/users')
      .set(as('acmeAdmin'))
      .send({
        organizationId: await orgId('harbor'),
        email: uniqueEmail('x'),
        roleKey: 'client_user',
      });
    expect(cross.status).toBe(404);
  });

  it('role assignment follows the same rules', async () => {
    const put = (who: string, id: string, roleKeys: string[]) =>
      api().put(`/api/v1/admin/users/${id}/roles`).set(as(who)).send({ roleKeys });

    const staff = await makeUser('internal', ['summarizer']);
    expect((await put('ops', staff.id, ['super_admin'])).status).toBe(403);
    expect((await put('ops', staff.id, ['client_user'])).status).toBe(403); // wrong org type
    expect((await put('ops', staff.id, ['case_manager'])).status).toBe(403); // M4
    const ok = await put('ops', staff.id, ['sales']);
    expect(ok.status).toBe(200);
    expect(ok.body.roles.map((r: { key: string }) => r.key)).toEqual(['sales']);

    const client = await makeUser('acme', ['client_user']);
    expect((await put('acmeAdmin', client.id, ['client_admin'])).status).toBe(200);
    expect((await put('acmeAdmin', client.id, ['sales'])).status).toBe(403);
    const harbor = await makeUser('harbor', ['client_user']);
    expect((await put('acmeAdmin', harbor.id, ['client_admin'])).status).toBe(404);
    expect((await put('acmeUser', client.id, ['client_user'])).status).toBe(403);
    expect((await put('ops', client.id, ['nope'])).status).toBe(400);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: staff.id, action: 'admin.user.roles_changed' },
    });
    expect(audit?.metadata).toMatchObject({ before: ['summarizer'], after: ['sales'] });
  });
});

// ───────────────────────────── Organizations ─────────────────────────────

describe('organizations', () => {
  it('internal admins list and view orgs; others are refused', async () => {
    const res = await api().get('/api/v1/admin/organizations?type=client').set(as('ops'));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((o: { id: string }) => o.id);
    expect(ids).toContain(await orgId('acme'));
    expect(ids).not.toContain(await orgId('internal'));
    const one = await api()
      .get(`/api/v1/admin/organizations/${await orgId('acme')}`)
      .set(as('super'));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ retentionDays: 180, enforceMfa: false, customPricing: null });
    for (const who of ['sales', 'finance', 'acmeAdmin', 'acmeUser']) {
      expect((await api().get('/api/v1/admin/organizations').set(as(who))).status).toBe(403);
    }
  });

  it('edits name, plan, currency, MFA policy, retention and custom pricing', async () => {
    const org = await prisma.organization.create({
      data: { name: `Edit Me Law ${stamp()} (synthetic)`, type: 'client' },
    });
    const plan = await prisma.subscriptionPlan.findFirstOrThrow({ where: { active: true } });
    const res = await api()
      .patch(`/api/v1/admin/organizations/${org.id}`)
      .set(as('ops'))
      .send({
        name: 'Edited Law (synthetic)',
        planId: plan.id,
        currency: 'aud',
        enforceMfa: true,
        retentionDays: 365,
        customPricing: { priceMonthly: '999.00', includedPages: 3000, overagePerPage: 0.5 },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Edited Law (synthetic)',
      currency: 'AUD',
      enforceMfa: true,
      retentionDays: 365,
      plan: { id: plan.id },
      customPricing: { priceMonthly: '999.00', includedPages: 3000, overagePerPage: '0.5' },
    });
    const bad = await api()
      .patch(`/api/v1/admin/organizations/${org.id}`)
      .set(as('ops'))
      .send({ retentionDays: 1, type: 'internal' });
    expect(bad.status).toBe(400);
    expect(
      (
        await api()
          .patch(`/api/v1/admin/organizations/${org.id}`)
          .set(as('ops'))
          .send({ planId: 'nope' })
      ).status,
    ).toBe(400);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: org.id, action: 'admin.org.updated' },
    });
    expect(audit?.metadata).toMatchObject({ planId: plan.id });
  });

  it('suspending a firm ends its sessions and blocks sign-in; reactivating restores it', async () => {
    const org = await prisma.organization.create({
      data: { name: `Suspend Me Law ${stamp()} (synthetic)`, type: 'client' },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'client_user' } });
    const email = uniqueEmail('suspended.firm');
    await prisma.user.create({
      data: {
        email,
        name: 'Synthetic member',
        organizationId: org.id,
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const session = await login(app, email);

    const sus = await api().post(`/api/v1/admin/organizations/${org.id}/suspend`).set(as('super'));
    expect(sus.status).toBe(200);
    expect(sus.body.status).toBe('suspended');
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(401);
    const blocked = await api().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(403);

    const re = await api()
      .post(`/api/v1/admin/organizations/${org.id}/reactivate`)
      .set(as('super'));
    expect(re.body.status).toBe('active');
    await login(app, email);

    const actions = (
      await prisma.auditLog.findMany({
        where: { entityId: org.id, action: { startsWith: 'admin.org.' } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(['admin.org.suspended', 'admin.org.reactivated']);
  });

  it('the Datascribe org cannot be suspended', async () => {
    const res = await api()
      .post(`/api/v1/admin/organizations/${await orgId('internal')}/suspend`)
      .set(as('super'));
    expect(res.status).toBe(403);
  });
});

// ───────────────────────────── Settings ─────────────────────────────

describe('settings (super admin only)', () => {
  it('only super admin can read or change system settings', async () => {
    expect((await api().get('/api/v1/admin/settings').set(as('super'))).status).toBe(200);
    for (const who of ['ops', 'sales', 'finance', 'acmeAdmin']) {
      expect((await api().get('/api/v1/admin/settings').set(as(who))).status).toBe(403);
      expect((await api().put('/api/v1/admin/settings/sla').set(as(who)).send({})).status).toBe(
        403,
      );
    }
  });

  it('company + invoice settings feed billing', async () => {
    const res = await api()
      .put('/api/v1/admin/settings/company')
      .set(as('super'))
      .send({
        name: 'Datascribe (synthetic)',
        address: '1 Example St, Sydney NSW',
        email: 'billing@datascribe.example',
        taxId: 'ABN 00 000 000 000',
        taxLabel: 'GST',
        taxRatePercent: '10',
        taxByCurrency: { inr: { label: 'GST', ratePercent: 18 } },
        invoicePrefix: 'DS',
        paymentTermsDays: 30,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const billing = await getBillingSettings(prisma);
    expect(billing.company.name).toBe('Datascribe (synthetic)');
    expect(billing.tax).toEqual({ label: 'GST', ratePercent: '10.00' });
    expect(billing.taxByCurrency.INR).toEqual({ label: 'GST', ratePercent: '18.00' });
    expect(billing.invoicePrefix).toBe('DS');
    expect(billing.paymentTermsDays).toBe(30);
    // put things back for other suites
    await api()
      .put('/api/v1/admin/settings/company')
      .set(as('super'))
      .send({ name: 'Datascribe', taxLabel: 'GST', taxRatePercent: 0 });

    const bad = await api()
      .put('/api/v1/admin/settings/company')
      .set(as('super'))
      .send({ name: 'X', taxLabel: 'GST', taxRatePercent: 150, extra: true });
    expect(bad.status).toBe(400);
  });

  it('SLA defaults and notification rules round-trip', async () => {
    const sla = await api()
      .put('/api/v1/admin/settings/sla')
      .set(as('super'))
      .send({ turnaroundDays: { urgent: 1, high: 2, normal: 5, low: 10 }, dueSoonHours: 12 });
    expect(sla.status).toBe(200);
    expect(sla.body.dueSoonHours).toBe(12);

    const all = await api().get('/api/v1/admin/settings').set(as('super'));
    const rules = all.body.notifications.rules as Record<string, object>;
    rules.task_due = { email: false, inApp: true };
    const put = await api()
      .put('/api/v1/admin/settings/notifications')
      .set(as('super'))
      .send({ rules });
    expect(put.status).toBe(200);
    expect(put.body.rules.task_due).toEqual({ email: false, inApp: true });
    expect(
      (
        await api()
          .put('/api/v1/admin/settings/notifications')
          .set(as('super'))
          .send({ rules: { task_due: { email: false, inApp: true } } })
      ).status,
    ).toBe(400);
  });

  it('medical provider config shows usage and switches upstreams off', async () => {
    const get = await api().get('/api/v1/admin/settings/medical').set(as('super'));
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ provider: 'mock', openFdaApiKeyConfigured: false });
    expect(Array.isArray(get.body.usage24h)).toBe(true);
    const put = await api()
      .put('/api/v1/admin/settings/medical')
      .set(as('super'))
      .send({
        enabled: { 'nlm-ctss': true, 'nlm-rxnav': true, openfda: false, medlineplus: true },
      });
    expect(put.status).toBe(200);
    expect(put.body.enabled.openfda).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: 'medical', action: 'admin.settings.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({ disabled: ['openfda'] });
  });

  it('the medical settings still load when the shared usage counters are unavailable (D-112)', async () => {
    const medical = createMedicalData({ provider: 'mock' });
    medical.usageStats = async () => {
      throw new Error('Connection is closed.');
    };
    const down = buildApp({ medical });
    const get = await request(down.app).get('/api/v1/admin/settings/medical').set(as('super'));
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ provider: 'mock', usage24h: [] });
  });
});

describe('email templates', () => {
  it('lists templates with their variables', async () => {
    const res = await api().get('/api/v1/admin/email-templates').set(as('super'));
    expect(res.status).toBe(200);
    const invite = res.body.items.find((t: { key: string }) => t.key === 'invite');
    expect(invite.variables).toEqual(['inviterName', 'organizationName', 'acceptUrl']);
    expect(invite.customized).toBe(false);
  });

  it('rejects unknown variables, stray braces and a missing required link', async () => {
    const put = (body: object) =>
      api().put('/api/v1/admin/email-templates/invite').set(as('super')).send(body);
    const unknown = await put({ subject: 'Hi {{patientName}}', body: 'Go: {{acceptUrl}}' });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('{{patientName}}');
    expect((await put({ subject: 'Hi', body: 'Go: {{acceptUrl}} {{' })).status).toBe(400);
    const missing = await put({ subject: 'Hi', body: 'No link here' });
    expect(JSON.stringify(missing.body)).toContain('{{acceptUrl}}');
    expect(
      (await api().put('/api/v1/admin/email-templates/nope').set(as('super')).send({})).status,
    ).toBe(404);
  });

  it('a saved template is used for the next invite; values are inserted literally', async () => {
    const put = await api().put('/api/v1/admin/email-templates/invite').set(as('super')).send({
      subject: 'Join {{organizationName}} on Datascribe',
      body: 'Hello! {{inviterName}} added you.\nStart here: {{acceptUrl}}\n— The Datascribe team',
    });
    expect(put.status).toBe(200);
    expect(put.body.customized).toBe(true);

    // an org name that looks like a placeholder and carries a line break
    const org = await prisma.organization.create({
      data: { name: 'Evil {{acceptUrl}}\nBcc: x@example.com Law (synthetic)', type: 'client' },
    });
    const email = uniqueEmail('templated');
    await api()
      .post('/api/v1/admin/users')
      .set(as('super'))
      .send({ organizationId: org.id, email, roleKey: 'client_user' });
    const mail = mailer.lastTo(email)!;
    expect(mail.subject).toBe(
      'Join Evil {{acceptUrl}} Bcc: x@example.com Law (synthetic) on Datascribe',
    );
    expect(mail.subject).not.toContain('\n');
    expect(mail.text).toMatch(/^Hello! .* added you\.\nStart here: http.*token=/);

    const preview = await api()
      .post('/api/v1/admin/email-templates/invite/preview')
      .set(as('super'))
      .send({ subject: 'Hi {{inviterName}}', body: 'Link {{acceptUrl}}' });
    expect(preview.body.subject).toBe('Hi Alex Example');

    const reset = await api().delete('/api/v1/admin/email-templates/invite').set(as('super'));
    expect(reset.body.customized).toBe(false);
    expect(
      await prisma.auditLog.count({ where: { action: { startsWith: 'admin.email_template.' } } }),
    ).toBeGreaterThanOrEqual(2);
    expect((await api().get('/api/v1/admin/email-templates').set(as('ops'))).status).toBe(403);
  });
});

// ───────────────────────────── Audit log viewer ─────────────────────────────

describe('audit log viewer', () => {
  it('ops manager can view with filters; only super admin can export', async () => {
    const res = await api()
      .get('/api/v1/admin/audit-logs?action=auth.login&limit=5')
      .set(as('ops'));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    expect(res.body.total).toBeGreaterThan(0);
    for (const a of res.body.items) expect(a.action.startsWith('auth.login')).toBe(true);
    expect(res.body.items[0].actor).toHaveProperty('email');

    expect((await api().get('/api/v1/admin/audit-logs/export').set(as('ops'))).status).toBe(403);
    for (const who of ['sales', 'finance', 'acmeAdmin', 'acmeUser']) {
      expect((await api().get('/api/v1/admin/audit-logs').set(as(who))).status).toBe(403);
    }
  });

  it('filters by user, entity and date range, and paginates', async () => {
    const opsEmail = SEED.internal('ops_manager');
    const byUser = await api()
      .get(`/api/v1/admin/audit-logs?user=${encodeURIComponent(opsEmail)}&entity=User`)
      .set(as('super'));
    expect(byUser.body.total).toBeGreaterThan(0);
    for (const a of byUser.body.items) {
      expect(a.entity).toBe('User');
      expect([a.actor?.email, a.impersonator?.email]).toContain(opsEmail);
    }
    const future = await api().get('/api/v1/admin/audit-logs?from=2099-01-01').set(as('super'));
    expect(future.body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const page1 = await api()
      .get(`/api/v1/admin/audit-logs?from=${today}&to=${today}&limit=2&offset=0`)
      .set(as('super'));
    const page2 = await api()
      .get(`/api/v1/admin/audit-logs?from=${today}&to=${today}&limit=2&offset=2`)
      .set(as('super'));
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect(
      (await api().get('/api/v1/admin/audit-logs?from=2030-01-02&to=2030-01-01').set(as('super')))
        .status,
    ).toBe(400);
  });

  it('exports CSV and audits the export; the log has no write routes', async () => {
    const res = await api()
      .get('/api/v1/admin/audit-logs/export?action=admin.role')
      .set(as('super'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [header, ...lines] = res.text.trim().split('\r\n');
    expect(header).toBe(
      'createdAt,action,entity,entityId,actorEmail,actorId,impersonatorEmail,organization,organizationId,ip,metadata,id',
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('admin.role.');
    expect(
      await prisma.auditLog.count({ where: { action: 'admin.audit.export' } }),
    ).toBeGreaterThan(0);
    const anyId = (await prisma.auditLog.findFirstOrThrow()).id;
    for (const method of ['patch', 'delete', 'put'] as const) {
      expect(
        (await api()[method](`/api/v1/admin/audit-logs/${anyId}`).set(as('super'))).status,
      ).toBe(404);
    }
  });
});

// ───────────────────────────── Impersonation (§4.4) ─────────────────────────────

describe('impersonation', () => {
  it('super admin views a client user read-only; start and stop are audited', async () => {
    const acmeAdmin = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeAdmin } });
    const superUser = await prisma.user.findUniqueOrThrow({
      where: { email: SEED.internal('super_admin') },
    });
    const start = await api().post(`/api/v1/admin/impersonate/${acmeAdmin.id}`).set(as('super'));
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    expect(start.headers['set-cookie']).toBeUndefined(); // no refresh token
    const imp = bearer(start.body.accessToken);

    const me = await api().get('/api/v1/auth/me').set(imp);
    expect(me.body.user.email).toBe(SEED.acmeAdmin);
    expect(me.body.impersonation).toMatchObject({
      by: { id: superUser.id },
      organization: { id: acmeAdmin.organizationId },
    });

    // reads work, scoped as the client admin
    const users = await api().get('/api/v1/admin/users').set(imp);
    expect(users.status).toBe(200);
    for (const u of users.body.items) expect(u.organization.id).toBe(acmeAdmin.organizationId);

    // every write is refused, whatever the client admin could normally do
    const target = await makeUser('acme', ['client_user']);
    for (const call of [
      api().post(`/api/v1/admin/users/${target.id}/suspend`).set(imp),
      api()
        .put(`/api/v1/admin/users/${target.id}/roles`)
        .set(imp)
        .send({ roleKeys: ['client_admin'] }),
      api().post('/api/v1/auth/sessions/revoke-all').set(imp),
      api().post(`/api/v1/admin/impersonate/${target.id}`).set(imp),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('impersonation_read_only');
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      'active',
    );

    const stop = await api().post('/api/v1/admin/impersonate/stop').set(imp);
    expect(stop.status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set(imp)).status).toBe(401);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: acmeAdmin.id, action: { startsWith: 'admin.impersonation.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorId, a.impersonatorId])).toEqual([
      ['admin.impersonation.started', acmeAdmin.id, superUser.id],
      ['admin.impersonation.stopped', acmeAdmin.id, superUser.id],
    ]);
  });

  it('only super admin, and only client users', async () => {
    const acmeUser = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
    for (const who of ['ops', 'acmeAdmin', 'sales']) {
      expect(
        (await api().post(`/api/v1/admin/impersonate/${acmeUser.id}`).set(as(who))).status,
      ).toBe(403);
    }
    const staff = await prisma.user.findUniqueOrThrow({
      where: { email: SEED.internal('finance') },
    });
    expect(
      (await api().post(`/api/v1/admin/impersonate/${staff.id}`).set(as('super'))).status,
    ).toBe(403);
    expect((await api().post('/api/v1/admin/impersonate/nope').set(as('super'))).status).toBe(404);
    expect((await api().post('/api/v1/admin/impersonate/stop').set(as('super'))).status).toBe(400);
  });

  it('an imp claim must match the session (no forging on a normal session)', async () => {
    const { token } = await login(app, SEED.acmeUser);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    const superUser = await prisma.user.findUniqueOrThrow({
      where: { email: SEED.internal('super_admin') },
    });
    const forged = signAccessToken(
      { sub: payload.sub, sid: payload.sid, imp: superUser.id },
      testEnv().JWT_ACCESS_SECRET,
    );
    expect((await api().get('/api/v1/auth/me').set(bearer(forged))).status).toBe(401);
  });

  it('ends at once if the impersonating super admin is suspended', async () => {
    const extraSuper = await makeUser('internal', ['super_admin']);
    const { token } = await login(app, extraSuper.email);
    const acmeUser = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
    const start = await api().post(`/api/v1/admin/impersonate/${acmeUser.id}`).set(bearer(token));
    const imp = bearer(start.body.accessToken);
    expect((await api().get('/api/v1/auth/me').set(imp)).status).toBe(200);
    await api().post(`/api/v1/admin/users/${extraSuper.id}/suspend`).set(as('super'));
    expect((await api().get('/api/v1/auth/me').set(imp)).status).toBe(401);
  });
});

// ───────────────────────────── Lockout race (audit M2) ─────────────────────────────

describe('lockout with concurrent guesses (audit M2)', () => {
  async function clientUser() {
    return (await makeUser('acme', ['client_user' satisfies RoleKey])).email;
  }

  it('20 parallel wrong guesses: at most 5 are checked, the rest get 423', async () => {
    const email = await clientUser();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api().post('/api/v1/auth/login').send({ email, password: 'wrong-password-guess' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 423).length).toBeGreaterThanOrEqual(15);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(
      await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.login.failed' } }),
    ).toBeLessThanOrEqual(5);
    // even the right password is refused while locked
    const right = await api().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
    expect(right.status).toBe(423);
  });

  it('a correct password gives its attempt back; an expired lock starts a fresh count', async () => {
    const email = await clientUser();
    for (let i = 0; i < 4; i++) {
      await api().post('/api/v1/auth/login').send({ email, password: 'wrong-password-guess' });
    }
    await login(app, email); // the 5th attempt is right: no lockout
    let user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();

    await prisma.user.update({
      where: { email },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() - 1000) },
    });
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password-guess' });
    expect(wrong.status).toBe(401);
    user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.failedLoginCount).toBe(1);
    expect(user.lockedUntil).toBeNull();
  });

  it('parallel wrong MFA codes are capped the same way', async () => {
    const staff = await makeUser('internal', ['summarizer']);
    const first = await api()
      .post('/api/v1/auth/login')
      .send({ email: staff.email, password: TEST_PASSWORD });
    const mfaToken = first.body.mfaToken as string;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        api().post('/api/v1/auth/mfa/verify').send({ mfaToken, code: '000000' }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 423).length).toBeGreaterThanOrEqual(7);
  });
});
