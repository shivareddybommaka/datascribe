import { startOfUtcDay } from './invoice';

/** §5.6: reminders at the due date, +7 days and +14 days. */
export const DUNNING_OFFSETS_DAYS = [0, 7, 14] as const;

/** Whole UTC days from the due date to now (negative before the due date). */
export function daysPastDue(dueAt: Date, now: Date): number {
  return Math.floor((startOfUtcDay(now).getTime() - startOfUtcDay(dueAt).getTime()) / 86_400_000);
}

/**
 * Which reminder (0, 1 or 2) is owed now, or null. If the job missed a run, only the latest owed
 * reminder is sent, never a burst of catch-up emails.
 */
export function reminderDue(
  invoice: { dueAt: Date; remindersSent: number },
  now: Date,
): { stage: number; remindersSent: number } | null {
  const days = daysPastDue(invoice.dueAt, now);
  const owed = DUNNING_OFFSETS_DAYS.filter((d) => days >= d).length;
  if (owed <= invoice.remindersSent) return null;
  return { stage: owed - 1, remindersSent: owed };
}

export function reminderEmail(input: {
  stage: number;
  number: string;
  total: string;
  currency: string;
  dueAt: Date;
  organizationName: string;
  payUrl: string;
}): { subject: string; text: string } {
  const due = input.dueAt.toISOString().slice(0, 10);
  const amount = `${input.currency} ${input.total}`;
  const subject =
    input.stage === 0
      ? `Invoice ${input.number} is due today`
      : `Reminder: invoice ${input.number} is ${DUNNING_OFFSETS_DAYS[input.stage]} days overdue`;
  const text = [
    `Hello ${input.organizationName},`,
    '',
    input.stage === 0
      ? `Invoice ${input.number} for ${amount} is due today (${due}).`
      : `Invoice ${input.number} for ${amount} was due on ${due} and is still unpaid.`,
    '',
    `You can pay it by card here: ${input.payUrl}`,
    '',
    'If you have already paid, please ignore this message.',
    '',
    'Datascribe billing',
  ].join('\n');
  return { subject, text };
}
