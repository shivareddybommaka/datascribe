import type { InvoicingResult } from '@datascribe/billing';

/** BullMQ queue for billing jobs (§3: "billing jobs" live in apps/worker). */
export const BILLING_QUEUE = 'billing';

/**
 * Repeatable schedules (UTC). Invoicing runs daily and bills every subscription whose monthly
 * period has ended, so each firm is invoiced on its own anniversary and a missed day self-heals
 * (D-043). Dunning runs daily for the due-date / +7 / +14 reminders.
 */
export const BILLING_SCHEDULES = {
  'monthly-invoicing': { pattern: '0 2 * * *' },
  dunning: { pattern: '0 9 * * *' },
} as const;
export type BillingJob = keyof typeof BILLING_SCHEDULES;

export interface BillingJobDeps {
  runMonthlyInvoicing(now: Date): Promise<InvoicingResult>;
  runDunning(now: Date): Promise<{ remindersSent: number; emails: number; markedOverdue: number }>;
}

/** Job dispatcher: kept free of BullMQ/Redis so it is unit-testable. */
export async function processBillingJob(
  name: string,
  deps: BillingJobDeps,
  now = new Date(),
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'monthly-invoicing': {
      const r = await deps.runMonthlyInvoicing(now);
      return {
        invoices: r.invoiceIds.length,
        periodsClosed: r.periodsClosed,
        canceled: r.canceled,
      };
    }
    case 'dunning':
      return { ...(await deps.runDunning(now)) };
    default:
      throw new Error(`Unknown billing job: ${name}`);
  }
}
