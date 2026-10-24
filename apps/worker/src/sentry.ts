import { resolveDeployEnv } from '@datascribe/shared/deploy';
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubTransaction,
  sentryConfig,
} from '@datascribe/shared/sentry';
import * as Sentry from '@sentry/node';

export type ReportJobError = (err: unknown, queue: string) => void;

/**
 * Error reporting (D-119): off unless SENTRY_DSN is set. Events are scrubbed of PHI, bodies,
 * auth headers and query strings before they leave the process. Returns the reporter for jobs
 * that failed their last attempt, or undefined when Sentry is off.
 */
export function initSentry(env: Record<string, string | undefined>): ReportJobError | undefined {
  const config = sentryConfig(env, resolveDeployEnv(env));
  if (!config) return undefined;
  Sentry.init({
    ...config,
    initialScope: { tags: { service: 'worker' } },
    includeLocalVariables: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubTransaction,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  // job data (case / document ids) is not attached: the queue name is enough to find the logs
  return (err, queue) => Sentry.captureException(err, { tags: { queue } });
}

/** Sends what is queued before shutdown; a no-op when Sentry is off. */
export const closeSentry = (): Promise<boolean> => Sentry.close(2_000);

/** Retries are expected; only a job's last failed attempt is worth an alert. */
export function isFinalAttempt(job: { attemptsMade: number; opts: { attempts?: number } }) {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
