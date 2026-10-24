/**
 * Notification catalog (§5.8, M9, D-090): every type, who it is for, its default channels and its
 * text. Browser-safe (no Node imports), so the web app can use the labels too.
 *
 * PHI rule: payloads carry ids and non-PHI labels only (case numbers, invoice numbers, amounts, CRM
 * company names). Never patient names, matter names, file names or document text: those can name
 * a patient, and subjects end up in mail logs and lock screens.
 */

/** The §5.8 events. Admins switch email / in-app per event in Settings (D-063). */
export const SETTINGS_EVENTS = [
  'case_submitted',
  'processing_complete',
  'assigned_to_you',
  'qa_changes_requested',
  'approved',
  'delivered',
  'invoice_issued',
  'payment_received',
  'payment_failed',
  'lead_assigned',
  'task_due',
] as const;
export type SettingsEvent = (typeof SETTINGS_EVENTS)[number];

export interface NotificationPayloads {
  case_submitted: { caseId: string; caseNumber: string };
  /** M5b stage 7: case reached in_review */
  processing_complete: { caseId: string; caseNumber: string };
  /** M5b: a stage failed after its retries, case on_hold (§7) */
  processing_failed: { caseId: string; caseNumber: string };
  /** M6: case manager assigns summarizer / QA reviewer */
  assigned_to_you: {
    caseId: string;
    caseNumber: string;
    role: 'case_manager' | 'summarizer' | 'qa_reviewer';
  };
  /** M6 QA rejected */
  qa_changes_requested: { caseId: string; caseNumber: string };
  /** M6 QA approved */
  approved: { caseId: string; caseNumber: string };
  /** M6 final report delivered to the client */
  delivered: { caseId: string; caseNumber: string };
  invoice_issued: {
    invoiceId: string;
    invoiceNumber: string;
    total: string;
    currency: string;
    dueAt: string | null;
  };
  payment_received: {
    invoiceId: string;
    invoiceNumber: string;
    amount: string;
    currency: string;
    invoicePaid: boolean;
  };
  payment_failed: { invoiceId: string; invoiceNumber: string; amount: string; currency: string };
  lead_assigned: { leadId: string; companyName: string };
  task_due: { activityId: string; subject: string; dueAt: string; leadId: string | null };
  invite_accepted: { inviteId: string; userId: string; name: string; email: string };
  upload_scanned: { caseId: string; caseNumber: string; documentId: string };
  upload_quarantined: { caseId: string; caseNumber: string; documentId: string };
  upload_scan_failed: { caseId: string; caseNumber: string; documentId: string };
  password_changed: Record<string, never>;
}

export type NotificationType = keyof NotificationPayloads;

/** A typed domain event: the type decides the payload shape. */
export type NotificationEvent = {
  [K in NotificationType]: { type: K; payload: NotificationPayloads[K] };
}[NotificationType];

export type NotificationCategory = 'cases' | 'uploads' | 'billing' | 'crm' | 'account';

export interface CatalogEntry {
  label: string;
  description: string;
  category: NotificationCategory;
  /** who can receive it: client users, staff, or both */
  audience: 'client' | 'staff' | 'any';
  /** critical: the user can't mute its email or in-app entry (§5.8 "security emails") */
  critical: boolean;
  defaultEmail: boolean;
  /**
   * `direct`: the email is sent by the caller at once (e.g. the password-changed security mail);
   * the dispatcher only records the in-app entry.
   */
  email?: 'outbox' | 'direct';
  /** admin rule key in Settings → Notifications, for the §5.8 events */
  settingsKey?: SettingsEvent;
  /** raised by code that a later milestone builds (emit helper exists already) */
  raisedIn?: 'M5b' | 'M6';
}

