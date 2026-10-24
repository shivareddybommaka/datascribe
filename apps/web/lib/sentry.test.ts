import { describe, expect, it } from 'vitest';
import { webSentryOptions } from './sentry';

describe('web Sentry options (D-119)', () => {
  it('is off without NEXT_PUBLIC_SENTRY_DSN', () => {
    expect(webSentryOptions({ NODE_ENV: 'production' })).toBeNull();
    expect(
      webSentryOptions({ NODE_ENV: 'production', SENTRY_DSN: 'https://k@o.test/1' }),
    ).toBeNull();
  });

  it('sends no PII, traces nothing by default and scrubs every event', () => {
    const options = webSentryOptions({
      NODE_ENV: 'production',
      NEXT_PUBLIC_SENTRY_DSN: 'https://k@o.test/1',
    });
    expect(options).toMatchObject({
      sendDefaultPii: false,
      tracesSampleRate: 0,
      environment: 'production',
    });
    const event = options!.beforeSend({
      request: { url: '/portal/cases?patient=Zelda', cookies: { ds_refresh: 'x' } },
    });
    expect(event).toEqual({ request: { url: '/portal/cases' } });
  });
});
