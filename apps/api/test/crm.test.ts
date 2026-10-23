import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { tokenFromMail } from '../src/lib/mailer';
import { TEST_PASSWORD } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app, mailer } = buildApp();
const tokens: Record<string, string> = {};
const as = (who: string) => ({
  get: (path: string) => request(app).get(path).set(bearer(tokens[who]!)),
  post: (path: string, body?: object) =>
    request(app).post(path).set(bearer(tokens[who]!)).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(path).set(bearer(tokens[who]!)).send(body),
  del: (path: string) => request(app).delete(path).set(bearer(tokens[who]!)),
});

const SALES = SEED.internal('sales');
const OPS = SEED.internal('ops_manager');
const CM = SEED.internal('case_manager');
const FIN = SEED.internal('finance');
const SUMM = SEED.internal('summarizer');

beforeAll(async () => {
  for (const email of [SALES, OPS, CM, FIN, SUMM, SEED.acmeAdmin]) {
    tokens[email] = (await login(app, email)).token;
  }
});
afterAll(() => prisma.$disconnect());

const newLead = (over: object = {}) => ({
  companyName: `Synthetic Law ${Math.random().toString(36).slice(2, 8)}`,
  contactName: 'Pat Example',
  email: uniqueEmail('lead'),
  value: 2500,
  ...over,
});

