import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  WEB_SENTRY_KEYS,
  isSensitiveKey,
  redactText,
  scrubBreadcrumb,
  scrubEvent,
  scrubTransaction,
  scrubUrl,
  sentryConfig,
  sentryEnvIssues,
} from './sentry';

// Synthetic values only. Each must be absent from the scrubbed JSON.
const PATIENT = 'Zelda Quixote-Synthetic';
const DOB = '1961-02-03';
const NOTE = 'Synthetic note: fell from ladder, fractured left radius';
const PAGE_TEXT = 'SYNTHETIC RECORD page 4: MRI lumbar spine, L4-L5 disc bulge';
const EMAIL = 'jane.synthetic@example.test';
const COOKIE = 'ds_refresh=refresh-cookie-value-123; ds_csrf=csrf-cookie-value';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXNpZ24';
const INVITE_TOKEN = 'inv_8f3k2l1m0n9b8v7c6x5z4a3s2d1f0g9h';
const CIPHERTEXT = 'v1:aGVsbG8tc3ludGhldGljLWl2:Y2lwaGVydGV4dC1zeW50aGV0aWMtYmxvYg==';
const SECRETS = [PATIENT, DOB, NOTE, PAGE_TEXT, EMAIL, 'refresh-cookie-value', 'csrf-cookie-value'];
const SECRETS_ALL = [...SECRETS, 'eyJhbGciOiJIUzI1NiJ9', INVITE_TOKEN, CIPHERTEXT, 'ladder'];

const expectClean = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const s of SECRETS_ALL) expect(json).not.toContain(s);
};

function syntheticEvent() {
  return {
    event_id: 'abc123',
    level: 'error',
    platform: 'node',
    transaction: `POST /api/v1/invites/${INVITE_TOKEN}/accept`,
    request: {
      method: 'POST',
      url: `https://app.example.test/api/v1/cases?patient=${encodeURIComponent(PATIENT)}&token=${INVITE_TOKEN}`,
      query_string: `patient=${PATIENT}&dob=${DOB}`,
      cookies: { ds_refresh: 'refresh-cookie-value-123', ds_csrf: 'csrf-cookie-value' },
      headers: {
        Authorization: BEARER,
        Cookie: COOKIE,
        'X-CSRF-Token': 'csrf-cookie-value',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.9',
        'User-Agent': 'synthetic-agent',
        'x-request-id': 'req-1',
      },
      data: { patientName: PATIENT, dateOfBirth: DOB, notes: NOTE },
      env: { REMOTE_ADDR: '203.0.113.9' },
    },
    user: { id: 'user-1', email: EMAIL, ip_address: '203.0.113.9', username: PATIENT },
    exception: {
      values: [
        {
          type: 'Error',
          value: `could not process case for ${EMAIL} born ${DOB}, see https://x.test/p?name=${encodeURIComponent(PATIENT)}`,
          mechanism: { type: 'express', handled: false, data: { body: NOTE } },
          stacktrace: {
            frames: [
              {
                filename: 'app:///dist/server.js',
                function: 'handler',
                lineno: 10,
                vars: { patientName: PATIENT, text: PAGE_TEXT },
              },
            ],
          },
        },
        {
          type: 'PrismaClientKnownRequestError',
          value: `Unique constraint failed on value "${PATIENT}"`,
        },
      ],
    },
    extra: {
      caseId: 'case-1',
      patientName: PATIENT,
      dob: DOB,
      case: { notes: NOTE, encryptedNotes: CIPHERTEXT, status: 'in_review' },
      page: { text: PAGE_TEXT, pageNumber: 4 },
      free: `contact ${EMAIL}`,
    },
    contexts: { runtime: { version: 'v22' }, auth: { authorization: BEARER } },
    tags: { route: '/api/v1/cases/:id', patient: PATIENT },
    breadcrumbs: [
      { category: 'console', message: `logged ${PATIENT}` },
      { category: 'ui.click', message: `button[aria-label="Open ${PATIENT}"]` },
      {
        category: 'fetch',
        data: { method: 'GET', status_code: 200, url: `/api/v1/cases?q=${PATIENT}` },
      },
      { category: 'navigation', data: { from: '/portal', to: `/invite/${INVITE_TOKEN}` } },
      { category: 'custom', message: `uploaded for ${EMAIL}`, data: { fileName: 'zelda.pdf' } },
    ],
  };
}

