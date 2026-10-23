import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';

const env = loadEnv({ NODE_ENV: 'test' });
const app = createApp(env, createLogger('silent'));

describe('api skeleton', () => {
  it('GET /api/v1/health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('propagates an incoming request id', async () => {
    const res = await request(app).get('/api/v1/health').set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('only allows the app origin for CORS', async () => {
    const ok = await request(app).get('/api/v1/health').set('Origin', env.APP_URL);
    expect(ok.headers['access-control-allow-origin']).toBe(env.APP_URL);
    const bad = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('env validation', () => {
  it('refuses a real LLM provider in production without a BAA (§8.3)', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', SUMMARY_PROVIDER: 'anthropic' })).toThrow(
      /PHI_LLM_BAA_CONFIRMED/,
    );
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        SUMMARY_PROVIDER: 'anthropic',
        PHI_LLM_BAA_CONFIRMED: 'true',
      }),
    ).not.toThrow();
    expect(() => loadEnv({ NODE_ENV: 'production', SUMMARY_PROVIDER: 'mock' })).not.toThrow();
  });
});
