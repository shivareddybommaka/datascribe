import type { Logger } from 'pino';

/**
 * Run a notification dispatch after the action that raised it. A failure is logged (event name and
 * error name only) and never fails the request: the domain change has already happened (D-090).
 */
export async function safeNotify(
  logger: Logger,
  event: string,
  dispatch: () => Promise<unknown>,
): Promise<void> {
  try {
    await dispatch();
  } catch (err) {
    logger.warn({ event, err: { name: (err as Error).name } }, 'notification dispatch failed');
  }
}
