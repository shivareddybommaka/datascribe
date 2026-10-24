/**
 * Editable email templates (§5.7, D-063; notification emails D-097). Browser-safe and DB-free, so
 * the API (account emails, admin screen) and the worker's notification outbox render the same way.
 *
 * Plain-text only (mail goes out as `text`), so there is no HTML to inject into. Rendering is one
 * pass of `{{name}}` substitution: only the template's declared variables exist, values are
 * inserted literally (a value containing `{{x}}` is not expanded again), and subjects lose line
 * breaks so a value can't add mail headers.
 */
import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_TYPES,
  renderNotification,
  type NotificationPayloads,
  type NotificationType,
} from './notifications';

export interface TemplateDef {
  label: string;
  description: string;
  /** account emails sent by the API, or the email of a notification type (outbox) */
  group: 'account' | 'notification';
  variables: readonly string[];
  /** must appear in the body, or the email would be useless (e.g. the accept link) */
  required: readonly string[];
  subject: string;
  body: string;
}

const ACCOUNT_TEMPLATES = {
  invite: {
    label: 'Invitation',
    description: 'Sent when staff or a client admin invites someone (expires in 72 hours).',
    group: 'account',
    variables: ['inviterName', 'organizationName', 'acceptUrl'],
    required: ['acceptUrl'],
    subject: "You're invited to Datascribe ({{organizationName}})",
    body: '{{inviterName}} invited you to join {{organizationName}} on Datascribe.\nAccept: {{acceptUrl}}\nThis link expires in 72 hours.',
  },
  password_reset: {
    label: 'Password reset',
    description: 'Sent from "Forgot password" (link valid for 1 hour).',
    group: 'account',
    variables: ['name', 'resetUrl'],
    required: ['resetUrl'],
    subject: 'Reset your Datascribe password',
    body: "Reset your password:\n{{resetUrl}}\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.",
  },
  mfa_reset: {
    label: 'Two-factor reset',
    description: 'Sent when an administrator resets a user’s two-factor authentication.',
    group: 'account',
    variables: ['name'],
    required: [],
    subject: 'Your Datascribe two-factor authentication was reset',
    body: "An administrator reset two-factor authentication on your account and signed out all sessions. You will set it up again at your next sign-in. If you didn't expect this, contact Datascribe support.",
  },
} as const satisfies Record<string, TemplateDef>;

// ─────────────────────────── Notification emails ───────────────────────────

/** Types whose email goes through the outbox (the password-changed mail is sent directly). */
export const NOTIFICATION_EMAIL_TYPES = NOTIFICATION_TYPES.filter(
  (t) => NOTIFICATION_CATALOG[t].email !== 'direct',
);
type OutboxType = Exclude<NotificationType, 'password_changed'>;

/** Template key of a notification type's email. */
export const notificationTemplateKey = (type: string) => `notification_${type}`;

const CASE = ['caseNumber', 'link'] as const;

/**
 * Default text of each notification email. It renders to exactly the bell's title and body
 * (`renderNotification`, checked by a test) plus the link line the outbox always had.
 */
const NOTIFICATION_DEFAULTS: Record<
  OutboxType,
  { variables: readonly string[]; subject: string; body: string }