describe('access control', () => {
  it('sales and ops have full CRM access', async () => {
    for (const who of [SALES, OPS]) {
      const created = await as(who).post('/api/v1/leads', newLead());
      expect(created.status, who).toBe(201);
      expect((await as(who).del(`/api/v1/leads/${created.body.id}`)).status).toBe(204);
    }
  });

  it('case_manager and finance can view but not change CRM data', async () => {
    for (const who of [CM, FIN]) {
      expect((await as(who).get('/api/v1/leads')).status, who).toBe(200);
      expect((await as(who).post('/api/v1/leads', newLead())).status, who).toBe(403);
      expect((await as(who).get('/api/v1/leads/export')).status, who).toBe(403);
    }
  });

  it('roles without CRM grants and all client users are refused', async () => {
    expect((await as(SUMM).get('/api/v1/leads')).status).toBe(403);
    for (const path of [
      '/api/v1/leads',
      '/api/v1/contacts',
      '/api/v1/activities',
      '/api/v1/accounts',
      '/api/v1/pipeline/summary',
    ]) {
      expect((await as(SEED.acmeAdmin).get(path)).status, path).toBe(403);
    }
  });

  it('a client-org user with a custom role holding CRM grants is still refused (D-018)', async () => {
    const perms = await prisma.permission.findMany({
      where: { module: 'crm', scope: { in: ['all', 'firm'] } },
    });
    const role = await prisma.role.create({
      data: {
        key: `crm_leak_${Date.now()}`,
        name: 'Misconfigured CRM role',
        permissions: { create: perms.map((p) => ({ permissionId: p.id })) },
      },
    });
    const email = uniqueEmail('crmleak');
    await prisma.user.create({
      data: {
        email,
        name: 'Client With CRM Role',
        organizationId: await orgId('acme'),
        passwordHash: await hashPassword(TEST_PASSWORD),
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: role.id } },
      },
    });
    const { token } = await login(app, email);
    const res = await request(app).get('/api/v1/leads').set(bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('leads', () => {
  it('creates a lead owned by the creator, with validation', async () => {
    const res = await as(SALES).post('/api/v1/leads', newLead({ value: '1234.50' }));
    expect(res.status).toBe(201);
    expect(res.body.stage).toBe('new');
    expect(res.body.value).toBe('1234.50');
    expect(res.body.owner.email).toBe(SALES);

    expect((await as(SALES).post('/api/v1/leads', { companyName: 'x' })).status).toBe(400);
    expect((await as(SALES).post('/api/v1/leads', newLead({ value: -5 }))).status).toBe(400);
  });

  it('lead owners must be internal staff', async () => {
    const client = await prisma.user.findUniqueOrThrow({ where: { email: SEED.acmeUser } });
    const res = await as(SALES).post('/api/v1/leads', newLead({ ownerId: client.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_user');
    const cm = await prisma.user.findUniqueOrThrow({ where: { email: CM } });
    expect((await as(SALES).post('/api/v1/leads', newLead({ ownerId: cm.id }))).status).toBe(201);
  });

  it('filters by stage, owner and free text', async () => {
    const marker = `Zebra ${Date.now()}`;
    const a = await as(SALES).post('/api/v1/leads', newLead({ companyName: `${marker} One` }));
    await as(OPS).post(
      '/api/v1/leads',
      newLead({ companyName: `${marker} Two`, stage: 'qualified' }),
    );

    const byText = await as(SALES).get(`/api/v1/leads?q=${encodeURIComponent(marker)}`);
    expect(byText.body.total).toBe(2);
    const mine = await as(SALES).get(`/api/v1/leads?q=${encodeURIComponent(marker)}&ownerId=me`);
    expect(mine.body.items.map((l: { id: string }) => l.id)).toEqual([a.body.id]);
    const qualified = await as(SALES).get(
      `/api/v1/leads?q=${encodeURIComponent(marker)}&stage=qualified,proposal`,
    );
    expect(qualified.body.total).toBe(1);
    expect((await as(SALES).get('/api/v1/leads?stage=bogus')).status).toBe(400);
  });

  it('§5.5: a lost reason is required when marking a lead lost, and cleared when reopened', async () => {
    const lead = (await as(SALES).post('/api/v1/leads', newLead())).body;
    const noReason = await as(SALES).patch(`/api/v1/leads/${lead.id}`, { stage: 'lost' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('lost_reason_required');

    const lost = await as(SALES).patch(`/api/v1/leads/${lead.id}`, {
      stage: 'lost',
      lostReason: 'Chose a competitor',
    });
    expect(lost.status).toBe(200);
    expect(lost.body.lostReason).toBe('Chose a competitor');

    const reopened = await as(SALES).patch(`/api/v1/leads/${lead.id}`, { stage: 'contacted' });
    expect(reopened.body.lostReason).toBeNull();

    const detail = await as(SALES).get(`/api/v1/leads/${lead.id}`);
    const notes = detail.body.activities.map((a: { subject: string }) => a.subject);
    expect(notes).toContain('Stage changed: new → lost');
    expect(notes).toContain('Stage changed: lost → contacted');
  });

  it('won can only be reached by converting', async () => {
    const lead = (await as(SALES).post('/api/v1/leads', newLead())).body;
    const res = await as(SALES).patch(`/api/v1/leads/${lead.id}`, { stage: 'won' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('use_convert');
    expect((await as(SALES).post('/api/v1/leads', newLead({ stage: 'won' }))).status).toBe(400);
  });

  it('pipeline summary counts and values open leads by stage', async () => {
    const before = (await as(SALES).get('/api/v1/pipeline/summary')).body;
    await as(SALES).post('/api/v1/leads', newLead({ stage: 'proposal', value: 1000 }));
    const after = (await as(SALES).get('/api/v1/pipeline/summary')).body;
    const stage = (s: typeof before, k: string) =>
      s.byStage.find((x: { stage: string }) => x.stage === k);
    expect(stage(after, 'proposal').count).toBe(stage(before, 'proposal').count + 1);
    expect(Number(stage(after, 'proposal').value) - Number(stage(before, 'proposal').value)).toBe(
      1000,
    );
    expect(after.openCount).toBe(before.openCount + 1);
    expect(after.byStage.map((s: { stage: string }) => s.stage)).toEqual([
      'new',
      'contacted',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
  });

  it('unknown lead ids are 404', async () => {
    expect((await as(SALES).get('/api/v1/leads/nope')).status).toBe(404);
    expect((await as(SALES).patch('/api/v1/leads/nope', { notes: 'x' })).status).toBe(404);
  });
});

describe('M7 definition of done: website lead → converted client org with invited admin', () => {
  it('runs end to end', async () => {
    const adminEmail = uniqueEmail('newfirm.admin');
    const company = `Brightwater Injury Law ${Date.now()} (synthetic)`;

    // 1. Website form (public, unauthenticated)
    const form = await request(app).post('/api/v1/public/leads').send({
      kind: 'demo',
      name: 'Robin Synthetic',
      company,
      email: adminEmail,
      message: 'We handle ~40 PI matters a month.',
      website: '',
    });
    expect(form.status).toBe(202);
    const salesMail = mailer.lastTo('sales@datascribe.example');
    expect(salesMail?.subject).toContain(company);

    const lead = await prisma.lead.findFirstOrThrow({ where: { companyName: company } });
    expect(lead.source).toBe('website_demo');
    expect(lead.stage).toBe('new');
    expect(salesMail?.text).toContain(`/console/crm/leads/${lead.id}`);

    // 2. Sales works the lead and converts it
    await as(SALES).patch(`/api/v1/leads/${lead.id}`, { stage: 'qualified' });
    await as(SALES).post('/api/v1/activities', {
      type: 'call',
      subject: 'Discovery call',
      leadId: lead.id,
    });
    const plan = await prisma.subscriptionPlan.findFirstOrThrow({
      where: { name: 'Professional' },
    });
    const conv = await as(SALES).post(`/api/v1/leads/${lead.id}/convert`, { planId: plan.id });
    expect(conv.status).toBe(201);
    expect(conv.body.organization.type).toBe('client');
    expect(conv.body.organization.planId).toBe(plan.id);
    expect(conv.body.invite.email).toBe(adminEmail);
    expect(conv.body.invite.roleKey).toBe('client_admin');

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stage).toBe('won');
    expect(after.convertedOrgId).toBe(conv.body.organization.id);
    expect(after.convertedAt).not.toBeNull();

    // history kept: earlier activity now also linked to the account
    const acts = await prisma.activity.findMany({ where: { leadId: lead.id } });
    expect(acts.every((a) => a.organizationId === conv.body.organization.id)).toBe(true);
    expect(acts.map((a) => a.subject)).toEqual(
      expect.arrayContaining([
        'Discovery call',
        'Stage changed: new → qualified',
        `Converted to client: ${company}`,
      ]),
    );
    const account = await as(SALES).get(`/api/v1/accounts/${conv.body.organization.id}`);
    expect(account.status).toBe(200);
    expect(account.body.leads[0].id).toBe(lead.id);
    expect(account.body.contacts[0].email).toBe(adminEmail);

    // 3. Invited admin accepts and signs in to their new firm
    const token = tokenFromMail(mailer.lastTo(adminEmail));
    const accept = await request(app)
      .post(`/api/v1/invites/${token}/accept`)
      .send({ name: 'Robin Synthetic', password: TEST_PASSWORD });
    expect(accept.status).toBe(201);
    const { token: access } = await login(app, adminEmail);
    const me = await request(app).get('/api/v1/auth/me').set(bearer(access));
    expect(me.body.user.organizationId).toBe(conv.body.organization.id);
    expect(me.body.roles).toEqual(['client_admin']);

    // 4. A converted lead is final
    expect((await as(SALES).post(`/api/v1/leads/${lead.id}/convert`)).status).toBe(409);
    expect(
      (await as(SALES).patch(`/api/v1/leads/${lead.id}`, { stage: 'lost', lostReason: 'x' }))
        .status,
    ).toBe(409);
    expect((await as(SALES).del(`/api/v1/leads/${lead.id}`)).status).toBe(409);
    expect(
      await prisma.auditLog.count({ where: { action: 'crm.lead.convert', entityId: lead.id } }),
    ).toBe(1);
  });

  it('needs an admin email and refuses existing users', async () => {
    const noEmail = (await as(SALES).post('/api/v1/leads', newLead({ email: null }))).body;
    const res = await as(SALES).post(`/api/v1/leads/${noEmail.id}/convert`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('admin_email_required');

    const existing = (await as(SALES).post('/api/v1/leads', newLead({ email: SEED.acmeUser })))
      .body;
    expect((await as(SALES).post(`/api/v1/leads/${existing.id}/convert`, {})).status).toBe(409);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: existing.id } })).stage).toBe('new');
  });

  it('case_manager cannot convert', async () => {
    const lead = (await as(SALES).post('/api/v1/leads', newLead())).body;
    expect((await as(CM).post(`/api/v1/leads/${lead.id}/convert`, {})).status).toBe(403);
  });
});

describe('public lead form', () => {
  it('honeypot submissions are accepted silently and stored nowhere', async () => {
    const company = `Bot Corp ${Date.now()}`;
    const res = await request(app).post('/api/v1/public/leads').send({
      kind: 'contact',
      name: 'Bot',
      company,
      email: 'bot@spam.example',
      website: 'http://spam.example',
    });
    expect(res.status).toBe(202);
    expect(await prisma.lead.count({ where: { companyName: company } })).toBe(0);
  });

  it('validates input and is rate limited per IP', async () => {
    expect((await request(app).post('/api/v1/public/leads').send({ kind: 'contact' })).status).toBe(
      400,
    );
    const limited = buildApp({
      rateLimits: { windowMs: 60_000, authPerWindow: 100, publicPerWindow: 1 },
    });
    const body = { kind: 'contact', name: 'A', company: 'B', email: 'a@b.example', website: 'x' };
    await request(limited.app).post('/api/v1/public/leads').send(body);
    expect((await request(limited.app).post('/api/v1/public/leads').send(body)).status).toBe(429);
  });
});

describe('activities and "My tasks today"', () => {
  it('tasks need a due date; other types are logged as done', async () => {
    expect(
      (await as(SALES).post('/api/v1/activities', { type: 'task', subject: 'Follow up' })).status,
    ).toBe(400);
    const call = await as(SALES).post('/api/v1/activities', {
      type: 'call',
      subject: 'Intro call',
    });
    expect(call.status).toBe(201);
    expect(call.body.doneAt).not.toBeNull();
  });

  it('lists my open tasks due today or overdue, and drops them once done', async () => {
    const now = new Date();
    const endOfDay = new Date(now.getTime() + 60 * 60_000).toISOString();
    const mk = (subject: string, dueAt: Date) =>
      as(SALES).post('/api/v1/activities', { type: 'task', subject, dueAt: dueAt.toISOString() });
    const overdue = (await mk('Overdue task', new Date(now.getTime() - 86_400_000))).body;
    const today = (await mk('Due soon', new Date(now.getTime() + 30 * 60_000))).body;
    const later = (await mk('Next week', new Date(now.getTime() + 7 * 86_400_000))).body;
    const someoneElse = (
      await as(OPS).post('/api/v1/activities', {
        type: 'task',
        subject: 'Ops task',
        dueAt: now.toISOString(),
      })
    ).body;

    const res = await as(SALES).get(
      `/api/v1/activities/my-tasks?dueBefore=${encodeURIComponent(endOfDay)}`,
    );
    const ids = res.body.items.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([overdue.id, today.id]));
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(someoneElse.id);
    expect(res.body.items.find((a: { id: string }) => a.id === overdue.id).overdue).toBe(true);

    expect(
      (await as(SALES).patch(`/api/v1/activities/${today.id}`, { done: true })).body.doneAt,
    ).not.toBeNull();
    const again = await as(SALES).get(
      `/api/v1/activities/my-tasks?dueBefore=${encodeURIComponent(endOfDay)}`,
    );
    expect(again.body.items.map((a: { id: string }) => a.id)).not.toContain(today.id);
    expect(
      (await as(SALES).patch(`/api/v1/activities/${today.id}`, { done: false })).body.doneAt,
    ).toBeNull();
  });

  it('filters by lead and rejects links to unknown records', async () => {
    const lead = (await as(SALES).post('/api/v1/leads', newLead())).body;
    await as(SALES).post('/api/v1/activities', {
      type: 'email',
      subject: 'Sent brochure',
      leadId: lead.id,
    });
    const res = await as(SALES).get(`/api/v1/activities?leadId=${lead.id}`);
    expect(res.body.items.map((a: { subject: string }) => a.subject)).toEqual(['Sent brochure']);
    expect(
      (await as(SALES).post('/api/v1/activities', { type: 'note', subject: 'x', leadId: 'nope' }))
        .status,
    ).toBe(400);
    const internalOrg = await orgId('internal');
    expect(
      (
        await as(SALES).post('/api/v1/activities', {
          type: 'note',
          subject: 'x',
          organizationId: internalOrg,
        })
      ).status,
    ).toBe(400);
  });
});

describe('contacts', () => {
  it('CRUD, linked to client accounts only', async () => {
    const acme = await orgId('acme');
    const created = await as(SALES).post('/api/v1/contacts', {
      name: 'Jo Paralegal',
      title: 'Paralegal',
      organizationId: acme,
    });
    expect(created.status).toBe(201);
    const patched = await as(SALES).patch(`/api/v1/contacts/${created.body.id}`, {
      title: 'Senior Paralegal',
    });
    expect(patched.body.title).toBe('Senior Paralegal');
    const list = await as(SALES).get(`/api/v1/contacts?organizationId=${acme}`);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(created.body.id);
    expect((await as(SALES).del(`/api/v1/contacts/${created.body.id}`)).status).toBe(204);

    const internal = await orgId('internal');
    expect(
      (await as(SALES).post('/api/v1/contacts', { name: 'X', organizationId: internal })).status,
    ).toBe(400);
  });
});

describe('CSV import / export (§5.5)', () => {
  it('imports valid lead rows', async () => {
    const tag = `CsvCo${Date.now()}`;
    const csv = [
      'companyName,contactName,email,stage,value,ownerEmail,notes',
      `${tag} A,Ann,ann@${tag}.example,contacted,1500,${SALES},"Met at conference, keen"`,
      `${tag} B,Ben,,new,,,`,
    ].join('\n');
    const res = await request(app)
      .post('/api/v1/leads/import')
      .set(bearer(tokens[SALES]!))
      .set('content-type', 'text/csv')
      .send(csv);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(2);
    const a = await prisma.lead.findFirstOrThrow({
      where: { companyName: `${tag} A` },
      include: { owner: true },
    });
    expect(a.source).toBe('import');
    expect(a.stage).toBe('contacted');
    expect(a.owner?.email).toBe(SALES);
    expect(a.notes).toBe('Met at conference, keen');
  });

  it('rejects the whole file when any row is invalid, listing row numbers', async () => {
    const tag = `BadCsv${Date.now()}`;
    const csv = [
      'companyName,contactName,stage,lostReason,ownerEmail',
      `${tag} ok,Ann,new,,`,
      `${tag} lost,Ben,lost,,`,
      `${tag} won,Cat,won,,`,
      `${tag} owner,Dan,new,,${SEED.acmeUser}`,
      `,Eve,new,,`,
    ].join('\n');
    const res = await request(app)
      .post('/api/v1/leads/import')
      .set(bearer(tokens[SALES]!))
      .set('content-type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5, 6]);
    expect(await prisma.lead.count({ where: { companyName: { startsWith: tag } } })).toBe(0);
  });

  it('requires the key columns and crm:create', async () => {
    const res = await request(app)
      .post('/api/v1/leads/import')
      .set(bearer(tokens[SALES]!))
      .set('content-type', 'text/csv')
      .send('email\nx@y.example');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('csv_columns');
    const cm = await request(app)
      .post('/api/v1/leads/import')
      .set(bearer(tokens[CM]!))
      .set('content-type', 'text/csv')
      .send('companyName,contactName\nA,B');
    expect(cm.status).toBe(403);
  });

  it('exports leads as CSV with formula injection neutralised, and audits it', async () => {
    const company = `=HYPERLINK("http://evil.example") ${Date.now()}`;
    await as(SALES).post('/api/v1/leads', newLead({ companyName: company }));
    const res = await as(SALES).get(`/api/v1/leads/export?q=${encodeURIComponent('HYPERLINK')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/leads\.csv/);
    expect(res.text.split('\r\n')[0]).toMatch(/^id,companyName,contactName,email/);
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"")`);
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: SALES } });
    expect(
      await prisma.auditLog.count({ where: { action: 'crm.leads.export', actorId: actor.id } }),
    ).toBeGreaterThan(0);
  });

  it('round-trips contacts through export and import', async () => {
    const acme = await orgId('acme');
    const name = `Round Trip ${Date.now()}`;
    const imp = await request(app)
      .post('/api/v1/contacts/import')
      .set(bearer(tokens[SALES]!))
      .set('content-type', 'text/csv')
      .send(`name,title,email,accountId\n${name},Partner,rt@example.test,${acme}\n`);
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const bad = await request(app)
      .post('/api/v1/contacts/import')
      .set(bearer(tokens[SALES]!))
      .set('content-type', 'text/csv')
      .send(`name,accountId\nX,${await orgId('internal')}\n`);
    expect(bad.status).toBe(422);
    const exp = await as(SALES).get(`/api/v1/contacts/export?q=${encodeURIComponent(name)}`);
    expect(exp.text).toContain(`${name},Partner,rt@example.test,,${acme}`);
  });
});

describe('accounts', () => {
  it('lists client organisations only', async () => {
    const res = await as(SALES).get('/api/v1/accounts?limit=500');
    expect(res.status).toBe(200);
    const names = res.body.items.map((o: { name: string }) => o.name);
    expect(names).toContain('Acme Injury Law (synthetic)');
    expect(names).not.toContain('Datascribe');
    const internal = await orgId('internal');
    expect((await as(SALES).get(`/api/v1/accounts/${internal}`)).status).toBe(404);
  });
});
