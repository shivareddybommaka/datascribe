import type { Instrumentation } from 'next';
import { webSentryOptions } from './lib/sentry';

/**
 * Server-side error reporting (D-119): off unless NEXT_PUBLIC_SENTRY_DSN is set, and then the
 * SDK is only loaded in the Node.js runtime. Events are scrubbed of PHI before sending.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const options = webSentryOptions();
  if (!options) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.init({ ...options, initialScope: { tags: { service: 'web' } } });
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !webSentryOptions()) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
};
