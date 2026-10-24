import {
  deliverPendingEmails,
  notify,
  notifyAssigned,
  notifyCaseSubmitted,
  notifyDelivered,
  notifyInvoicesIssued,
  notifyQaDecision,
  notifyTasksDue,
} from '@datascribe/db/notifications';
import { internalSeedEmail } from '@datascribe/db/seed';
import { decrypt } from '@datascribe/shared';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password';
import { MemoryMailer, tokenFromMail } from '../src/lib/mailer';
import { TEST_PASSWORD, testPhiKey } from './constants';
import { SEED, bearer, buildApp, login, orgId, prisma, uniqueEmail } from './helpers';

const { app, mailer } = buildApp();

const userId = async (email: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { email } })).id;

/** A fresh active client user, so counts aren't disturbed by other tests' notifications. */
async function freshClientUser(org: 'acme' | 'harbor', role = 'client_user') {
  const email = uniqueEmail(`notif.${org}`);
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const user = await prisma.user.create({
    data: {
      organizationId: await orgId(org),
      email,
      name: `Notif ${org}`,
      passwordHash: await hashPassword(TEST_PASSWORD),
      status: 'active',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
  return { id: user.id, email };
}

const acmeCase = async () =>
  prisma.case.findFirstOrThrow({
    where: { organizationId: await orgId('acme') },
    orderBy: { createdAt: 'asc' },
  });

beforeAll(async () => {
  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
});

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: 'notifications' } });
});

