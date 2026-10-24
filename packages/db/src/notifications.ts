/**
 * Notification dispatcher (M9, D-090), shared by the API and the worker.
 *
 * `notify()` turns one domain event into one `Notification` row per recipient, after the admin
 * rules (Settings → Notifications) and the user's preferences. Rows that should be emailed get
 * `emailStatus = pending`: the worker's `notifications` queue sends them (`deliverPendingEmails`),
 * so the API needs no Redis and a mail outage never fails a request.
 *
 * Payloads hold ids and non-PHI labels only (see @datascribe/shared/notifications).
 */
import {
  TEMPLATES_SETTING,
  parseTemplateOverrides,
  renderNotificationEmail,
} from '@datascribe/shared/email-templates';
import {
  NOTIFICATION_CATALOG,
  SETTINGS_EVENTS,
  type NotificationEvent,
  type NotificationPayloads,
  type SettingsEvent,
} from '@datascribe/shared/notifications';
import type { Prisma, PrismaClient } from '../generated/client/index.js';

export type Db = PrismaClient | Prisma.TransactionClient;

/** Setting row with the admin's per-event switches (D-063). */
export const NOTIFICATIONS_SETTING = 'notifications';

export const MAX_EMAIL_ATTEMPTS = 3;

interface Rule {
  email: boolean;
  inApp: boolean;
}

/** Admin switches; a missing or hand-broken row means everything is on. */
export async function adminRules(db: Db): Promise<Partial<Record<SettingsEvent, Rule>>> {
  const row = await db.setting.findUnique({ where: { key: NOTIFICATIONS_SETTING } });
  const rules = ((row?.value ?? {}) as { rules?: Record<string, unknown> }).rules ?? {};
  const out: Partial<Record<SettingsEvent, Rule>> = {};
  for (const key of SETTINGS_EVENTS) {
    const r = rules[key] as Partial<Rule> | undefined;
    if (r && typeof r.email === 'boolean' && typeof r.inApp === 'boolean') {
      out[key] = { email: r.email, inApp: r.inApp };
    }
  }
  return out;
}

export interface NotifyOptions {
  /** idempotency: a second notify with the same key for the same user is a no-op */
  dedupeKey?: string;
}

/**
 * Dispatch one event to these users. Inactive users, suspended orgs and users outside the type's
 * audience (e.g. a staff-only type to a client) are skipped. Returns the number of rows written.
 */
export async function notify(
  db: Db,
  event: NotificationEvent,
  userIds: readonly (string | null | undefined)[],
  opts: NotifyOptions = {},
): Promise<number> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return 0;
  const entry = NOTIFICATION_CATALOG[event.type];
  const users = await db.user.findMany({
    where: { id: { in: ids }, status: 'active', organization: { status: 'active' } },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { type: true } },
      notificationPreferences: {
        where: { type: event.type },
        select: { email: true, inApp: true },
      },
    },
  });
  const rule = entry.settingsKey ? (await adminRules(db))[entry.settingsKey] : undefined;

  const rows: Prisma.NotificationCreateManyInput[] = [];
  for (const u of users) {
    const orgType = u.organization.type;
    if (entry.audience === 'client' && orgType !== 'client') continue;
    if (entry.audience === 'staff' && orgType !== 'internal') continue;
    const pref = u.notificationPreferences[0];
    // critical types ignore the user's mutes (§5.8); the admin rule still applies to §5.8 events
    const inApp = (rule?.inApp ?? true) && (entry.critical || (pref?.inApp ?? true));
    const wantsEmail =
      (rule?.email ?? true) && (entry.critical || (pref?.email ?? entry.defaultEmail));
    const email = wantsEmail && entry.email !== 'direct';
    if (!inApp && !email) continue;
    rows.push({
      userId: u.id,
      organizationId: u.organizationId,
      type: event.type,
      payload: event.payload as Prisma.InputJsonValue,
      inApp,
      emailStatus: email ? 'pending' : 'none',
      dedupeKey: opts.dedupeKey ?? null,
    });
  }
  if (rows.length === 0) return 0;
  const { count } = await db.notification.createMany({ data: rows, skipDuplicates: true });
  return count;
}

// ─────────────────────────── Recipients ───────────────────────────

