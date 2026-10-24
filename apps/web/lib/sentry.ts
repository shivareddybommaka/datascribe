import { resolveDeployEnv } from '@datascribe/shared/deploy';
import {
  WEB_SENTRY_KEYS,
  scrubBreadcrumb,
  scrubEvent,
  scrubTransaction,
  sentryConfig,
} from '@datascribe/shared/sentry';

/**
 * The web app's Sentry options (D-119), or null when NEXT_PUBLIC_SENTRY_DSN is unset (then the
 * SDK is never even loaded). NEXT_PUBLIC_ values are inlined at build time, so each one is read
 * by its literal name. Browsers don't see DEPLOY_ENV: staging builds set
 * NEXT_PUBLIC_SENTRY_ENVIRONMENT=staging.
 */
export function webSentryOptions(
  env: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    DEPLOY_ENV: process.env.DEPLOY_ENV,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  },
) {
  const config = sentryConfig(env, resolveDeployEnv(env), WEB_SENTRY_KEYS);
  if (!config) return null;
  return {
    ...config,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubTransaction,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
