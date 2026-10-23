import { describe, expect, it } from 'vitest';
import { daysPastDue, reminderDue, reminderEmail } from './dunning';

const due = new Date('2026-06-15T00:00:00Z');
const at = (iso: string) => new Date(iso);

describe('dunning schedule (due date, +7, +14)', () => {
  it('counts whole UTC days', () => {
    expect(daysPastDue(due, at('2026-06-14T23:59:00Z'))).toBe(-1);
    expect(daysPastDue(due, at('2026-06-15T08:00:00Z'))).toBe(0);
    expect(daysPastDue(due, at('2026-06-22T00:00:00Z'))).toBe(7);
  });

  it('owes nothing before the due date', () => {
    expect(reminderDue({ dueAt: due, remindersSent: 0 }, at('2026-06-14T10:00:00Z'))).toBeNull();
  });

  it('sends each reminder once, in order', () => {
    expect(reminderDue({ dueAt: due, remindersSent: 0 }, at('2026-06-15T10:00:00Z'))).toEqual({
      stage: 0,
      remindersSent: 1,
    });
    expect(reminderDue({ dueAt: due, remindersSent: 1 }, at('2026-06-16T10:00:00Z'))).toBeNull();
    expect(reminderDue({ dueAt: due, remindersSent: 1 }, at('2026-06-22T10:00:00Z'))).toEqual({
      stage: 1,
      remindersSent: 2,
    });
    expect(reminderDue({ dueAt: due, remindersSent: 2 }, at('2026-06-29T10:00:00Z'))).toEqual({
      stage: 2,
      remindersSent: 3,
    });
    expect(reminderDue({ dueAt: due, remindersSent: 3 }, at('2026-08-01T10:00:00Z'))).toBeNull();
  });

  it('after a missed run sends only the latest reminder', () => {
    expect(reminderDue({ dueAt: due, remindersSent: 0 }, at('2026-07-01T10:00:00Z'))).toEqual({
      stage: 2,
      remindersSent: 3,
    });
  });

  it('writes due-today and overdue emails', () => {
    const base = {
      number: 'INV-2026-00007',
      total: '1759.25',
      currency: 'USD',
      dueAt: due,
      organizationName: 'Acme',
      payUrl: 'http://localhost:3010/portal/billing/invoices/x',
    };
    const first = reminderEmail({ ...base, stage: 0 });
    expect(first.subject).toBe('Invoice INV-2026-00007 is due today');
    expect(first.text).toContain('USD 1759.25');
    expect(first.text).toContain(base.payUrl);
    expect(reminderEmail({ ...base, stage: 2 }).subject).toBe(
      'Reminder: invoice INV-2026-00007 is 14 days overdue',
    );
  });
});
