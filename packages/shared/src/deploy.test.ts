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
};
const paths = (env: Record<string, string | undefined>) =>
  deployProfileIssues(env).map((i) => i.path);

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
    expect(paths({ NODE_ENV: 'production', DEPLOY_ENV: 'production' })).toEqual([]);
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
    expect(paths({ NODE_ENV: 'production', STAGING_ALLOW_HTTP_FOR_SMOKE: '1' })).toEqual([
      'STAGING_ALLOW_HTTP_FOR_SMOKE',
    ]);
    // production has its own refusals in the API schema; the staging list never applies
    expect(paths({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x@db:5432/prod' })).toEqual(
      [],
    );
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
