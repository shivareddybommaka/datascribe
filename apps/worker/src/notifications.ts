import type { DeliveryResult } from '@datascribe/db/notifications';

/** M9 notifications queue (D-090): sends the email outbox and raises "task due". */
export const NOTIFICATIONS_QUEUE = 'notifications';

/** Repeatable jobs, upserted at start-up (restarts never duplicate them). */
export const NOTIFICATION_SCHEDULES = {
  'deliver-emails': { every: 10_000 },
  'tasks-due': { every: 15 * 60_000 },
} as const;

export type NotificationJob = keyof typeof NOTIFICATION_SCHEDULES;

export interface NotificationHandlers {
  deliverEmails(now: Date): Promise<DeliveryResult>;
  notifyTasksDue(now: Date): Promise<number>;
}

export async function processNotificationJob(
  name: string,
  handlers: NotificationHandlers,
  now = new Date(),
): Promise<DeliveryResult | { notified: number }> {
  switch (name as NotificationJob) {
    case 'deliver-emails':
      return handlers.deliverEmails(now);
    case 'tasks-due':
      return { notified: await handlers.notifyTasksDue(now) };
    default:
      throw new Error(`Unknown notifications job: ${name}`);
  }
}
