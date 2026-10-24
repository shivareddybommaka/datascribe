import { describe, expect, it } from 'vitest';
import { deployProfileIssues, resolveDeployEnv, stagingViolations } from './deploy';

const staging = {
  NODE_ENV: 'production',
  DEPLOY_ENV: 'staging',
  APP_URL: 'https://datascribe.stayspot.app',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe_staging',
  SMTP_HOST: 'localhost',
  SUMMARY_PROVIDER: 'mock',
  S3_SSE: 'none',
  S3_ENDPOINT: 'http://localhost:9000',
  CLAMAV_HOST: 'localhost',
};
const prod = { NODE_ENV: 'production', S3_SSE: 'aws:kms' };
const paths = (env: Record<string, string | undefined>) =>
  deployProfileIssues(env).map((i) => i.path);

describe('staging on the open internet (D-125)', () => {
  it('needs ClamAV unless the mock scanner is explicitly allowed', () => {
    expect(paths({ ...staging, CLAMAV_HOST: '' })).toEqual(['CLAMAV_HOST']);
    expect(paths({ ...staging, CLAMAV_HOST: undefined })).toEqual(['CLAMAV_HOST']);
    expect(paths({ ...staging, CLAMAV_HOST: '', STAGING_ALLOW_MOCK_SCAN: '1' })).toEqual([
      'CLAMAV_HOST',
    ]);
    expect(paths({ ...staging, CLAMAV_HOST: '', STAGING_ALLOW_MOCK_SCAN: 'true' })).toEqual([]);
  });

  it('keeps the auth limits and response floor at least as strict as production', () => {
    const at = {
      RATE_LIMIT_AUTH: '30',
      RATE_LIMIT_PUBLIC: '10',
      RATE_LIMIT_ACCOUNT: '10',
      AUTH_RESPONSE_FLOOR_MS: '400',
    };
    expect(paths({ ...staging, ...at })).toEqual([]);
    expect(paths({ ...staging, RATE_LIMIT_AUTH: '5', AUTH_RESPONSE_FLOOR_MS: '800' })).toEqual([]);
    expect(paths({ ...staging, RATE_LIMIT_AUTH: '31' })).toEqual(['RATE_LIMIT_AUTH']);
    expect(paths({ ...staging, RATE_LIMIT_PUBLIC: '100' })).toEqual(['RATE_LIMIT_PUBLIC']);
    expect(paths({ ...staging, RATE_LIMIT_ACCOUNT: '11' })).toEqual(['RATE_LIMIT_ACCOUNT']);
    expect(paths({ ...staging, AUTH_RESPONSE_FLOOR_MS: '0' })).toEqual(['AUTH_RESPONSE_FLOOR_MS']);
  });

  it('production refuses every staging-only switch', () => {
    for (const key of [
      'STAGING_ALLOW_HTTP_FOR_SMOKE',
      'STAGING_ALLOW_SIGNUP',
      'STAGING_ALLOW_MOCK_SCAN',
    ]) {
      expect(paths({ ...prod, [key]: 'true' })).toEqual([key]);
    }
  });
});

describe('production storage encryption (D-117)', () => {
  it('refuses to start unless S3_SSE=aws:kms', () => {
    expect(paths(prod)).toEqual([]);
    expect(paths({ ...prod, S3_SSE: ' aws:kms ', S3_SSE_KMS_KEY_ID: 'arn:aws:kms:x' })).toEqual([]);
    expect(paths({ ...prod, DEPLOY_ENV: 'production' })).toEqual([]);
    for (const sse of [undefined, '', 'AES256', 'none', 'aws:kms:dsse']) {
      expect(paths({ ...prod, S3_SSE: sse }), String(sse)).toEqual(['S3_SSE']);
    }
  });

  it('leaves staging and local development alone', () => {
    expect(paths(staging)).toEqual([]);
    expect(paths({ ...staging, S3_SSE: 'AES256', S3_ENDPOINT: '' })).toEqual([]);
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(paths({ NODE_ENV, S3_SSE: 'none' })).toEqual([]);
      expect(paths({ NODE_ENV, S3_SSE: 'AES256' })).toEqual([]);
    }
  });
});

