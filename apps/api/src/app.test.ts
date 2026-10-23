import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { APP_URL, buildApp } from '../test/helpers';
import { loadEnv } from './config/env';

const { app } = buildApp();

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/x_test',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PHI_ENCRYPTION_KEY: 'k',
};

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
    const ok = await request(app).get('/api/v1/health').set('Origin', APP_URL);
    expect(ok.headers['access-control-allow-origin']).toBe(APP_URL);
    const bad = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('env validation', () => {
  it('refuses a real LLM provider in production without a BAA (§8.3)', () => {
    const prod = { ...baseEnv, NODE_ENV: 'production' };
    expect(() => loadEnv({ ...prod, SUMMARY_PROVIDER: 'anthropic' })).toThrow(/PHI_LLM_BAA_CONFIRMED/);
    expect(() =>
      loadEnv({ ...prod, SUMMARY_PROVIDER: 'anthropic', PHI_LLM_BAA_CONFIRMED: 'true' }),
    ).not.toThrow();
    expect(() => loadEnv({ ...prod, SUMMARY_PROVIDER: 'mock' })).not.toThrow();
  });

  it('requires strong JWT secrets and names the variable, never the value', () => {
    expect(() => loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'short-secret' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    try {
      loadEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'short-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('short-secret');
    }
  });
});
