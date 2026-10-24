import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { APP_URL, buildApp } from '../test/helpers';
import { redactPath } from './app';
import { loadEnv, staffEmailDomains } from './config/env';

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

describe('log redaction', () => {
  it('drops query strings and invite tokens from logged paths', () => {
    expect(redactPath('/api/v1/cases?q=Jane')).toBe('/api/v1/cases');
    expect(redactPath('/api/v1/invites/abc123SECRET/accept')).toBe(
      '/api/v1/invites/[token]/accept',
    );
  });
});

describe('env validation', () => {
  it('refuses a real LLM provider in production without a BAA (§8.3)', () => {
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_test_x',
      CLAMAV_HOST: 'clamav',
    };
    expect(() => loadEnv({ ...prod, SUMMARY_PROVIDER: 'anthropic' })).toThrow(
      /PHI_LLM_BAA_CONFIRMED/,
    );
    expect(() =>
      loadEnv({ ...prod, SUMMARY_PROVIDER: 'anthropic', PHI_LLM_BAA_CONFIRMED: 'true' }),
    ).not.toThrow();
    expect(() => loadEnv({ ...prod, SUMMARY_PROVIDER: 'mock' })).not.toThrow();
  });

  it('allows Stripe test keys only, and no fake gateway in production (§5.6)', () => {
    expect(() => loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(loadEnv({ ...baseEnv, STRIPE_SECRET_KEY: '' }).STRIPE_SECRET_KEY).toBeUndefined();
    const prod = { ...baseEnv, NODE_ENV: 'production', CLAMAV_HOST: 'clamav' };
    expect(() => loadEnv(prod)).toThrow(/PAYMENT_GATEWAY/);
    expect(() => loadEnv({ ...prod, PAYMENT_GATEWAY: 'fake' })).toThrow(/PAYMENT_GATEWAY/);
    expect(() => loadEnv({ ...prod, STRIPE_SECRET_KEY: 'sk_test_abc' })).not.toThrow();
  });

  it('requires encrypted buckets and a real virus scanner in production (§10)', () => {
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_test_abc',
      CLAMAV_HOST: 'clamav',
    };
    expect(() => loadEnv(prod)).not.toThrow();
    expect(loadEnv(prod).S3_SSE).toBe('AES256');
    expect(() => loadEnv({ ...prod, S3_SSE: 'none' })).toThrow(/S3_SSE/);
    expect(() => loadEnv({ ...prod, CLAMAV_HOST: '' })).toThrow(/CLAMAV_HOST/);
    expect(loadEnv({ ...baseEnv, S3_SSE: 'none' }).S3_SSE).toBe('none');
  });

  it("staff email domains default to MAIL_FROM's domain (audit L10)", () => {
    expect(staffEmailDomains(loadEnv(baseEnv))).toEqual(['datascribe.example']);
    expect(
      staffEmailDomains(loadEnv({ ...baseEnv, MAIL_FROM: 'Datascribe <hello@ds.example>' })),
    ).toEqual(['ds.example']);
    expect(
      staffEmailDomains(loadEnv({ ...baseEnv, STAFF_EMAIL_DOMAINS: 'A.example, b.example' })),
    ).toEqual(['a.example', 'b.example']);
  });

  describe('deploy profile (D-120)', () => {
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_test_abc',
      CLAMAV_HOST: 'clamav',
    };
    const staging = {
      ...baseEnv,
      NODE_ENV: 'production',
      DEPLOY_ENV: 'staging',
      APP_URL: 'https://datascribe.stayspot.app',
      DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe_staging',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_SSE: 'none',
      PAYMENT_GATEWAY: 'fake',
    };

    it('resolves the profile from NODE_ENV unless set', () => {
      expect(loadEnv(baseEnv).DEPLOY_ENV).toBe('local');
      expect(loadEnv(prod).DEPLOY_ENV).toBe('production');
      expect(loadEnv(staging).DEPLOY_ENV).toBe('staging');
      expect(() => loadEnv({ ...prod, DEPLOY_ENV: 'local' })).toThrow(/DEPLOY_ENV/);
      expect(() => loadEnv({ ...baseEnv, DEPLOY_ENV: 'staging' })).toThrow(/DEPLOY_ENV/);
    });

    it('keeps every production refusal, with or without DEPLOY_ENV=production', () => {
      for (const p of [prod, { ...prod, DEPLOY_ENV: 'production' }]) {
        expect(() => loadEnv(p)).not.toThrow();
        expect(() => loadEnv({ ...p, S3_SSE: 'none' })).toThrow(/S3_SSE/);
        expect(() => loadEnv({ ...p, CLAMAV_HOST: '' })).toThrow(/CLAMAV_HOST/);
        expect(() => loadEnv({ ...p, PAYMENT_GATEWAY: 'fake' })).toThrow(/PAYMENT_GATEWAY/);
        expect(() => loadEnv({ ...p, STRIPE_SECRET_KEY: '' })).toThrow(/PAYMENT_GATEWAY/);
        expect(() => loadEnv({ ...p, STRIPE_SECRET_KEY: 'sk_live_x' })).toThrow(
          /STRIPE_SECRET_KEY/,
        );
        expect(() => loadEnv({ ...p, EXTRA_TRUSTED_ORIGINS: 'http://localhost:9' })).toThrow(
          /EXTRA_TRUSTED_ORIGINS/,
        );
        expect(() => loadEnv({ ...p, SUMMARY_PROVIDER: 'anthropic' })).toThrow(
          /PHI_LLM_BAA_CONFIRMED/,
        );
        expect(() =>
          loadEnv({ ...p, SUMMARY_PROVIDER: 'anthropic', PHI_LLM_BAA_CONFIRMED: 'true' }),
        ).not.toThrow();
        expect(() => loadEnv({ ...p, STAGING_ALLOW_HTTP_FOR_SMOKE: '1' })).toThrow(
          /STAGING_ALLOW_HTTP_FOR_SMOKE/,
        );
        // the staging-only rules don't apply to production
        expect(() => loadEnv({ ...p, SMTP_HOST: 'email-smtp.example.com' })).not.toThrow();
      }
    });

    it('lets staging use local SeaweedFS without SSE, the fake gateway and the mock scanner', () => {
      const env = loadEnv(staging);
      expect(env.S3_SSE).toBe('none');
      expect(env.PAYMENT_GATEWAY).toBe('fake');
      expect(env.CLAMAV_HOST).toBeUndefined();
      expect(loadEnv({ ...staging, PAYMENT_GATEWAY: 'stripe' }).STRIPE_SECRET_KEY).toBeUndefined();
      expect(loadEnv({ ...staging, CLAMAV_HOST: 'localhost' }).CLAMAV_HOST).toBe('localhost');
    });

    it('refuses real third parties and real databases in staging', () => {
      const refuses = (over: Record<string, string>, path: RegExp) =>
        expect(() => loadEnv({ ...staging, ...over })).toThrow(path);
      refuses({ SUMMARY_PROVIDER: 'anthropic', PHI_LLM_BAA_CONFIRMED: 'true' }, /SUMMARY_PROVIDER/);
      refuses({ SUMMARY_PROVIDER: 'openai' }, /SUMMARY_PROVIDER/);
      refuses({ STRIPE_SECRET_KEY: 'sk_live_x' }, /STRIPE_SECRET_KEY/);
      refuses({ SMTP_HOST: 'smtp.gmail.com' }, /SMTP_HOST/);
      refuses(
        { DATABASE_URL: 'postgresql://u:p@localhost:5432/datascribe_staging' },
        /DATABASE_URL/,
      );
      refuses({ DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe' }, /DATABASE_URL/);
      refuses({ APP_URL: 'http://datascribe.stayspot.app' }, /APP_URL/);
      refuses({ S3_ENDPOINT: '' }, /S3_SSE/);
      refuses({ EXTRA_TRUSTED_ORIGINS: 'http://localhost:3010' }, /EXTRA_TRUSTED_ORIGINS/);
    });

    it('allows http only for the smoke test on localhost', () => {
      const smoke = { ...staging, APP_URL: 'http://localhost:3901' };
      expect(() => loadEnv(smoke)).toThrow(/APP_URL/);
      expect(loadEnv({ ...smoke, STAGING_ALLOW_HTTP_FOR_SMOKE: '1' }).APP_URL).toBe(
        'http://localhost:3901',
      );
      expect(() =>
        loadEnv({
          ...staging,
          APP_URL: 'http://datascribe.stayspot.app',
          STAGING_ALLOW_HTTP_FOR_SMOKE: '1',
        }),
      ).toThrow(/APP_URL/);
    });
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