> = {
  case_submitted: {
    variables: CASE,
    subject: 'Case {{caseNumber}} submitted',
    body: 'Case {{caseNumber}} was submitted for processing.',
  },
  processing_complete: {
    variables: CASE,
    subject: 'Case {{caseNumber}} is ready for review',
    body: 'Processing finished. The draft index, chronology and summary of case {{caseNumber}} are ready for review.',
  },
  processing_failed: {
    variables: CASE,
    subject: 'Case {{caseNumber}} is on hold',
    body: 'A processing stage failed after its retries. Case {{caseNumber}} is on hold until someone looks at it.',
  },
  assigned_to_you: {
    variables: ['caseNumber', 'role', 'link'],
    subject: 'You were assigned to case {{caseNumber}}',
    body: 'You are now the {{role}} on case {{caseNumber}}.',
  },
  qa_changes_requested: {
    variables: CASE,
    subject: 'QA requested changes on case {{caseNumber}}',
    body: 'QA sent the deliverables of case {{caseNumber}} back with comments.',
  },
  approved: {
    variables: CASE,
    subject: 'Case {{caseNumber}} approved',
    body: 'QA approved the deliverables of case {{caseNumber}}.',
  },
  delivered: {
    variables: CASE,
    subject: 'Case {{caseNumber}}: deliverables ready',
    body: 'The final report for case {{caseNumber}} is ready to download.',
  },
  invoice_issued: {
    variables: ['invoiceNumber', 'total', 'dueDate', 'dueNote', 'link'],
    subject: 'Invoice {{invoiceNumber}} issued',
    body: 'Invoice {{invoiceNumber}} for {{total}} was issued.{{dueNote}}',
  },
  payment_received: {
    variables: ['invoiceNumber', 'amount', 'paidNote', 'link'],
    subject: 'Payment received for invoice {{invoiceNumber}}',
    body: 'We received {{amount}} for invoice {{invoiceNumber}}.{{paidNote}}',
  },
  payment_failed: {
    variables: ['invoiceNumber', 'amount', 'link'],
    subject: 'Payment failed for invoice {{invoiceNumber}}',
    body: 'A payment of {{amount}} for invoice {{invoiceNumber}} failed. Please try again or use another card.',
  },
  lead_assigned: {
    variables: ['companyName', 'link'],
    subject: 'Lead assigned: {{companyName}}',
    body: 'The lead {{companyName}} was assigned to you.',
  },
  task_due: {
    variables: ['subject', 'dueAt', 'link'],
    subject: 'Task due: {{subject}}',
    body: 'Your task "{{subject}}" is due {{dueAt}} UTC.',
  },
  invite_accepted: {
    variables: ['name', 'email', 'link'],
    subject: 'Invite accepted',
    body: '{{name}} ({{email}}) accepted your invite and joined.',
  },
  upload_scanned: {
    variables: CASE,
    subject: 'Record checked on case {{caseNumber}}',
    body: 'A record you uploaded to case {{caseNumber}} passed the virus scan.',
  },
  upload_quarantined: {
    variables: CASE,
    subject: 'Record quarantined on case {{caseNumber}}',
    body: "A record uploaded to case {{caseNumber}} failed the virus scan. It was quarantined and can't be opened or processed.",
  },
  upload_scan_failed: {
    variables: CASE,
    subject: 'Record could not be checked on case {{caseNumber}}',
    body: "A record uploaded to case {{caseNumber}} could not be virus-scanned, so it can't be used yet. Try uploading it again.",
  },
};

const LINK_LINE = '\n\nOpen in Datascribe: {{link}}';

const NOTIFICATION_TEMPLATES = Object.fromEntries(
  (Object.keys(NOTIFICATION_DEFAULTS) as OutboxType[]).map((type) => {
    const d = NOTIFICATION_DEFAULTS[type];
    const entry = NOTIFICATION_CATALOG[type];
    const def: TemplateDef = {
      label: `Notification: ${entry.label}`,
      description: `${entry.description} The link to change email preferences is added below non-critical emails and can't be removed.`,
      group: 'notification',
      variables: d.variables,
      required: ['link'],
      subject: d.subject,
      body: d.body + LINK_LINE,
    };
    return [notificationTemplateKey(type), def];
  }),
) as Record<`notification_${OutboxType}`, TemplateDef>;

export const EMAIL_TEMPLATES: Record<
  keyof typeof ACCOUNT_TEMPLATES | `notification_${OutboxType}`,
  TemplateDef
> = { ...ACCOUNT_TEMPLATES, ...NOTIFICATION_TEMPLATES };

export type TemplateKey = keyof typeof EMAIL_TEMPLATES;
export type AccountTemplateKey = keyof typeof ACCOUNT_TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(EMAIL_TEMPLATES) as TemplateKey[];
export const isTemplateKey = (k: string): k is TemplateKey =>
  Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, k);

/** Setting row holding the admin's overrides, keyed by template key. */
export const TEMPLATES_SETTING = 'email_templates';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Variable names used in a text, and whether any `{{`/`}}` is left that isn't a placeholder. */
function scan(text: string): { names: string[]; stray: boolean } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const rest = text.replace(PLACEHOLDER, '');
  return { names, stray: rest.includes('{{') || rest.includes('}}') };
}