export const NOTIFICATION_CATALOG: Record<NotificationType, CatalogEntry> = {
  case_submitted: {
    label: 'Case submitted',
    description: 'A firm submitted a case for processing.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'case_submitted',
  },
  processing_complete: {
    label: 'Ready for review',
    description: 'Processing finished and the case is ready for review.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'processing_complete',
    raisedIn: 'M5b',
  },
  processing_failed: {
    label: 'Processing failed',
    description: 'A processing stage failed and the case is on hold.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    raisedIn: 'M5b',
  },
  assigned_to_you: {
    label: 'Assigned to you',
    description: 'You were assigned to a case.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'assigned_to_you',
    raisedIn: 'M6',
  },
  qa_changes_requested: {
    label: 'QA changes requested',
    description: 'QA sent a deliverable back with comments.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'qa_changes_requested',
    raisedIn: 'M6',
  },
  approved: {
    label: 'QA approved',
    description: 'QA approved the deliverables of a case.',
    category: 'cases',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'approved',
    raisedIn: 'M6',
  },
  delivered: {
    label: 'Deliverables ready',
    description: 'The final report of a case is ready to download.',
    category: 'cases',
    audience: 'any',
    critical: false,
    defaultEmail: true,
    settingsKey: 'delivered',
    raisedIn: 'M6',
  },
  invoice_issued: {
    label: 'Invoice issued',
    description: 'A new invoice was issued to your firm.',
    category: 'billing',
    audience: 'client',
    critical: false,
    defaultEmail: true,
    settingsKey: 'invoice_issued',
  },
  payment_received: {
    label: 'Payment received',
    description: 'A payment on an invoice went through.',
    category: 'billing',
    audience: 'any',
    critical: false,
    defaultEmail: true,
    settingsKey: 'payment_received',
  },
  payment_failed: {
    label: 'Payment failed',
    description: 'A card payment on an invoice failed.',
    category: 'billing',
    audience: 'client',
    critical: true,
    defaultEmail: true,
    settingsKey: 'payment_failed',
  },
  lead_assigned: {
    label: 'Lead assigned',
    description: 'A CRM lead was assigned to you.',
    category: 'crm',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'lead_assigned',
  },
  task_due: {
    label: 'Task due',
    description: 'One of your CRM tasks is due within 24 hours.',
    category: 'crm',
    audience: 'staff',
    critical: false,
    defaultEmail: true,
    settingsKey: 'task_due',
  },
  invite_accepted: {
    label: 'Invite accepted',
    description: 'Someone you invited joined Datascribe.',
    category: 'account',
    audience: 'any',
    critical: false,
    defaultEmail: false,
  },
  upload_scanned: {
    label: 'Upload checked',
    description: 'A record you uploaded passed the virus scan.',
    category: 'uploads',
    audience: 'any',
    critical: false,
    defaultEmail: false,
  },
  upload_quarantined: {
    label: 'Upload quarantined',
    description: 'A record failed the virus scan and was quarantined.',
    category: 'uploads',
    audience: 'any',
    critical: true,
    defaultEmail: true,
  },
  upload_scan_failed: {
    label: 'Upload check failed',
    description: 'A record could not be scanned and cannot be used yet.',
    category: 'uploads',
    audience: 'any',
    critical: false,
    defaultEmail: true,
  },
  password_changed: {
    label: 'Password changed',
    description: 'Your password was changed (security notice).',
    category: 'account',
    audience: 'any',
    critical: true,
    defaultEmail: true,
    email: 'direct',
  },
};

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_CATALOG) as NotificationType[];

export const isNotificationType = (t: string): t is NotificationType =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, t);

/** Types a user of this kind can receive (and set preferences for). */
export function typesFor(orgType: 'client' | 'internal'): NotificationType[] {
  const want = orgType === 'client' ? 'client' : 'staff';
  return NOTIFICATION_TYPES.filter((t) => {
    const a = NOTIFICATION_CATALOG[t].audience;
    return a === 'any' || a === want;
  });
}

export interface RenderedNotification {
  /** also the email subject: no PHI */
  title: string;
  body: string;
  /** app path, e.g. /portal/cases/abc */
  link: string | null;
}

const money = (amount: string, currency: string) => `${currency} ${amount}`;

/**
 * Title / body / link for the bell and for email. `area` is where the recipient works: the client
 * portal or the staff console. Unknown or malformed payloads render generically rather than throw.
 */
