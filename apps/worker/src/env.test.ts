import { describe, expect, it } from 'vitest';
import { assertWorkerEnv, workerEnvIssues } from './env';

const prod = { NODE_ENV: 'production', CLAMAV_HOST: 'clamav', S3_SSE: 'aws:kms' };
const staging = {
  NODE_ENV: 'production',
  DEPLOY_ENV: 'staging',
  APP_URL: 'https://datascribe.stayspot.app',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe_staging',
  S3_SSE: 'none',
  S3_ENDPOINT: 'http://localhost:9000',
  CLAMAV_HOST: 'localhost',
};
const paths = (env: Record<string, string | undefined>) => workerEnvIssues(env).map((i) => i.path);

describe('worker start-up checks', () => {
  it('production refuses to start unless S3_SSE=aws:kms (D-117)', () => {
    expect(paths(prod)).toEqual([]);
    expect(paths({ ...prod, S3_SSE_KMS_KEY_ID: 'arn:aws:kms:x' })).toEqual([]);
    for (const sse of [undefined, '', 'AES256', 'none']) {
      expect(paths({ ...prod, S3_SSE: sse }), String(sse)).toEqual(['S3_SSE']);
    }
    expect(() => assertWorkerEnv({ ...prod, S3_SSE: 'AES256' })).toThrow(/S3_SSE=aws:kms/);
  });

  it('production needs ClamAV', () => {
    expect(paths({ ...prod, CLAMAV_HOST: '' })).toEqual(['CLAMAV_HOST']);
    expect(paths({ ...prod, CLAMAV_HOST: undefined })).toEqual(['CLAMAV_HOST']);
  });

  it('staging (SeaweedFS without SSE) and local development still start', () => {
    expect(paths(staging)).toEqual([]);
    expect(paths({ NODE_ENV: 'development', S3_SSE: 'none' })).toEqual([]);
    expect(paths({ NODE_ENV: 'test' })).toEqual([]);
    expect(() => assertWorkerEnv(staging)).not.toThrow();
  });

  it('Sentry is optional; a bad DSN or sample rate stops start-up (D-119)', () => {
    expect(paths({ NODE_ENV: 'test', SENTRY_DSN: '' })).toEqual([]);
    expect(paths({ NODE_ENV: 'test', SENTRY_DSN: 'https://k@o1.ingest.example/1' })).toEqual([]);
    expect(paths({ NODE_ENV: 'test', SENTRY_DSN: 'not a dsn' })).toEqual(['SENTRY_DSN']);
    expect(paths({ NODE_ENV: 'test', SENTRY_TRACES_SAMPLE_RATE: 'all' })).toEqual([
      'SENTRY_TRACES_SAMPLE_RATE',
    ]);
  });

  it('names variables, never values', () => {
    expect(() =>
      assertWorkerEnv({ ...prod, S3_SSE: 'AES256', DATABASE_URL: 'postgresql://secret@x/db' }),
    ).toThrow(/^(?!.*secret).*$/s);
  });
});