/** Problems with an edited template, as field messages (empty = valid). */
export function templateProblems(
  key: TemplateKey,
  tpl: { subject: string; body: string },
): { path: string; message: string }[] {
  const def = EMAIL_TEMPLATES[key];
  const problems: { path: string; message: string }[] = [];
  for (const field of ['subject', 'body'] as const) {
    const { names, stray } = scan(tpl[field]);
    const unknown = [...new Set(names.filter((n) => !def.variables.includes(n)))];
    if (unknown.length) {
      problems.push({
        path: field,
        message: `Unknown variable(s): ${unknown.map((n) => `{{${n}}}`).join(', ')}`,
      });
    }
    if (stray) problems.push({ path: field, message: 'Unmatched {{ or }}' });
  }
  const used = scan(tpl.body).names;
  const missing = def.required.filter((r) => !used.includes(r));
  if (missing.length) {
    problems.push({
      path: 'body',
      message: `Must include ${missing.map((n) => `{{${n}}}`).join(', ')}`,
    });
  }
  return problems;
}

export function renderText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : '',
  );
}

export function renderTemplate(
  tpl: { subject: string; body: string },
  vars: Record<string, string>,
): { subject: string; text: string } {
  return {
    subject: renderText(tpl.subject, vars)
      .replace(/[\r\n]+/g, ' ')
      .trim(),
    text: renderText(tpl.body, vars),
  };
}

export type TemplateOverrides = Partial<
  Record<TemplateKey, { subject: string; body: string; updatedAt?: string }>
>;

/** The admin's stored overrides; one that no longer validates falls back to the default. */
export function parseTemplateOverrides(value: unknown): TemplateOverrides {
  const stored = (value ?? {}) as Record<string, unknown>;
  const out: TemplateOverrides = {};
  for (const key of TEMPLATE_KEYS) {
    const v = stored[key] as { subject?: unknown; body?: unknown; updatedAt?: unknown } | undefined;
    if (v && typeof v.subject === 'string' && typeof v.body === 'string') {
      if (templateProblems(key, { subject: v.subject, body: v.body }).length === 0) {
        out[key] = {
          subject: v.subject,
          body: v.body,
          updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined,
        };
      }
    }
  }
  return out;
}

const ROLE_LABEL: Record<string, string> = {
  case_manager: 'case manager',
  summarizer: 'summarizer',
  qa_reviewer: 'QA reviewer',
};

/**
 * Template variables of one notification, from its stored payload (ids and non-PHI labels only,
 * D-090). `link` is absolute. Missing payload fields become empty strings.
 */
export function notificationEmailVars(
  type: string,
  payload: unknown,
  area: 'portal' | 'console',
  appUrl: string,
): Record<string, string> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const money = (k: string) => `${s('currency')} ${s(k)}`;
  const link = renderNotification(type, payload, area).link;
  const dueDate = s('dueAt').slice(0, 10);
  return {
    link: link ? `${appUrl}${link}` : '',
    caseNumber: s('caseNumber'),
    role: ROLE_LABEL[s('role')] ?? 'assignee',
    invoiceNumber: s('invoiceNumber'),
    total: money('total'),
    amount: money('amount'),
    dueDate,
    dueNote: type === 'invoice_issued' && dueDate ? ` It is due on ${dueDate}.` : '',
    paidNote: p.invoicePaid ? ' The invoice is now paid.' : '',
    companyName: s('companyName'),
    subject: s('subject'),
    dueAt: s('dueAt').slice(0, 16).replace('T', ' '),
    name: s('name'),
    email: s('email'),
  };
}

/**
 * Subject and text of a notification email: the admin's override for its type, else the default.
 * Non-critical emails always end with the preferences link (§5.8 mute), which templates can't drop.
 */