describe('scrubEvent', () => {
  it('removes PHI, cookies, auth headers, bodies, query strings and tokens', () => {
    const out = scrubEvent(syntheticEvent());
    expectClean(out);
    expect(JSON.stringify(out)).not.toContain('203.0.113.9');
  });

  it('keeps the request method, scrubbed URL and harmless headers only', () => {
    const { request } = scrubEvent(syntheticEvent());
    expect(request).toEqual({
      method: 'POST',
      url: 'https://app.example.test/api/v1/cases',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-1' },
    });
  });

  it('keeps only the user id', () => {
    expect(scrubEvent(syntheticEvent()).user).toEqual({ id: 'user-1' });
  });

  it('keeps the error type and stack, drops local variables and quoted values', () => {
    const [first, prisma] = scrubEvent(syntheticEvent()).exception.values;
    expect(first?.type).toBe('Error');
    expect(first?.value).toBe(
      'could not process case for [email] born [date], see https://x.test/p',
    );
    expect(first?.stacktrace?.frames[0]).toEqual({
      filename: 'app:///dist/server.js',
      function: 'handler',
      lineno: 10,
    });
    expect(first?.mechanism).toEqual({ type: 'express', handled: false });
    expect(prisma?.value).toBe(REDACTED);
  });

  it('keeps ids and statuses in extra, drops PHI fields', () => {
    const { extra } = scrubEvent(syntheticEvent());
    expect(extra).toMatchObject({
      caseId: 'case-1',
      patientName: REDACTED,
      dob: REDACTED,
      case: { notes: REDACTED, encryptedNotes: REDACTED, status: 'in_review' },
      page: { text: REDACTED, pageNumber: 4 },
      free: 'contact [email]',
    });
  });

  it('scrubs the transaction name and breadcrumbs', () => {
    const out = scrubEvent(syntheticEvent());
    expect(out.transaction).toBe(`POST /api/v1/invites/${REDACTED}/accept`);
    expect(out.breadcrumbs).toEqual([
      { category: 'ui.click' },
      { category: 'fetch', data: { method: 'GET', status_code: 200, url: '/api/v1/cases' } },
      { category: 'navigation', data: { from: '/portal', to: `/invite/${REDACTED}` } },
      { category: 'custom', message: 'uploaded for [email]', data: { fileName: REDACTED } },
    ]);
  });

  it('does not modify the original event', () => {
    const event = syntheticEvent();
    scrubEvent(event);
    expect(event.request.data.patientName).toBe(PATIENT);
  });

  it('redacts log messages and drops their params', () => {
    const out = scrubEvent({
      message: `failed for ${EMAIL}`,
      logentry: { message: `failed on ${DOB} for %s`, params: [PATIENT] },
    });
    expect(out.message).toBe('failed for [email]');
    expect(out.logentry).toEqual({ message: 'failed on [date] for %s' });
  });

  it('redacts double-quoted values in error messages', () => {
    const out = scrubEvent({
      exception: { values: [{ type: 'SyntaxError', value: `"${PATIENT}" is not valid JSON` }] },
    });
    expect(out.exception.values[0]?.value).toBe(`"${REDACTED}" is not valid JSON`);
  });
});

describe('scrubTransaction', () => {
  it('drops SQL and Redis commands and scrubs span URLs and data', () => {
    const out = scrubTransaction({
      transaction: 'GET /api/v1/cases/:id',
      spans: [
        { op: 'db', description: `SELECT * FROM "Case" WHERE "patientName" = '${PATIENT}'` },
        { op: 'cache.get', description: `GET ds:rl:account:${EMAIL}` },
        {
          op: 'http.client',
          description: `GET https://s3.test/ds-documents/key?X-Amz-Signature=${INVITE_TOKEN}`,
          data: { 'url.full': `https://s3.test/a?sig=${INVITE_TOKEN}`, 'db.statement': NOTE },
        },
      ],
    });
    expectClean(out);
    expect(out.spans[0]?.description).toBe('db');
    expect(out.spans[2]?.description).toBe('GET https://s3.test/ds-documents/key');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: PATIENT })).toBeNull();
  });

  it('keeps an xhr breadcrumb without its query or body', () => {
    const out = scrubBreadcrumb({
      category: 'xhr',
      type: 'http',
      data: { method: 'POST', url: `/api/v1/auth/login?email=${EMAIL}`, body: NOTE },
    });
    expect(out).toEqual({
      category: 'xhr',
      type: 'http',
      data: { method: 'POST', url: '/api/v1/auth/login' },
    });
  });
});

