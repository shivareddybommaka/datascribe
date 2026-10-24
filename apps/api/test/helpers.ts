import { FakeGateway, MemoryObjectStore } from '@datascribe/billing';
import { PrismaClient } from '@datascribe/db';
import { internalSeedEmail } from '@datascribe/db/seed';
import type { RoleKey } from '@datascribe/shared';
import { authenticator } from 'otplib';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import type { Deps, RateLimits } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { MockVirusScanner, type VirusScanner } from '@datascribe/scan';
import { relayKey } from '../src/lib/relay-token';
import { S3DocumentStorage } from '../src/lib/storage';
import {
  TEST_DATABASE_URL,
  TEST_PASSWORD,
  TEST_S3,
  TEST_TOTP_SECRET,
  testPhiKey,
} from './constants';

export const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });

export const APP_URL = 'http://localhost:3010';

export function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    APP_URL,
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_ACCESS_SECRET: 'test-access-secret-'.padEnd(48, 'a'),
    JWT_REFRESH_SECRET: 'test-refresh-secret-'.padEnd(48, 'b'),
    PHI_ENCRYPTION_KEY: testPhiKey.toString('base64'),
    LOG_LEVEL: 'silent',
    // the L9 timing floor has its own test (auth.test.ts); elsewhere it only slows the suite
    AUTH_RESPONSE_FLOOR_MS: '0',
    ...TEST_S3,
    ...overrides,
  });
}

/** Test buckets are created once per run (global-setup creates nothing in S3). */
let bucketsReady: Promise<void> | null = null;
export const testStorage = () => {
  const storage = new S3DocumentStorage(testEnv(), [APP_URL]);
  bucketsReady ??= storage.ensureBuckets();
  return { storage, ready: bucketsReady };
};

const GENEROUS: RateLimits = {
  windowMs: 60_000,
  authPerWindow: 10_000,
  publicPerWindow: 10_000,
  accountPerWindow: 10_000,
};

export function buildApp(
  opts: {
    rateLimits?: RateLimits;
    medical?: Deps['medical'];
    envOverrides?: Record<string, string>;
    scanner?: VirusScanner;
    rateLimitStore?: Deps['rateLimitStore'];
    reportError?: Deps['reportError'];
  } = {},
) {
  const mailer = new MemoryMailer();
  const env = testEnv(opts.envOverrides);
  const shared = testStorage();
  // staging's relay (D-122): same buckets, same-origin relay URLs instead of presigned ones
  const storage =
    env.S3_BROWSER_ACCESS === 'relay'
      ? new S3DocumentStorage(env, [APP_URL], { key: relayKey(env.JWT_ACCESS_SECRET) })
      : shared.storage;
  const ready = shared.ready;
  const gateway = new FakeGateway({
    secret: 'test-fake-gateway-secret',
    checkoutBaseUrl: `${APP_URL}/api/v1/payments/fake-checkout`,
  });
  const store = new MemoryObjectStore();
  const app = createApp({
    env,
    prisma,
    mailer,
    logger: createLogger('silent'),
    phiKey: testPhiKey,
    rateLimits: opts.rateLimits ?? GENEROUS,
    // unset: in-memory counters per app; rate-limit-redis.test.ts covers the Redis store
    rateLimitStore: opts.rateLimitStore,
    gateway,
    store,
    medical: opts.medical,
    storage,
    inlineScan: opts.scanner ?? new MockVirusScanner(),
    reportError: opts.reportError,
  });
  return { app, mailer, gateway, store, storage, storageReady: ready };
}

export const CSRF = { 'x-datascribe-csrf': '1' };

export const SEED = {
  acmeAdmin: 'client.admin@acme.example',
  acmeUser: 'client.user@acme.example',
  harborAdmin: 'client.admin@harbor.example',
  internal: (role: RoleKey) => internalSeedEmail(role),
};

export const totpNow = () => authenticator.generate(TEST_TOTP_SECRET);

/**
 * Sign in through the real endpoints (password, then TOTP for internal users).
 * Returns the access token and a supertest agent holding the refresh cookie.
 */
export async function login(
  app: ReturnType<typeof buildApp>['app'],
  email: string,
  password = TEST_PASSWORD,
) {
  const agent = request.agent(app);
  const first = await agent.post('/api/v1/auth/login').send({ email, password });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  if (first.body.accessToken) return { token: first.body.accessToken as string, agent };
  expect(first.body.mfaRequired).toBe(true);
  const second = await agent
    .post('/api/v1/auth/mfa/verify')
    .send({ mfaToken: first.body.mfaToken, code: totpNow() });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  return { token: second.body.accessToken as string, agent };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function orgId(key: 'acme' | 'harbor' | 'internal') {
  const names = {
    acme: 'Acme Injury Law (synthetic)',
    harbor: 'Harbor Legal Group (synthetic)',
    internal: 'Datascribe',
  };
  return (await prisma.organization.findFirstOrThrow({ where: { name: names[key] } })).id;
}

export async function caseIdByNumber(number: string) {
  return (await prisma.case.findUniqueOrThrow({ where: { number } })).id;
}

let counter = 0;
/** Unique synthetic email per test run. */
export const uniqueEmail = (prefix: string) =>
  `${prefix}.${Date.now().toString(36)}${(counter++).toString(36)}@test.example`;