export function renderNotification(
  type: string,
  payload: unknown,
  area: 'portal' | 'console',
): RenderedNotification {
  const p = (payload ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const caseLink = s('caseId') ? `/${area}/cases/${s('caseId')}` : null;
  const invoiceLink = s('invoiceId')
    ? area === 'portal'
      ? `/portal/billing/invoices/${s('invoiceId')}`
      : `/console/finance/invoices/${s('invoiceId')}`
    : null;
  const c = s('caseNumber');
  switch (type) {
    case 'case_submitted':
      return {
        title: `Case ${c} submitted`,
        body: `Case ${c} was submitted for processing.`,
        link: caseLink,
      };
    case 'processing_complete':
      return {
        title: `Case ${c} is ready for review`,
        body: `Processing finished. The draft index, chronology and summary of case ${c} are ready for review.`,
        link: caseLink,
      };
    case 'processing_failed':
      return {
        title: `Case ${c} is on hold`,
        body: `A processing stage failed after its retries. Case ${c} is on hold until someone looks at it.`,
        link: caseLink,
      };
    case 'assigned_to_you': {
      const role = {
        case_manager: 'case manager',
        summarizer: 'summarizer',
        qa_reviewer: 'QA reviewer',
      }[s('role')];
      return {
        title: `You were assigned to case ${c}`,
        body: `You are now the ${role ?? 'assignee'} on case ${c}.`,
        link: caseLink,
      };
    }
    case 'qa_changes_requested':
      return {
        title: `QA requested changes on case ${c}`,
        body: `QA sent the deliverables of case ${c} back with comments.`,
        link: caseLink,
      };
    case 'approved':
      return {
        title: `Case ${c} approved`,
        body: `QA approved the deliverables of case ${c}.`,
        link: caseLink,
      };
    case 'delivered':
      return {
        title: `Case ${c}: deliverables ready`,
        body: `The final report for case ${c} is ready to download.`,
        link: caseLink,
      };
    case 'invoice_issued': {
      const due = s('dueAt') ? ` It is due on ${s('dueAt').slice(0, 10)}.` : '';
      return {
        title: `Invoice ${s('invoiceNumber')} issued`,
        body: `Invoice ${s('invoiceNumber')} for ${money(s('total'), s('currency'))} was issued.${due}`,
        link: invoiceLink,
      };
    }
    case 'payment_received':
      return {
        title: `Payment received for invoice ${s('invoiceNumber')}`,
        body: `We received ${money(s('amount'), s('currency'))} for invoice ${s('invoiceNumber')}.${p.invoicePaid ? ' The invoice is now paid.' : ''}`,
        link: invoiceLink,
      };
    case 'payment_failed':
      return {
        title: `Payment failed for invoice ${s('invoiceNumber')}`,
        body: `A payment of ${money(s('amount'), s('currency'))} for invoice ${s('invoiceNumber')} failed. Please try again or use another card.`,
        link: invoiceLink,
      };
    case 'lead_assigned':
      return {
        title: `Lead assigned: ${s('companyName')}`,
        body: `The lead ${s('companyName')} was assigned to you.`,
        link: s('leadId') ? `/console/crm/leads/${s('leadId')}` : null,
      };
    case 'task_due':
      return {
        title: `Task due: ${s('subject')}`,
        body: `Your task "${s('subject')}" is due ${s('dueAt').slice(0, 16).replace('T', ' ')} UTC.`,
        link: s('leadId') ? `/console/crm/leads/${s('leadId')}` : '/console/crm',
      };
    case 'invite_accepted':
      return {
        title: 'Invite accepted',
        body: `${s('name')} (${s('email')}) accepted your invite and joined.`,
        link: area === 'portal' ? '/portal/firm' : '/console/admin/users',
      };
    case 'upload_scanned':
      return {
        title: `Record checked on case ${c}`,
        body: `A record you uploaded to case ${c} passed the virus scan.`,
        link: caseLink,
      };
    case 'upload_quarantined':
      return {
        title: `Record quarantined on case ${c}`,
        body: `A record uploaded to case ${c} failed the virus scan. It was quarantined and can't be opened or processed.`,
        link: caseLink,
      };
    case 'upload_scan_failed':
      return {
        title: `Record could not be checked on case ${c}`,
        body: `A record uploaded to case ${c} could not be virus-scanned, so it can't be used yet. Try uploading it again.`,
        link: caseLink,
      };
    case 'password_changed':
      return {
        title: 'Your password was changed',
        body: "Your password was changed and all sessions were signed out. If this wasn't you, contact Datascribe support immediately.",
        link: null,
      };
    default:
      return { title: 'Notification', body: '', link: null };
  }
}