/** Active users holding any of these roles, in one org or in the internal org. */
export async function usersWithRoles(
  db: Db,
  where: { organizationId: string } | { internal: true },
  roleKeys: readonly string[],
): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      status: 'active',
      ...('internal' in where
        ? { organization: { type: 'internal' } }
        : { organizationId: where.organizationId }),
      roles: { some: { role: { key: { in: [...roleKeys] } } } },
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function caseRef(db: Db, caseId: string) {
  return db.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      number: true,
      organizationId: true,
      createdById: true,
      caseManagerId: true,
      summarizerId: true,
      qaReviewerId: true,
      shares: { select: { userId: true } },
    },
  });
}

const caseManagersOr = async (db: Db, caseManagerId: string | null) =>
  caseManagerId ? [caseManagerId] : usersWithRoles(db, { internal: true }, ['case_manager']);

// ─────────────────────────── Typed emit helpers ───────────────────────────
// One per event source, so callers never build recipients or payloads by hand.

/** §5.8 case submitted → its case manager (or all case managers) and the ops managers. */
export async function notifyCaseSubmitted(db: Db, caseId: string) {
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  const recipients = [
    ...(await caseManagersOr(db, c.caseManagerId)),
    ...(await usersWithRoles(db, { internal: true }, ['ops_manager'])),
  ];
  return notify(
    db,
    { type: 'case_submitted', payload: { caseId: c.id, caseNumber: c.number } },
    recipients,
  );
}

/** Scan result of an upload (§7 stage 1) → the uploader; quarantine also tells the firm admins. */
export async function notifyUploadScanned(
  db: Db,
  documentId: string,
  result: 'clean' | 'infected' | 'error',
) {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      organizationId: true,
      uploadedById: true,
      case: { select: { id: true, number: true } },
    },
  });
  if (!doc) return 0;
  const payload = { caseId: doc.case.id, caseNumber: doc.case.number, documentId: doc.id };
  if (result === 'clean')
    return notify(db, { type: 'upload_scanned', payload }, [doc.uploadedById]);
  if (result === 'error') {
    return notify(db, { type: 'upload_scan_failed', payload }, [doc.uploadedById]);
  }
  const admins = await usersWithRoles(db, { organizationId: doc.organizationId }, ['client_admin']);
  return notify(db, { type: 'upload_quarantined', payload }, [doc.uploadedById, ...admins]);
}

/** Invoices just issued (one-off or monthly run) → the firm's client admins. */
export async function notifyInvoicesIssued(db: Db, invoiceIds: readonly string[]) {
  let n = 0;
  for (const id of invoiceIds) {
    const inv = await db.invoice.findUnique({ where: { id } });
    if (!inv) continue;
    const admins = await usersWithRoles(db, { organizationId: inv.organizationId }, [
      'client_admin',
    ]);
    n += await notify(
      db,
      {
        type: 'invoice_issued',
        payload: {
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          total: inv.total.toFixed(2),
          currency: inv.currency,
          dueAt: inv.dueAt?.toISOString() ?? null,
        },
      },
      admins,
      { dedupeKey: `invoice_issued:${inv.id}` },
    );
  }
  return n;
}

/**
 * A recorded gateway payment. Succeeded → payment received (firm admins + finance staff); failed →
 * payment failed (firm admins, critical). Deduplicated per payment and outcome.
 */
export async function notifyPaymentRecorded(db: Db, paymentId: string, invoicePaid: boolean) {
  const p = await db.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
  if (!p || (p.status !== 'succeeded' && p.status !== 'failed')) return 0;
  const admins = await usersWithRoles(db, { organizationId: p.invoice.organizationId }, [
    'client_admin',
  ]);
  const base = {
    invoiceId: p.invoiceId,
    invoiceNumber: p.invoice.number,
    amount: p.amount.toFixed(2),
    currency: p.currency,
  };
  if (p.status === 'failed') {
    return notify(db, { type: 'payment_failed', payload: base }, admins, {
      dedupeKey: `payment_failed:${p.id}`,
    });
  }
  const finance = await usersWithRoles(db, { internal: true }, ['finance']);
  return notify(
    db,
    { type: 'payment_received', payload: { ...base, invoicePaid } },
    [...admins, ...finance],
    { dedupeKey: `payment_received:${p.id}` },
  );
}

/** A lead got a new owner. Assigning a lead to yourself notifies nobody. */
export async function notifyLeadAssigned(
  db: Db,
  lead: { id: string; companyName: string; ownerId: string | null },
  actorId: string,
) {
  if (!lead.ownerId || lead.ownerId === actorId) return 0;
  return notify(
    db,
    { type: 'lead_assigned', payload: { leadId: lead.id, companyName: lead.companyName } },
    [lead.ownerId],
  );
}