describe('dispatch', () => {
  it('case submitted reaches the case manager and ops managers, with no PHI', async () => {
    const c = await acmeCase();
    expect(await notifyCaseSubmitted(prisma, c.id)).toBeGreaterThanOrEqual(2);
    const rows = await prisma.notification.findMany({
      where: { type: 'case_submitted', payload: { path: ['caseId'], equals: c.id } },
    });
    const to = rows.map((r) => r.userId).sort();
    expect(to).toContain(await userId(internalSeedEmail('case_manager')));
    expect(to).toContain(await userId(internalSeedEmail('ops_manager')));
    expect(to).not.toContain(await userId(SEED.acmeAdmin));
    for (const r of rows) {
      expect(r.emailStatus).toBe('pending');
      expect(r.organizationId).toBe(await orgId('internal'));
      expect(JSON.stringify(r.payload)).not.toContain(decrypt(c.patientName, testPhiKey));
      expect(JSON.stringify(r.payload)).not.toContain(c.matterName);
    }
  });

  it('never delivers a staff-only type to a client user', async () => {
    const c = await acmeCase();
    const n = await notify(
      prisma,
      { type: 'case_submitted', payload: { caseId: c.id, caseNumber: c.number } },
      [await userId(SEED.acmeAdmin)],
    );
    expect(n).toBe(0);
  });

  it('a one-off invoice notifies the firm admins once (dedupe key)', async () => {
    const admin = await userId(SEED.acmeAdmin);
    const { token } = await login(app, internalSeedEmail('finance'));
    const res = await request(app)
      .post('/api/v1/invoices')
      .set(bearer(token))
      .send({
        organizationId: await orgId('acme'),
        lines: [{ description: 'Rush fee (synthetic)', quantity: 1, unitPrice: '25.00' }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const invoiceId = res.body.id as string;
    await notifyInvoicesIssued(prisma, [invoiceId]);
    expect(
      await prisma.notification.count({
        where: { userId: admin, type: 'invoice_issued', dedupeKey: `invoice_issued:${invoiceId}` },
      }),
    ).toBe(1);
  });

  it('task due fires once per task and due date', async () => {
    const sales = await userId(internalSeedEmail('sales'));
    const task = await prisma.activity.create({
      data: {
        type: 'task',
        subject: 'Call back (synthetic)',
        userId: sales,
        dueAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
    await notifyTasksDue(prisma);
    await notifyTasksDue(prisma);
    expect(
      await prisma.notification.count({
        where: {
          userId: sales,
          type: 'task_due',
          payload: { path: ['activityId'], equals: task.id },
        },
      }),
    ).toBe(1);
  });
});

/**
 * Helpers M6 will call (assignment, QA decision, delivery). Each test sets the case's assignees and
 * puts them back, so other test files see the seeded case unchanged.
 */
describe('M6 emit helpers', () => {
  const rowsFor = async (type: string, caseId: string) =>
    prisma.notification.findMany({
      where: { type, payload: { path: ['caseId'], equals: caseId } },
    });

  async function withAssignees(
    data: { summarizerId?: string | null; caseManagerId?: string | null },
    fn: (c: Awaited<ReturnType<typeof acmeCase>>) => Promise<void>,
  ) {
    const c = await acmeCase();
    await prisma.case.update({ where: { id: c.id }, data });
    try {
      await fn(c);
    } finally {
      await prisma.case.update({
        where: { id: c.id },
        data: { summarizerId: c.summarizerId, caseManagerId: c.caseManagerId },
      });
    }
  }

  it('notifyAssigned tells the new assignee, with the role; never yourself or a client', async () => {
    const c = await acmeCase();
    const cm = await userId(internalSeedEmail('case_manager'));
    const summarizer = await userId(internalSeedEmail('summarizer'));
    expect(await notifyAssigned(prisma, c.id, summarizer, 'summarizer', cm)).toBe(1);
    const rows = await rowsFor('assigned_to_you', c.id);
    expect(rows.map((r) => r.userId)).toEqual([summarizer]);
    expect(rows[0]).toMatchObject({
      payload: { caseId: c.id, caseNumber: c.number, role: 'summarizer' },
      emailStatus: 'pending',
      organizationId: await orgId('internal'),
    });

    // self-assignment and a client user (staff-only type) are silent; unknown case too
    expect(await notifyAssigned(prisma, c.id, cm, 'case_manager', cm)).toBe(0);
    const client = await freshClientUser('acme');
    expect(await notifyAssigned(prisma, c.id, client.id, 'qa_reviewer', cm)).toBe(0);
    expect(await notifyAssigned(prisma, 'no-such-case', summarizer, 'summarizer', cm)).toBe(0);
    expect((await rowsFor('assigned_to_you', c.id)).length).toBe(1);
  });

  it('notifyQaDecision tells the summarizer and case manager: approved or changes requested', async () => {
    const summarizer = await userId(internalSeedEmail('summarizer'));
    const cm = await userId(internalSeedEmail('case_manager'));
    await withAssignees({ summarizerId: summarizer, caseManagerId: cm }, async (c) => {
      expect(await notifyQaDecision(prisma, c.id, false)).toBe(2);
      expect((await rowsFor('qa_changes_requested', c.id)).map((r) => r.userId).sort()).toEqual(
        [summarizer, cm].sort(),
      );
      expect(await notifyQaDecision(prisma, c.id, true)).toBe(2);
      const approved = await rowsFor('approved', c.id);
      expect(approved.map((r) => r.userId).sort()).toEqual([summarizer, cm].sort());
      expect(JSON.stringify(approved[0]!.payload)).not.toContain(c.matterName);
    });
    // nobody assigned: nobody to tell
    await withAssignees({ summarizerId: null, caseManagerId: null }, async (c) => {
      expect(await notifyQaDecision(prisma, c.id, true)).toBe(0);
    });
  });

  it('notifyDelivered tells the creator, shared users and firm admins, once per case', async () => {
    const c = await acmeCase();
    const shared = await freshClientUser('acme');
    const otherFirm = await freshClientUser('harbor', 'client_admin');
    await prisma.caseShare.create({ data: { caseId: c.id, userId: shared.id } });
    try {
      const n = await notifyDelivered(prisma, c.id);
      expect(n).toBeGreaterThanOrEqual(2);
      const to = (await rowsFor('delivered', c.id)).map((r) => r.userId);
      expect(to).toContain(c.createdById);
      expect(to).toContain(shared.id);
      expect(to).toContain(await userId(SEED.acmeAdmin));
      expect(to).not.toContain(otherFirm.id);
      expect(to).not.toContain(await userId(internalSeedEmail('case_manager')));
      // a retried delivery adds nothing (dedupe key delivered:<caseId>)
      expect(await notifyDelivered(prisma, c.id)).toBe(0);
      expect((await rowsFor('delivered', c.id)).length).toBe(to.length);
      expect(await notifyDelivered(prisma, 'no-such-case')).toBe(0);
    } finally {
      await prisma.caseShare.delete({
        where: { caseId_userId: { caseId: c.id, userId: shared.id } },
      });
    }
  });
});

describe('preferences and admin rules', () => {
  it('a muted email still gives an in-app entry; muting both gives nothing', async () => {
    const u = await freshClientUser('acme', 'client_admin');
    const { token } = await login(app, u.email);
    const put = await request(app)
      .put('/api/v1/notifications/preferences')
      .set(bearer(token))
      .send({ items: [{ type: 'invoice_issued', email: false }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const pref = put.body.items.find((i: { type: string }) => i.type === 'invoice_issued');
    expect(pref).toMatchObject({ email: false, inApp: true, critical: false });

    const event = {
      type: 'invoice_issued' as const,
      payload: {
        invoiceId: 'x',
        invoiceNumber: 'INV-1',
        total: '1.00',
        currency: 'USD',
        dueAt: null,
      },
    };
    await notify(prisma, event, [u.id]);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ inApp: true, emailStatus: 'none' });

    await request(app)
      .put('/api/v1/notifications/preferences')
      .set(bearer(token))
      .send({ items: [{ type: 'invoice_issued', inApp: false }] })
      .expect(200);
    expect(await notify(prisma, event, [u.id])).toBe(0);
  });

  it('critical notifications cannot be muted', async () => {
    const u = await freshClientUser('acme');
    const { token } = await login(app, u.email);
    const res = await request(app)
      .put('/api/v1/notifications/preferences')
      .set(bearer(token))
      .send({ items: [{ type: 'upload_quarantined', email: false }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cannot_mute_critical');

    // even a stored mute (e.g. hand-edited) is ignored for a critical type
    await prisma.notificationPreference.create({
      data: { userId: u.id, type: 'payment_failed', email: false, inApp: false },
    });
    await notify(
      prisma,
      {
        type: 'payment_failed',
        payload: { invoiceId: 'x', invoiceNumber: 'INV-2', amount: '1.00', currency: 'USD' },
      },
      [u.id],
    );
    const row = await prisma.notification.findFirstOrThrow({
      where: { userId: u.id, type: 'payment_failed' },
    });
    expect(row).toMatchObject({ inApp: true, emailStatus: 'pending' });
  });

  it('rejects types the user cannot receive', async () => {
    const u = await freshClientUser('acme');
    const { token } = await login(app, u.email);
    const res = await request(app)
      .put('/api/v1/notifications/preferences')
      .set(bearer(token))
      .send({ items: [{ type: 'lead_assigned', email: false }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_type');
  });

  it("the admin's switch in Settings turns an event's email off for everyone", async () => {
    const u = await freshClientUser('acme', 'client_admin');
    await prisma.setting.create({
      data: {
        key: 'notifications',
        value: { rules: { invoice_issued: { email: false, inApp: true } } },
      },
    });
    await notify(
      prisma,
      {
        type: 'invoice_issued',
        payload: {
          invoiceId: 'y',
          invoiceNumber: 'INV-3',
          total: '1.00',
          currency: 'USD',
          dueAt: null,
        },
      },
      [u.id],
    );
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.emailStatus).toBe('none');
    const { token } = await login(app, u.email);
    const prefs = await request(app).get('/api/v1/notifications/preferences').set(bearer(token));
    expect(
      prefs.body.items.find((i: { type: string }) => i.type === 'invoice_issued'),
    ).toMatchObject({ emailDisabledByAdmin: true });
  });
});

describe('in-app API and org scoping', () => {
  it('lists, counts and marks read; another firm never sees or touches them', async () => {
    const acme = await freshClientUser('acme');
    const harbor = await freshClientUser('harbor', 'client_admin');
    const c = await acmeCase();
    const payload = { caseId: c.id, caseNumber: c.number, documentId: 'doc-1' };
    await notify(prisma, { type: 'upload_scanned', payload }, [acme.id]);
    await notify(prisma, { type: 'upload_scan_failed', payload }, [acme.id]);
    // a row that claims another org for this user is never shown either
    await prisma.notification.create({
      data: {
        userId: acme.id,
        organizationId: await orgId('harbor'),
        type: 'upload_scanned',
        payload,
      },
    });

    const a = (await login(app, acme.email)).token;
    const h = (await login(app, harbor.email)).token;

    const count = await request(app).get('/api/v1/notifications/unread-count').set(bearer(a));
    expect(count.body).toEqual({ count: 2 });
    const list = await request(app).get('/api/v1/notifications').set(bearer(a));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({ type: 'upload_scan_failed', readAt: null });
    expect(list.body.items[0].title).toContain(c.number);
    expect(list.body.items[0].link).toBe(`/portal/cases/${c.id}`);
    const id = list.body.items[0].id as string;

    // harbor: empty bell, and acme's id is a 404 (existence not leaked)
    expect(
      (await request(app).get('/api/v1/notifications').set(bearer(h))).body.items,
    ).toHaveLength(0);
    await request(app).post(`/api/v1/notifications/${id}/read`).set(bearer(h)).expect(404);
    await request(app).post('/api/v1/notifications/read-all').set(bearer(h)).expect(200);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).readAt).toBeNull();

    const read = await request(app).post(`/api/v1/notifications/${id}/read`).set(bearer(a));
    expect(read.status).toBe(200);
    expect(read.body.readAt).not.toBeNull();
    const unread = await request(app).get('/api/v1/notifications?unread=true').set(bearer(a));
    expect(unread.body.items).toHaveLength(1);

    const all = await request(app).post('/api/v1/notifications/read-all').set(bearer(a));
    expect(all.body).toEqual({ updated: 1 });
    expect(
      (await request(app).get('/api/v1/notifications/unread-count').set(bearer(a))).body,
    ).toEqual({ count: 0 });
  });

  it('pages with a cursor', async () => {
    const u = await freshClientUser('acme');
    const c = await acmeCase();
    for (let i = 0; i < 3; i++) {
      await notify(
        prisma,
        {
          type: 'upload_scanned',
          payload: { caseId: c.id, caseNumber: c.number, documentId: `d${i}` },
        },
        [u.id],
      );
    }
    const { token } = await login(app, u.email);
    const first = await request(app).get('/api/v1/notifications?limit=2').set(bearer(token));
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app)
      .get(`/api/v1/notifications?limit=2&cursor=${first.body.nextCursor}`)
      .set(bearer(token));
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('needs a signed-in user', async () => {
    await request(app).get('/api/v1/notifications').expect(401);
  });
});

describe('event sources', () => {
  it('invite accepted notifies the inviter', async () => {
    const { token } = await login(app, SEED.acmeAdmin);
    const email = uniqueEmail('notif.invitee');
    await request(app)
      .post('/api/v1/invites')
      .set(bearer(token))
      .send({ organizationId: await orgId('acme'), email, roleKey: 'client_user' })
      .expect(201);
    await request(app)
      .post(`/api/v1/invites/${tokenFromMail(mailer.lastTo(email))}/accept`)
      .send({ name: 'Invitee Synthetic', password: TEST_PASSWORD })
      .expect(201);
    const row = await prisma.notification.findFirstOrThrow({
      where: {
        userId: await userId(SEED.acmeAdmin),
        type: 'invite_accepted',
        payload: { path: ['email'], equals: email },
      },
    });
    expect(row.emailStatus).toBe('none'); // email off by default for this type
  });

  it('assigning a lead to someone else notifies the new owner, not yourself', async () => {
    const { token } = await login(app, internalSeedEmail('sales'));
    const salesId = await userId(internalSeedEmail('sales'));
    const opsId = await userId(internalSeedEmail('ops_manager'));
    const mine = await request(app)
      .post('/api/v1/leads')
      .set(bearer(token))
      .send({ source: 'manual', companyName: 'Notif Self Co', contactName: 'A B' })
      .expect(201);
    const theirs = await request(app)
      .patch(`/api/v1/leads/${mine.body.id}`)
      .set(bearer(token))
      .send({ ownerId: opsId });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const rows = await prisma.notification.findMany({
      where: { type: 'lead_assigned', payload: { path: ['leadId'], equals: mine.body.id } },
    });
    expect(rows.map((r) => r.userId)).toEqual([opsId]);
    expect(rows.map((r) => r.userId)).not.toContain(salesId);
  });

  it('password reset leaves a security entry in the bell (email sent directly)', async () => {
    const u = await freshClientUser('acme');
    await request(app).post('/api/v1/auth/forgot').send({ email: u.email }).expect(202);
    await request(app)
      .post('/api/v1/auth/reset')
      .send({ token: tokenFromMail(mailer.lastTo(u.email)), password: 'New-password-456!' })
      .expect(200);
    const row = await prisma.notification.findFirstOrThrow({
      where: { userId: u.id, type: 'password_changed' },
    });
    expect(row).toMatchObject({ inApp: true, emailStatus: 'none' });
  });
});

describe('email outbox', () => {
  beforeEach(async () => {
    // only this test's rows are pending
    await prisma.notification.updateMany({
      where: { emailStatus: 'pending' },
      data: { emailStatus: 'none' },
    });
  });

  it('sends pending rows once, with PHI-free subjects and a link', async () => {
    const c = await acmeCase();
    const u = await freshClientUser('acme');
    await notify(
      prisma,
      {
        type: 'upload_scan_failed',
        payload: { caseId: c.id, caseNumber: c.number, documentId: 'z' },
      },
      [u.id],
    );
    const out = new MemoryMailer();
    const first = await deliverPendingEmails(prisma, out, { appUrl: 'http://app.test' });
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const mail = out.lastTo(u.email)!;
    expect(mail.subject).toBe(`Record could not be checked on case ${c.number}`);
    expect(mail.subject).not.toContain(decrypt(c.patientName, testPhiKey));
    expect(mail.text).toContain(`http://app.test/portal/cases/${c.id}`);
    expect(mail.text).toContain('http://app.test/portal/notifications');

    const again = await deliverPendingEmails(prisma, out, { appUrl: 'http://app.test' });
    expect(again.sent).toBe(0);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ emailStatus: 'sent', emailAttempts: 1 });
  });

  it("uses the admin's edited notification email, keeping the preferences link", async () => {
    const { token } = await login(app, internalSeedEmail('super_admin'));
    const key = 'notification_upload_scanned';
    const list = await request(app).get('/api/v1/admin/email-templates').set(bearer(token));
    expect(list.body.items.find((t: { key: string }) => t.key === key)).toMatchObject({
      group: 'notification',
      required: ['link'],
      variables: ['caseNumber', 'link'],
      customized: false,
    });
    const bad = await request(app)
      .put(`/api/v1/admin/email-templates/${key}`)
      .set(bearer(token))
      .send({ subject: 'Checked {{patientName}}', body: 'no link' });
    expect(bad.status).toBe(400);
    const preview = await request(app)
      .post(`/api/v1/admin/email-templates/${key}/preview`)
      .set(bearer(token))
      .send({ subject: 'Checked: {{caseNumber}}', body: 'See {{link}}' });
    expect(preview.body.subject).toBe('Checked: DS-2026-0001');
    expect(preview.body.text).toContain('Choose which emails you get');
    await request(app)
      .put(`/api/v1/admin/email-templates/${key}`)
      .set(bearer(token))
      .send({ subject: 'Checked: {{caseNumber}}', body: 'Your record is clean. {{link}}' })
      .expect(200);

    try {
      const c = await acmeCase();
      const u = await freshClientUser('acme');
      await prisma.notificationPreference.create({
        data: { userId: u.id, type: 'upload_scanned', email: true, inApp: true },
      });
      await notify(
        prisma,
        {
          type: 'upload_scanned',
          payload: { caseId: c.id, caseNumber: c.number, documentId: 'v' },
        },
        [u.id],
      );
      const out = new MemoryMailer();
      await deliverPendingEmails(prisma, out, { appUrl: 'http://app.test' });
      const mail = out.lastTo(u.email)!;
      expect(mail.subject).toBe(`Checked: ${c.number}`);
      expect(mail.text).toBe(
        `Your record is clean. http://app.test/portal/cases/${c.id}\n\nChoose which emails you get: http://app.test/portal/notifications`,
      );
    } finally {
      await request(app)
        .delete(`/api/v1/admin/email-templates/${key}`)
        .set(bearer(token))
        .expect(200);
    }
  });

  it('retries a failing send with backoff, then gives up', async () => {
    const u = await freshClientUser('acme', 'client_admin');
    await notify(
      prisma,
      {
        type: 'payment_failed',
        payload: { invoiceId: 'q', invoiceNumber: 'INV-9', amount: '5.00', currency: 'USD' },
      },
      [u.id],
    );
    const broken = { send: async () => Promise.reject(new Error('smtp down')) };
    let now = new Date();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await deliverPendingEmails(prisma, broken, { appUrl: 'http://a', now }));
      now = new Date(now.getTime() + 10 * 60_000);
    }
    expect(results.map((r) => [r.retrying, r.failed])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ emailStatus: 'failed', emailAttempts: 3 });
  });
});