describe('deploy profile (D-120)', () => {
  it('defaults to production for production builds and local otherwise', () => {
    expect(resolveDeployEnv({ NODE_ENV: 'production' })).toBe('production');
    expect(resolveDeployEnv({ NODE_ENV: 'development' })).toBe('local');
    expect(resolveDeployEnv({ NODE_ENV: 'test' })).toBe('local');
    expect(resolveDeployEnv({})).toBe('local');
    expect(resolveDeployEnv({ NODE_ENV: 'production', DEPLOY_ENV: 'staging' })).toBe('staging');
  });

  it('never lets a production build run as local, and staging needs a production build', () => {
    expect(paths({ NODE_ENV: 'production', DEPLOY_ENV: 'local' })).toEqual(['DEPLOY_ENV']);
    expect(paths({ NODE_ENV: 'development', DEPLOY_ENV: 'staging' })).toEqual(['DEPLOY_ENV']);
    expect(paths({ NODE_ENV: 'test', DEPLOY_ENV: 'production' })).toEqual(['DEPLOY_ENV']);
    expect(paths({ NODE_ENV: 'production', DEPLOY_ENV: 'qa' })).toEqual(['DEPLOY_ENV']);
    expect(paths({ NODE_ENV: 'development', DEPLOY_ENV: 'local' })).toEqual([]);
    expect(paths({ ...prod, DEPLOY_ENV: 'production' })).toEqual([]);
  });

  it('accepts the documented staging setup', () => {
    expect(deployProfileIssues(staging)).toEqual([]);
    expect(deployProfileIssues({ ...staging, SMTP_HOST: '127.0.0.1' })).toEqual([]);
    expect(deployProfileIssues({ ...staging, S3_SSE: 'AES256', S3_ENDPOINT: '' })).toEqual([]);
  });

  it('refuses a real LLM and AWS Textract in staging', () => {
    expect(paths({ ...staging, SUMMARY_PROVIDER: 'anthropic' })).toEqual(['SUMMARY_PROVIDER']);
    expect(paths({ ...staging, SUMMARY_PROVIDER: 'openai' })).toEqual(['SUMMARY_PROVIDER']);
    expect(paths({ ...staging, OCR_PROVIDER: 'textract' })).toEqual(['OCR_PROVIDER']);
    expect(paths({ ...staging, OCR_PROVIDER: 'tesseract' })).toEqual([]);
  });

  it('refuses live Stripe keys in staging', () => {
    expect(paths({ ...staging, STRIPE_SECRET_KEY: 'sk_live_x' })).toEqual(['STRIPE_SECRET_KEY']);
    expect(paths({ ...staging, STRIPE_SECRET_KEY: 'rk_live_x' })).toEqual(['STRIPE_SECRET_KEY']);
    expect(paths({ ...staging, STRIPE_PUBLISHABLE_KEY: 'pk_live_x' })).toEqual([
      'STRIPE_PUBLISHABLE_KEY',
    ]);
    expect(paths({ ...staging, STRIPE_SECRET_KEY: 'sk_test_x' })).toEqual([]);
  });

  it('refuses any SMTP host but Mailpit on localhost in staging', () => {
    expect(paths({ ...staging, SMTP_HOST: 'smtp.example.com' })).toEqual(['SMTP_HOST']);
    expect(paths({ ...staging, SMTP_HOST: 'email-smtp.ap-south-1.amazonaws.com' })).toEqual([
      'SMTP_HOST',
    ]);
    expect(paths({ ...staging, SMTP_HOST: undefined })).toEqual([]);
  });

  it('refuses Postgres 5432 and databases not named staging', () => {
    const db = (url: string) => paths({ ...staging, DATABASE_URL: url });
    expect(db('postgresql://u:p@localhost:5432/datascribe_staging')).toEqual(['DATABASE_URL']);
    expect(db('postgresql://u:p@localhost/datascribe_staging')).toEqual(['DATABASE_URL']);
    expect(db('postgresql://u:p@localhost:5433/datascribe')).toEqual(['DATABASE_URL']);
    expect(db('postgresql://u:p@localhost:5433/datascribe_dev')).toEqual(['DATABASE_URL']);
    expect(db('postgresql://u:p@localhost:5432/crm')).toEqual(['DATABASE_URL', 'DATABASE_URL']);
    expect(db('not a url')).toEqual(['DATABASE_URL']);
  });

  it('allows S3_SSE=none only against the local SeaweedFS', () => {
    expect(paths({ ...staging, S3_ENDPOINT: undefined })).toEqual(['S3_SSE']);
    expect(paths({ ...staging, S3_ENDPOINT: 'https://s3.example.com' })).toEqual(['S3_SSE']);
    expect(paths({ ...staging, S3_ENDPOINT: 'http://127.0.0.1:9000' })).toEqual([]);
  });

  it('requires an https APP_URL, except the smoke flag on localhost', () => {
    expect(paths({ ...staging, APP_URL: 'http://datascribe.stayspot.app' })).toEqual(['APP_URL']);
    expect(paths({ ...staging, APP_URL: 'http://localhost:3901' })).toEqual(['APP_URL']);
    const smoke = { ...staging, STAGING_ALLOW_HTTP_FOR_SMOKE: '1' };
    expect(paths({ ...smoke, APP_URL: 'http://localhost:3901' })).toEqual([]);
    expect(paths({ ...smoke, APP_URL: 'http://127.0.0.1:3901' })).toEqual([]);
    expect(paths({ ...smoke, APP_URL: 'http://datascribe.stayspot.app' })).toEqual(['APP_URL']);
    expect(
      paths({ ...staging, STAGING_ALLOW_HTTP_FOR_SMOKE: 'true', APP_URL: 'http://localhost' }),
    ).toEqual(['APP_URL']);
  });

  it('refuses the smoke flag in production and ignores staging rules there', () => {
    expect(paths({ ...prod, STAGING_ALLOW_HTTP_FOR_SMOKE: '1' })).toEqual([
      'STAGING_ALLOW_HTTP_FOR_SMOKE',
    ]);
    // production has its own refusals in the API schema; the staging list never applies
    expect(paths({ ...prod, DATABASE_URL: 'postgresql://x@db:5432/prod' })).toEqual([]);
  });

  it('local development is untouched', () => {
    expect(
      deployProfileIssues({
        NODE_ENV: 'development',
        SUMMARY_PROVIDER: 'anthropic',
        SMTP_HOST: 'smtp.example.com',
        DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe',
        APP_URL: 'http://localhost:3010',
      }),
    ).toEqual([]);
    expect(stagingViolations(staging)).toEqual([]);
  });
});