/** Invite accepted → whoever sent it. */
export async function notifyInviteAccepted(db: Db, inviteId: string, userId: string) {
  const invite = await db.invite.findUnique({ where: { id: inviteId } });
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!invite?.invitedById || !user) return 0;
  return notify(
    db,
    { type: 'invite_accepted', payload: { inviteId, userId, name: user.name, email: user.email } },
    [invite.invitedById],
  );
}

/** Security notice in the bell; its email is sent directly by the auth route. */
export async function notifyPasswordChanged(db: Db, userId: string) {
  return notify(db, { type: 'password_changed', payload: {} }, [userId]);
}

/**
 * §5.8 task due: CRM tasks not done and due within the next 24 h (or up to 24 h overdue, so a task
 * created after a run is still caught). Once per task and due date; moving the due date re-arms it.
 */
export async function notifyTasksDue(db: Db, now = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  const tasks = await db.activity.findMany({
    where: {
      type: 'task',
      doneAt: null,
      dueAt: { gte: new Date(now.getTime() - day), lte: new Date(now.getTime() + day) },
    },
    select: { id: true, subject: true, dueAt: true, userId: true, leadId: true },
  });
  let n = 0;
  for (const t of tasks) {
    const dueAt = t.dueAt!.toISOString();
    n += await notify(
      db,
      {
        type: 'task_due',
        payload: { activityId: t.id, subject: t.subject.slice(0, 120), dueAt, leadId: t.leadId },
      },
      [t.userId],
      { dedupeKey: `task_due:${t.id}:${dueAt}` },
    );
  }
  return n;
}

// ── Raised by later milestones. The helpers and templates exist so M5b / M6 only call them. ──

/**
 * Case reached `in_review`: its summarizer, else its case manager, else all case managers.
 * Sent by pipeline stage 7 (`ready-for-review`) when it moves the case to in_review.
 */
export async function notifyCaseReadyForReview(db: Db, caseId: string) {
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  const to = c.summarizerId ? [c.summarizerId] : await caseManagersOr(db, c.caseManagerId);
  const payload: NotificationPayloads['processing_complete'] = {
    caseId: c.id,
    caseNumber: c.number,
  };
  return notify(db, { type: 'processing_complete', payload }, to);
}

/**
 * A pipeline stage failed after its retries and the case is on hold (§7): case manager + ops.
 * Sent by the pipeline stage runner after a stage's last attempt fails.
 */
export async function notifyProcessingFailed(db: Db, caseId: string) {
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  const to = [
    ...(await caseManagersOr(db, c.caseManagerId)),
    ...(await usersWithRoles(db, { internal: true }, ['ops_manager'])),
  ];
  return notify(
    db,
    { type: 'processing_failed', payload: { caseId: c.id, caseNumber: c.number } },
    to,
  );
}

/**
 * §5.8 "assigned to you": someone was made case manager / summarizer / QA reviewer of a case.
 * Self-assignment is silent; only staff receive it (catalog audience).
 *
 * M6 call site: `POST /cases/:id/assign` in `apps/api/src/routes/cases.ts`, after the case update
 * commits, once per role whose user changed (not when the same user is re-saved):
 *   `await safeNotify(deps.logger, 'assigned_to_you', () =>
 *      notifyAssigned(prisma, c.id, newUserId, 'summarizer', auth.user.id));`
 * Not deduplicated: re-assigning the same person later is a new notice.
 */
export async function notifyAssigned(
  db: Db,
  caseId: string,
  userId: string,
  role: NotificationPayloads['assigned_to_you']['role'],
  actorId: string,
) {
  if (userId === actorId) return 0;
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  return notify(
    db,
    { type: 'assigned_to_you', payload: { caseId: c.id, caseNumber: c.number, role } },
    [userId],
  );
}

/**
 * §5.8 QA decision: `approved` or `qa_changes_requested` → the case's summarizer and case manager
 * (whoever is set; staff only). Read the assignees after the decision is saved.
 *
 * M6 call site: `POST /deliverables/:id/qa` (§9), after the decision and the case status change
 * (`approved` / `changes_requested`) commit:
 *   `await safeNotify(deps.logger, approved ? 'approved' : 'qa_changes_requested', () =>
 *      notifyQaDecision(prisma, caseId, approved));`
 * Call it once per decision, not per deliverable, if one decision covers several deliverables.
 */
export async function notifyQaDecision(db: Db, caseId: string, approved: boolean) {
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  const payload = { caseId: c.id, caseNumber: c.number };
  const to = [c.summarizerId, c.caseManagerId];
  return approved
    ? notify(db, { type: 'approved', payload }, to)
    : notify(db, { type: 'qa_changes_requested', payload }, to);
}

