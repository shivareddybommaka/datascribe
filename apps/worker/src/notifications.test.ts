import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_SCHEDULES, processNotificationJob } from './notifications';

const handlers = () => ({
  deliverEmails: vi.fn(async () => ({ sent: 2, retrying: 1, failed: 0, skipped: 0 })),
  notifyTasksDue: vi.fn(async () => 3),
});

describe('notification jobs', () => {
  it('sends the email outbox with the job time', async () => {
    const h = handlers();
    const now = new Date('2026-10-24T01:00:00Z');
    expect(await processNotificationJob('deliver-emails', h, now)).toEqual({
      sent: 2,
      retrying: 1,
      failed: 0,
      skipped: 0,
    });
    expect(h.deliverEmails).toHaveBeenCalledWith(now);
    expect(h.notifyTasksDue).not.toHaveBeenCalled();
  });

  it('raises task-due notifications', async () => {
    expect(await processNotificationJob('tasks-due', handlers())).toEqual({ notified: 3 });
  });

  it('fails loudly on unknown jobs', async () => {
    await expect(processNotificationJob('nope', handlers())).rejects.toThrow(/Unknown/);
  });

  it('repeats both jobs', () => {
    expect(Object.keys(NOTIFICATION_SCHEDULES).sort()).toEqual(['deliver-emails', 'tasks-due']);
  });
});