export function renderNotificationEmail(
  type: string,
  payload: unknown,
  opts: { area: 'portal' | 'console'; appUrl: string; overrides?: TemplateOverrides },
): { subject: string; text: string } {
  const key = notificationTemplateKey(type);
  const vars = notificationEmailVars(type, payload, opts.area, opts.appUrl);
  let mail: { subject: string; text: string };
  if (isTemplateKey(key)) {
    mail = renderTemplate(opts.overrides?.[key] ?? EMAIL_TEMPLATES[key], vars);
  } else {
    const r = renderNotification(type, payload, opts.area);
    mail = {
      subject: r.title,
      text: r.body + (vars.link ? `\n\nOpen in Datascribe: ${vars.link}` : ''),
    };
  }
  return withPreferencesFooter(type, mail, opts.area, opts.appUrl);
}

function withPreferencesFooter(
  type: string,
  mail: { subject: string; text: string },
  area: 'portal' | 'console',
  appUrl: string,
) {
  const entry = (NOTIFICATION_CATALOG as Record<string, { critical: boolean } | undefined>)[type];
  if (entry && !entry.critical) {
    mail.text += `\n\nChoose which emails you get: ${appUrl}/${area}/notifications`;
  }
  return mail;
}

const areaFor = (type: OutboxType) =>
  NOTIFICATION_CATALOG[type].audience === 'client' ? 'portal' : 'console';

/** Synthetic payloads for the admin preview of each notification email. */
export const SAMPLE_PAYLOADS: { [K in OutboxType]: NotificationPayloads[K] } = {
  case_submitted: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  processing_complete: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  processing_failed: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  assigned_to_you: { caseId: 'example', caseNumber: 'DS-2026-0001', role: 'summarizer' },
  qa_changes_requested: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  approved: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  delivered: { caseId: 'example', caseNumber: 'DS-2026-0001' },
  invoice_issued: {
    invoiceId: 'example',
    invoiceNumber: 'INV-000123',
    total: '249.00',
    currency: 'USD',
    dueAt: '2026-11-07T00:00:00.000Z',
  },
  payment_received: {
    invoiceId: 'example',
    invoiceNumber: 'INV-000123',
    amount: '249.00',
    currency: 'USD',
    invoicePaid: true,
  },
  payment_failed: {
    invoiceId: 'example',
    invoiceNumber: 'INV-000123',
    amount: '249.00',
    currency: 'USD',
  },
  lead_assigned: { leadId: 'example', companyName: 'Example Injury Law (synthetic)' },
  task_due: {
    activityId: 'example',
    subject: 'Follow-up call (synthetic)',
    dueAt: '2026-10-25T09:00:00.000Z',
    leadId: 'example',
  },
  invite_accepted: {
    inviteId: 'example',
    userId: 'example',
    name: 'Sam Synthetic',
    email: 'sam@example.com',
  },
  upload_scanned: { caseId: 'example', caseNumber: 'DS-2026-0001', documentId: 'example' },
  upload_quarantined: { caseId: 'example', caseNumber: 'DS-2026-0001', documentId: 'example' },
  upload_scan_failed: { caseId: 'example', caseNumber: 'DS-2026-0001', documentId: 'example' },
};

const notificationTypeOf = (key: TemplateKey): OutboxType | null => {
  const type = key.startsWith('notification_') ? key.slice('notification_'.length) : null;
  return type && Object.prototype.hasOwnProperty.call(SAMPLE_PAYLOADS, type)
    ? (type as OutboxType)
    : null;
};

/** Sample values for the admin preview of any template (synthetic). */
export function sampleTemplateVars(key: TemplateKey, appUrl: string): Record<string, string> {
  const type = notificationTypeOf(key);
  if (type) return notificationEmailVars(type, SAMPLE_PAYLOADS[type], areaFor(type), appUrl);
  return {
    inviterName: 'Alex Example',
    organizationName: 'Acme Injury Law (synthetic)',
    acceptUrl: `${appUrl}/invite/accept?token=example`,
    name: 'Sam Synthetic',
    resetUrl: `${appUrl}/reset-password?token=example`,
  };
}

/** A draft rendered with sample values, as it would be sent (preferences footer included). */
export function previewTemplate(
  key: TemplateKey,
  tpl: { subject: string; body: string },
  appUrl: string,
): { subject: string; text: string } {
  const mail = renderTemplate(tpl, sampleTemplateVars(key, appUrl));
  const type = notificationTypeOf(key);
  return type ? withPreferencesFooter(type, mail, areaFor(type), appUrl) : mail;
}
