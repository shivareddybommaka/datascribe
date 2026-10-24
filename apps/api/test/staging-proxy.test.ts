/**
 * Staging behind the Cloudflare tunnel (D-121): browser → Cloudflare → cloudflared (127.0.0.1)
 * → Next.js :3020 → API :4020. Next's rewrite proxy forwards the request headers unchanged, so the
 * API sees a loopback peer carrying cloudflared's X-Forwarded-For / -Proto and CF-Connecting-IP.
 * Supertest connects from 127.0.0.1, standing in for that local hop.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CSRF, SEED, buildApp, prisma } from './helpers';
import { TEST_PASSWORD } from './constants';

const STAGING_URL = 'https://datascribe.stayspot.app';
const staging = {
  NODE_ENV: 'production',
  DEPLOY_ENV: 'staging',
  APP_URL: STAGING_URL,
  // validated only; the test app talks to the test database through the helpers' client
  DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe_staging',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_SSE: 'none',
  PAYMENT_GATEWAY: 'fake',
};
const tight = { windowMs: 60_000, authPerWindow: 2, publicPerWindow: 2, accountPerWindow: 1_000 };
const nobody = { email: 'nobody@test.example', password: 'x' };

describe('staging behind the tunnel (D-121)', () => {
  it('sets the refresh cookie Secure, HttpOnly, SameSite=Strict', async () => {
    const { app } = buildApp({ envOverrides: staging });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-for', '203.0.113.10')
      .send({ email: SEED.acmeUser, password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('\n');
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    // the session records the client's address, not the proxy's
    const session = await prisma.session.findFirstOrThrow({
      where: { user: { email: SEED.acmeUser } },
      orderBy: { createdAt: 'desc' },
    });
    expect(session.ip).toBe('203.0.113.10');
  });

  it('CSRF: accepts the https staging origin, refuses others and the http variant', async () => {
    const { app } = buildApp({ envOverrides: staging });
    const refresh = (origin: string) =>
      request(app).post('/api/v1/auth/refresh').set(CSRF).set('origin', origin);
    // no cookie: a passed CSRF check answers 401, a failed one 403
    expect((await refresh(STAGING_URL)).status).toBe(401);
    expect((await refresh('http://datascribe.stayspot.app')).status).toBe(403);
    expect((await refresh('https://evil.example')).status).toBe(403);
    expect((await refresh('http://localhost:3010')).status).toBe(403);
  });

  it('CORS allows only the staging origin', async () => {
    const { app } = buildApp({ envOverrides: staging });
    const ok = await request(app).get('/api/v1/health').set('origin', STAGING_URL);
    expect(ok.headers['access-control-allow-origin']).toBe(STAGING_URL);
    const bad = await request(app).get('/api/v1/health').set('origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps the security headers', async () => {
    const { app } = buildApp({ envOverrides: staging });
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // never indexed (D-123); not set outside staging
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    const local = await request(buildApp().app).get('/api/v1/health');
    expect(local.headers['x-robots-tag']).toBeUndefined();
  });

  it('per-IP limits key on the last X-Forwarded-For entry (Cloudflare appends the real IP)', async () => {
    const { app } = buildApp({ envOverrides: staging, rateLimits: tight });
    const send = (xff: string) =>
      request(app).post('/api/v1/auth/login').set('x-forwarded-for', xff).send(nobody);
    // a client-chosen entry on the left doesn't make a new bucket
    expect((await send('198.51.100.1, 203.0.113.20')).status).toBe(401);
    expect((await send('198.51.100.2, 203.0.113.20')).status).toBe(401);
    expect((await send('198.51.100.3, 203.0.113.20')).status).toBe(429);
    // a different real client has its own bucket
    expect((await send('203.0.113.21')).status).toBe(401);
  });

  it('CF-Connecting-IP keys the limits when enabled and the hop is trusted', async () => {
    const { app } = buildApp({
      envOverrides: { ...staging, TRUST_CF_CONNECTING_IP: 'true' },
      rateLimits: tight,
    });
    const send = (ip: string) =>
      request(app)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', '203.0.113.30')
        .set('cf-connecting-ip', ip)
        .send(nobody);
    expect((await send('192.0.2.1')).status).toBe(401);
    expect((await send('192.0.2.1')).status).toBe(401);
    expect((await send('192.0.2.1')).status).toBe(429);
    expect((await send('192.0.2.2')).status).toBe(401);
    // not an IP: ignored, falls back to X-Forwarded-For
    expect((await send('not-an-ip')).status).toBe(401);
  });

  it('ignores CF-Connecting-IP when TRUST_PROXY trusts no hop', async () => {
    const { app } = buildApp({
      envOverrides: { ...staging, TRUST_CF_CONNECTING_IP: 'true', TRUST_PROXY: 'false' },
      rateLimits: tight,
    });
    const send = (ip: string) =>
      request(app).post('/api/v1/auth/login').set('cf-connecting-ip', ip).send(nobody);
    await send('192.0.2.11');
    await send('192.0.2.12');
    expect((await send('192.0.2.13')).status).toBe(429);
  });

  it('ignores CF-Connecting-IP unless enabled', async () => {
    const { app } = buildApp({ envOverrides: staging, rateLimits: tight });
    const send = (ip: string) =>
      request(app)
        .post('/api/v1/auth/login')
        .set('x-forwarded-for', '203.0.113.40')
        .set('cf-connecting-ip', ip)
        .send(nobody);
    await send('192.0.2.21');
    await send('192.0.2.22');
    expect((await send('192.0.2.23')).status).toBe(429);
  });

  it('mounts the simulated checkout in staging only, never in production', async () => {
    const path = '/api/v1/payments/fake-checkout/fcs_nope_x';
    // mounted: the route itself answers "Not found" for an unknown session
    const mounted = await request(buildApp({ envOverrides: staging }).app).get(path);
    expect(mounted.status).toBe(404);
    expect(mounted.body.error.message).toBe('Not found');
    const production = {
      ...staging,
      DEPLOY_ENV: 'production',
      S3_SSE: 'AES256',
      CLAMAV_HOST: 'localhost',
      PAYMENT_GATEWAY: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
    };
    // not mounted: the catch-all answers
    const absent = await request(buildApp({ envOverrides: production }).app).get(path);
    expect(absent.status).toBe(404);
    expect(absent.body.error.message).toBe('Route not found');
    expect(() =>
      buildApp({
        envOverrides: { ...staging, DEPLOY_ENV: 'production', TRUST_CF_CONNECTING_IP: 'true' },
      }),
    ).toThrow(/TRUST_CF_CONNECTING_IP/);
  });
});
