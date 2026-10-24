import { webSentryOptions } from './lib/sentry';

// Browser error reporting (D-119): the SDK is a lazy chunk, only fetched when
// NEXT_PUBLIC_SENTRY_DSN was set at build time. No session replay; events are scrubbed of PHI.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const options = webSentryOptions();
  if (options) {
    void import('@sentry/nextjs').then((Sentry) =>
      Sentry.init({ ...options, initialScope: { tags: { service: 'web-browser' } } }),
    );
  }
}