describe('scrubUrl', () => {
  it.each([
    ['https://a.test/x?token=abc#frag', 'https://a.test/x'],
    ['https://user:pw@a.test/x', 'https://a.test/x'],
    [`/reset-password/${INVITE_TOKEN}`, `/reset-password/${REDACTED}`],
    ['/invites/short/accept', `/invites/${REDACTED}/accept`],
    [`/api/v1/storage-relay/${INVITE_TOKEN}`, `/api/v1/storage-relay/${REDACTED}`],
    ['/portal/cases/ckabc', '/portal/cases/ckabc'],
  ])('%s → %s', (input, expected) => {
    expect(scrubUrl(input)).toBe(expected);
  });
});

describe('redactText', () => {
  it('redacts emails, dates, long numbers, bearer tokens and JWTs', () => {
    expect(redactText(`${EMAIL} ${DOB} 03/02/1961 +61 412 345 678 ${BEARER}`)).toBe(
      '[email] [date] [date] [number] Bearer [token]',
    );
  });

  it('keeps ordinary error text and versions', () => {
    const msg = "Cannot read properties of undefined (reading 'id') in v10.76.2";
    expect(redactText(msg)).toBe(msg);
  });

  it('caps long text', () => {
    expect(redactText('a '.repeat(400)).length).toBeLessThanOrEqual(301);
  });
});

describe('isSensitiveKey', () => {
  it.each(['patientName', 'dateOfBirth', 'dob', 'notes', 'text', 'Authorization', 'set-cookie'])(
    '%s is sensitive',
    (key) => expect(isSensitiveKey(key)).toBe(true),
  );
  it.each(['caseId', 'status', 'pageNumber', 'stage', 'version'])('%s is not', (key) =>
    expect(isSensitiveKey(key)).toBe(false),
  );
});

describe('sentryConfig', () => {
  it('is off without a DSN', () => {
    expect(sentryConfig({}, 'local')).toBeNull();
    expect(sentryConfig({ SENTRY_DSN: '  ' }, 'local')).toBeNull();
  });

  it('defaults to no tracing, no PII and the deploy profile as environment', () => {
    expect(sentryConfig({ SENTRY_DSN: 'https://k@o1.ingest.test/1' }, 'staging')).toEqual({
      dsn: 'https://k@o1.ingest.test/1',
      environment: 'staging',
      tracesSampleRate: 0,
      sendDefaultPii: false,
      maxBreadcrumbs: 50,
    });
  });

  it('reads the web keys and a sample rate', () => {
    const config = sentryConfig(
      {
        NEXT_PUBLIC_SENTRY_DSN: 'https://k@o1.ingest.test/1',
        NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: '0.25',
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'prod-au',
        NEXT_PUBLIC_SENTRY_RELEASE: 'abc123',
      },
      'production',
      WEB_SENTRY_KEYS,
    );
    expect(config).toMatchObject({
      tracesSampleRate: 0.25,
      environment: 'prod-au',
      release: 'abc123',
    });
  });

  it('reports a bad DSN or sample rate by name only', () => {
    expect(
      sentryEnvIssues({ SENTRY_DSN: 'not-a-url', SENTRY_TRACES_SAMPLE_RATE: '2' }).map(
        (i) => i.path,
      ),
    ).toEqual(['SENTRY_DSN', 'SENTRY_TRACES_SAMPLE_RATE']);
    expect(sentryEnvIssues({})).toEqual([]);
    expect(
      sentryEnvIssues({ SENTRY_DSN: 'https://k@o1.ingest.test/1', SENTRY_TRACES_SAMPLE_RATE: '0' }),
    ).toEqual([]);
  });
});