/**
 * §5.8 delivered: the final report is ready → the case's creator, the users it is shared with and
 * the firm's client admins (staff assignees are not told). Deduplicated per case
 * (`delivered:<caseId>`), so a retried delivery job never mails twice.
 *
 * M6 call site: wherever the case is set to `delivered` (§5.4: after the final PDF + DOCX are
 * stored and usage is recorded; the delivery job in the worker or `POST /cases/:id/status`),
 * after that transaction commits — never inside it, so a rolled-back delivery sends nothing:
 *   `await safeNotify(deps.logger, 'delivered', () => notifyDelivered(prisma, caseId));`
 * In the worker, wrap it the same way (log the event and error name only).
 */
export async function notifyDelivered(db: Db, caseId: string) {
  const c = await caseRef(db, caseId);
  if (!c) return 0;
  const admins = await usersWithRoles(db, { organizationId: c.organizationId }, ['client_admin']);
  return notify(
    db,
    { type: 'delivered', payload: { caseId: c.id, caseNumber: c.number } },
    [c.createdById, ...c.shares.map((s) => s.userId), ...admins],
    { dedupeKey: `delivered:${c.id}` },
  );
}

// ─────────────────────────── Email outbox ───────────────────────────

export interface OutboxMailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

interface OutboxLog {
  warn(obj: object, msg: string): void;
}

export interface DeliveryResult {
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
}

/** Sending rows older than this were claimed by a worker that died; they are claimed again. */
const STALE_SENDING_MS = 10 * 60 * 1000;

/**
 * Send pending notification emails. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several
 * workers never send the same row. A failed send is retried with backoff (1, 2 min) up to
 * MAX_EMAIL_ATTEMPTS, then marked failed. Logs carry ids and error names only.
 */
export async function deliverPendingEmails(
  db: PrismaClient,
  mailer: OutboxMailer,
  opts: { appUrl: string; now?: Date; limit?: number; log?: OutboxLog },
): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const stale = new Date(now.getTime() - STALE_SENDING_MS);
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Notification" SET "emailStatus" = 'sending', "emailAttempts" = "emailAttempts" + 1,
      "updatedAt" = ${now}
    WHERE "id" IN (
      SELECT "id" FROM "Notification"
      WHERE ("emailStatus" = 'pending' AND ("emailNextAttemptAt" IS NULL OR "emailNextAttemptAt" <= ${now}))
         OR ("emailStatus" = 'sending' AND "updatedAt" < ${stale})
      ORDER BY "createdAt" LIMIT ${opts.limit ?? 50}
      FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  const result: DeliveryResult = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  if (claimed.length === 0) return result;

  const rows = await db.notification.findMany({
    where: { id: { in: claimed.map((c) => c.id) } },
    include: {
      user: { select: { email: true, status: true, organization: { select: { type: true } } } },
    },
  });
  // the admin's edited notification emails (Settings → Email templates, D-097), once per batch
  const templates = await db.setting.findUnique({ where: { key: TEMPLATES_SETTING } });
  const overrides = parseTemplateOverrides(templates?.value);
  for (const n of rows) {
    if (n.user.status !== 'active') {
      await db.notification.update({ where: { id: n.id }, data: { emailStatus: 'skipped' } });
      result.skipped += 1;
      continue;
    }
    const area = n.user.organization.type === 'client' ? 'portal' : 'console';
    const mail = renderNotificationEmail(n.type, n.payload, {
      area,
      appUrl: opts.appUrl,
      overrides,
    });
    try {
      await mailer.send({ to: n.user.email, ...mail });
      await db.notification.update({
        where: { id: n.id },
        data: { emailStatus: 'sent', emailSentAt: new Date() },
      });
      result.sent += 1;
    } catch (err) {
      const last = n.emailAttempts >= MAX_EMAIL_ATTEMPTS;
      await db.notification.update({
        where: { id: n.id },
        data: last
          ? { emailStatus: 'failed' }
          : {
              emailStatus: 'pending',
              emailNextAttemptAt: new Date(now.getTime() + 60_000 * 2 ** (n.emailAttempts - 1)),
            },
      });
      if (last) result.failed += 1;
      else result.retrying += 1;
      opts.log?.warn(
        { notificationId: n.id, attempt: n.emailAttempts, err: (err as Error).name },
        'notification email failed',
      );
    }
  }
  return result;
}
