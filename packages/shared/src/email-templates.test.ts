import { describe, expect, it } from 'vitest';
import {
  EMAIL_TEMPLATES,
  NOTIFICATION_EMAIL_TYPES,
  SAMPLE_PAYLOADS,
  TEMPLATE_KEYS,
  notificationTemplateKey,
  parseTemplateOverrides,
  previewTemplate,
  renderNotificationEmail,
  templateProblems,
} from './email-templates';
import { NOTIFICATION_CATALOG, renderNotification } from './notifications';

const APP = 'http://app.test';

describe('notification email templates (D-097)', () => {
  it('has one template per outbox type, and every default validates', () => {
    expect(NOTIFICATION_EMAIL_TYPES).not.toContain('password_changed');
    for (const type of NOTIFICATION_EMAIL_TYPES) {
      expect(TEMPLATE_KEYS).toContain(notificationTemplateKey(type));
    }
    for (const key of TEMPLATE_KEYS) {
      expect(templateProblems(key, EMAIL_TEMPLATES[key]), key).toEqual([]);
    }
  });

  it('the default email says exactly what the bell says, plus the link', () => {
    for (const type of NOTIFICATION_EMAIL_TYPES) {
      const payload = SAMPLE_PAYLOADS[type as keyof typeof SAMPLE_PAYLOADS];
      for (const area of ['portal', 'console'] as const) {
        const bell = renderNotification(type, payload, area);
        const mail = renderNotificationEmail(type, payload, { area, appUrl: APP });
        expect(mail.subject, type).toBe(bell.title);
        expect(mail.text.startsWith(`${bell.body}\n\nOpen in Datascribe: ${APP}${bell.link}`)).toBe(
          true,
        );
      }
    }
  });

  it('variants follow the payload: no due date, unpaid invoice, unknown role', () => {
    const issued = renderNotificationEmail(
      'invoice_issued',
      { ...SAMPLE_PAYLOADS.invoice_issued, dueAt: null },
      { area: 'portal', appUrl: APP },
    );
    expect(issued.text).toMatch(/^Invoice INV-000123 for USD 249\.00 was issued\.\n/);
    const partial = renderNotificationEmail(
      'payment_received',
      { ...SAMPLE_PAYLOADS.payment_received, invoicePaid: false },
      { area: 'portal', appUrl: APP },
    );
    expect(partial.text).not.toContain('now paid');
    const role = renderNotificationEmail(
      'assigned_to_you',
      { caseId: 'c', caseNumber: 'DS-1', role: 'nope' },
      { area: 'console', appUrl: APP },
    );
    expect(role.text).toContain('You are now the assignee on case DS-1.');
  });

  it('non-critical emails keep the preferences link; critical ones have none', () => {
    const scanned = renderNotificationEmail('upload_scanned', SAMPLE_PAYLOADS.upload_scanned, {
      area: 'portal',
      appUrl: APP,
    });
    expect(scanned.text).toContain(`Choose which emails you get: ${APP}/portal/notifications`);
    for (const type of ['payment_failed', 'upload_quarantined'] as const) {
      expect(NOTIFICATION_CATALOG[type].critical).toBe(true);
      const mail = renderNotificationEmail(type, SAMPLE_PAYLOADS[type], {
        area: 'portal',
        appUrl: APP,
      });
      expect(mail.text).not.toContain('Choose which emails you get');
    }
  });

  it("uses the admin's override; its footer can't be removed; values go in literally", () => {
    const overrides = parseTemplateOverrides({
      notification_case_submitted: {
        subject: 'New work: {{caseNumber}}\nBcc: x@example.com',
        body: 'Please pick up {{caseNumber}}: {{link}}',
      },
    });
    const mail = renderNotificationEmail(
      'case_submitted',
      { caseId: 'c1', caseNumber: '{{link}}' },
      { area: 'console', appUrl: APP, overrides },
    );
    expect(mail.subject).toBe('New work: {{link}} Bcc: x@example.com');
    expect(mail.text).toBe(
      `Please pick up {{link}}: ${APP}/console/cases/c1\n\nChoose which emails you get: ${APP}/console/notifications`,
    );
  });

  it('ignores stored overrides that no longer validate', () => {
    const overrides = parseTemplateOverrides({
      notification_delivered: { subject: 'Hi {{patientName}}', body: '{{link}}' },
      notification_approved: { subject: 'Approved', body: 'no link' },
      notification_task_due: { subject: 7, body: '{{link}}' },
      nope: { subject: 'x', body: 'y' },
    });
    expect(overrides).toEqual({});
  });

  it('notification templates require the link and reject variables of other types', () => {
    const key = notificationTemplateKey('invoice_issued') as keyof typeof EMAIL_TEMPLATES;
    expect(templateProblems(key, { subject: 'x', body: 'no link' })[0]?.message).toContain(
      '{{link}}',
    );
    expect(
      templateProblems(key, { subject: '{{caseNumber}}', body: '{{link}}' })[0]?.message,
    ).toContain('Unknown variable');
  });

  it('previews with synthetic sample values and the footer', () => {
    const p = previewTemplate(
      'notification_task_due',
      { subject: 'Due: {{subject}}', body: '{{dueAt}} {{link}}' },
      APP,
    );
    expect(p.subject).toBe('Due: Follow-up call (synthetic)');
    expect(p.text).toContain('2026-10-25 09:00 http://app.test/console/crm/leads/example');
    expect(p.text).toContain('/console/notifications');
    expect(
      previewTemplate('invite', { subject: 'Hi {{inviterName}}', body: '{{acceptUrl}}' }, APP),
    ).toMatchObject({ subject: 'Hi Alex Example' });
  });
});
