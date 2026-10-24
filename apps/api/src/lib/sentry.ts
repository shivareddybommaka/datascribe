import {
  scrubBreadcrumb,
  scrubEvent,
  scrubTransaction,
  sentryConfig,
} from '@datascribe/shared/sentry';
import * as Sentry from '@sentry/node';
import type { Env } from '../config/env';

/**
 * Error reporting (D-119): off unless SENTRY_DSN is set, so tests and local runs never call out.
 * Every event, transaction and breadcrumb is scrubbed of PHI, bodies, cookies, auth headers and
 * query strings before it leaves the process. Returns the reporter for unhandled errors, or
 * undefined when Sentry is off.
 */
export function initSentry(env: Env): ((err: unknown) => void) | undefined {
  const config = sentryConfig(
    {
      SENTRY_DSN: env.SENTRY_DSN,
      SENTRY_TRACES_SAMPLE_RATE: env.SENTRY_TRACES_SAMPLE_RATE,
      SENTRY_ENVIRONMENT: env.SENTRY_ENVIRONMENT,
      SENTRY_RELEASE: env.SENTRY_RELEASE,
    },
    env.DEPLOY_ENV,
  );
  if (!config) return undefined;
  Sentry.init({
    ...config,
    initialScope: { tags: { service: 'api' } },
    includeLocalVariables: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubTransaction,
    beforeBreadcrumb: scrubBreadcrumb,
  });
  return (err) => Sentry.captureException(err);
}
