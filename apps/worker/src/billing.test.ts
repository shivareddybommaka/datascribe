import { describe, expect, it, vi } from 'vitest';
import { BILLING_SCHEDULES, processBillingJob } from './billing';

const deps = () => ({
  runMonthlyInvoicing: vi.fn(async () => ({ invoiceIds: ['a', 'b'], periodsClosed: 2, canceled: 1 })),
  runDunning: vi.fn(async () => ({ remindersSent: 3, emails: 4, markedOverdue: 1 })),
});

describe('billing jobs', () => {
  it('dispatches the monthly invoicing run with the job time', async () => {
    const d = deps();
    const now = new Date('2026-06-02T02:00:00Z');
    expect(await processBillingJob('monthly-invoicing', d, now)).toEqual({
      invoices: 2,
      periodsClosed: 2,
      canceled: 1,
    });
    expect(d.runMonthlyInvoicing).toHaveBeenCalledWith(now);
    expect(d.runDunning).not.toHaveBeenCalled();
  });

  it('dispatches dunning', async () => {
    const d = deps();
    expect(await processBillingJob('dunning', d)).toEqual({
      remindersSent: 3,
      emails: 4,
      markedOverdue: 1,
    });
  });

  it('fails loudly on unknown jobs', async () => {
    await expect(processBillingJob('nope', deps())).rejects.toThrow(/Unknown billing job/);
  });

  it('has a daily schedule for each job', () => {
    expect(Object.keys(BILLING_SCHEDULES).sort()).toEqual(['dunning', 'monthly-invoicing']);
    for (const s of Object.values(BILLING_SCHEDULES)) expect(s.pattern).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
