import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_TYPES,
  SETTINGS_EVENTS,
  isNotificationType,
  renderNotification,
  typesFor,
  type NotificationPayloads,
} from './notifications';

const caseP = { caseId: 'c1', caseNumber: 'DS-2026-000001' };
const SAMPLES: { [K in keyof NotificationPayloads]: NotificationPayloads[K] } = {
  case_submitted: caseP,
  processing_complete: caseP,
  processing_failed: caseP,
  assigned_to_you: { ...caseP, role: 'qa_reviewer' },
  qa_changes_requested: caseP,
  approved: caseP,
  delivered: caseP,
  invoice_issued: {
    invoiceId: 'i1',
    invoiceNumber: 'INV-2026-0001',
    total: '120.00',
    currency: 'USD',
    dueAt: '2026-11-07T00:00:00.000Z',
  },
  payment_received: {
    invoiceId: 'i1',
    invoiceNumber: 'INV-2026-0001',
    amount: '120.00',
    currency: 'USD',
    invoicePaid: true,
  },
  payment_failed: {
    invoiceId: 'i1',
    invoiceNumber: 'INV-2026-0001',
    amount: '1.00',
    currency: 'USD',
  },
  lead_assigned: { leadId: 'l1', companyName: 'Acme (synthetic)' },
  task_due: {
    activityId: 'a1',
    subject: 'Call back',
    dueAt: '2026-10-25T03:00:00.000Z',
    leadId: null,
  },
  invite_accepted: { inviteId: 'v1', userId: 'u1', name: 'Sam', email: 'sam@test.example' },
  upload_scanned: { ...caseP, documentId: 'd1' },
  upload_quarantined: { ...caseP, documentId: 'd1' },
  upload_scan_failed: { ...caseP, documentId: 'd1' },
  password_changed: {},
};

describe('notification catalog', () => {
  it('covers every §5.8 event exactly once', () => {
    const keys = NOTIFICATION_TYPES.map((t) => NOTIFICATION_CATALOG[t].settingsKey).filter(Boolean);
    expect([...keys].sort()).toEqual([...SETTINGS_EVENTS].sort());
  });

  it('renders a title, body and link for every type', () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const area of ['portal', 'console'] as const) {
        const r = renderNotification(type, SAMPLES[type], area);
        expect(r.title, type).not.toBe('Notification');
        expect(r.title).not.toMatch(/\n/);
        expect(r.body.length, type).toBeGreaterThan(10);
        if (r.link) expect(r.link.startsWith('/')).toBe(true);
      }
    }
  });

  it('links to the area the recipient works in', () => {
    expect(renderNotification('delivered', caseP, 'portal').link).toBe('/portal/cases/c1');
    expect(renderNotification('delivered', caseP, 'console').link).toBe('/console/cases/c1');
    expect(renderNotification('invoice_issued', SAMPLES.invoice_issued, 'console').link).toBe(
      '/console/finance/invoices/i1',
    );
    expect(renderNotification('task_due', SAMPLES.task_due, 'console').link).toBe('/console/crm');
  });

  it('subjects only use the fields the payload carries (no PHI fields exist)', () => {
    const r = renderNotification(
      'case_submitted',
      { ...caseP, patientName: 'Jane Synthetic', matterName: 'Synthetic v. Example' },
      'console',
    );
    expect(r.title).toBe('Case DS-2026-000001 submitted');
    expect(`${r.title} ${r.body}`).not.toMatch(/Jane|Synthetic v/);
  });

  it('renders unknown or malformed rows generically instead of throwing', () => {
    expect(renderNotification('nope', null, 'portal')).toEqual({
      title: 'Notification',
      body: '',
      link: null,
    });
    expect(renderNotification('case_submitted', 'garbage', 'portal').link).toBeNull();
  });

  it('splits types by audience', () => {
    const client = typesFor('client');
    const staff = typesFor('internal');
    expect(client).toContain('invoice_issued');
    expect(client).not.toContain('lead_assigned');
    expect(staff).toContain('lead_assigned');
    expect(staff).not.toContain('payment_failed');
    expect(client).toContain('password_changed');
    expect(staff).toContain('password_changed');
  });

  it('marks security notices critical and only those raised later with a milestone', () => {
    expect(NOTIFICATION_CATALOG.password_changed.critical).toBe(true);
    expect(NOTIFICATION_CATALOG.upload_quarantined.critical).toBe(true);
    expect(NOTIFICATION_CATALOG.lead_assigned.critical).toBe(false);
    expect(isNotificationType('task_due')).toBe(true);
    expect(isNotificationType('toString')).toBe(false);
  });
});
