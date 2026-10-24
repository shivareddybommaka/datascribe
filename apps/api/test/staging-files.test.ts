/**
 * Local staging files (D-124): the example env, the runner's own refusals and the launchd /
 * cloudflared templates. Read as text or imported; nothing is started.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
// @ts-expect-error plain ESM script without types
import * as stagingLib from '../../../scripts/staging-lib.mjs';

const { devSeedPasswords, seedPasswordProblem, stagingEnv, stagingProblems } = stagingLib;

const root = path.resolve(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const example = parseEnv(read('.env.staging.example')) as Record<string, string>;

type Problems = (env: Record<string, string>, opts?: { smoke?: boolean }) => string[];
const problems = stagingProblems as Problems;
const filled = {
  ...example,
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  PHI_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('.env.staging.example (D-124)', () => {
  it('holds no secrets', () => {
    for (const key of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'PHI_ENCRYPTION_KEY',
      'SEED_USER_PASSWORD',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'STRIPE_SECRET_KEY',
    ]) {
      expect(example[key], key).toBe('');
    }
    expect(read('.env.staging.example')).not.toMatch(/TUNNEL_TOKEN|eyJ[A-Za-z0-9_-]{20,}/);
  });

  it('describes the agreed staging setup', () => {
    expect(example.APP_URL).toBe('https://datascribe.stayspot.app');
    expect(example.WEB_PORT).toBe('3020');
    expect(example.API_PORT).toBe('4020');
    expect(new URL(example.DATABASE_URL!).pathname).toBe('/datascribe_staging');
    expect(new URL(example.DATABASE_URL!).port).toBe('5433');
    expect(new URL(example.CMS_DATABASE_URL!).pathname).toBe('/datascribe_staging_cms');
    expect(example.REDIS_URL).toBe('redis://localhost:6379/5');
    expect(example.SMTP_HOST).toBe('localhost');
    expect(example.S3_BROWSER_ACCESS).toBe('relay');
  });

  it('passes the API env validation as staging once the secrets are filled', () => {
    const env = loadEnv(stagingEnv(filled));
    expect(env.DEPLOY_ENV).toBe('staging');
    expect(env.NODE_ENV).toBe('production');
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(problems(stagingEnv(filled))).toEqual([]);
  });
});

describe('staging runner refusals (D-124)', () => {
  const env = stagingEnv(filled) as Record<string, string>;
  const names = (over: Record<string, string>, smoke = false) =>
    problems({ ...env, ...over }, { smoke }).map((p) => p.split(':')[0]);

  it('keeps the web app on 3020, never 3000 or 3010', () => {
    expect(names({ WEB_PORT: '3000' })).toEqual(['WEB_PORT']);
    expect(names({ WEB_PORT: '3010' })).toEqual(['WEB_PORT']);
    expect(names({ WEB_PORT: '3021' })).toEqual(['WEB_PORT']);
    // the smoke test runs on its own 39xx ports, still never 3000 / 3010
    expect(names({ WEB_PORT: '3901' }, true)).toEqual([]);
    expect(names({ WEB_PORT: '3000' }, true)).toEqual(['WEB_PORT']);
  });

  it('refuses Postgres 5432 and databases not named staging', () => {
    expect(names({ DATABASE_URL: 'postgresql://u:p@localhost:5432/datascribe_staging' })).toEqual([
      'DATABASE_URL',
    ]);
    expect(names({ DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe' })).toEqual([
      'DATABASE_URL',
    ]);
    expect(names({ CMS_DATABASE_URL: 'postgresql://u:p@localhost:5433/datascribe_cms' })).toEqual([
      'CMS_DATABASE_URL',
    ]);
  });

  it('refuses the smoke flag outside the smoke test, and missing secrets', () => {
    expect(names({ STAGING_ALLOW_HTTP_FOR_SMOKE: '1' })).toEqual(['STAGING_ALLOW_HTTP_FOR_SMOKE']);
    expect(names({ JWT_ACCESS_SECRET: '' })).toEqual(['JWT_ACCESS_SECRET']);
    expect(names({ API_PORT: '4021' })).toEqual(['API_URL']);
  });

  it('starts every process as a production build in the staging profile, without dev values', () => {
    const shellOnly = stagingEnv({}) as Record<string, string>;
    expect(shellOnly.NODE_ENV).toBe('production');
    expect(shellOnly.DEPLOY_ENV).toBe('staging');
    expect(shellOnly.GA4_MEASUREMENT_ID).toBeUndefined();
    expect(shellOnly.DATABASE_URL).toBeUndefined();
  });
});

describe('staging seed password (D-125)', () => {
  const check = seedPasswordProblem as (p: string | undefined, dev: string[]) => string | null;
  const dev = ['Dev-seed-password-123'];

  it('needs 20+ characters and never dev’s value', () => {
    expect(check(undefined, dev)).toMatch(/^SEED_USER_PASSWORD: .*20\+/);
    expect(check('short-but-12chars', dev)).toMatch(/20\+/);
    expect(check('x'.repeat(19), dev)).toMatch(/20\+/);
    expect(check('x'.repeat(20), dev)).toBeNull();
    const longDev = 'a-long-dev-password-of-30-chars';
    expect(check(longDev, [longDev])).toMatch(/must not reuse/);
  });

  it('never puts the value in the message', () => {
    const value = 'q'.repeat(25);
    expect(check(value, [value])).not.toContain(value);
  });

  it("reads dev's values from the .env files on this Mac", () => {
    const values = (devSeedPasswords as () => string[])();
    expect(Array.isArray(values)).toBe(true);
    for (const v of values) expect(typeof v).toBe('string');
  });
});

describe('launchd and cloudflared templates (D-124)', () => {
  const files = [
    'infra/staging/app.datascribe.staging.plist',
    'infra/staging/app.datascribe.staging-tunnel.plist',
    'infra/staging/cloudflared.yml',
  ];

  it('hold no tunnel token and never point at ~/.cloudflared', () => {
    for (const f of files) {
      // settings only: the comments explain why ~/.cloudflared is avoided
      const text = read(f)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^\s*#.*$/gm, '');
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/\.cloudflared\/|credentials-file|tunnel:\s/);
      expect(text, f).not.toMatch(/localhost:(3000|3010)\b/);
    }
  });

  it('the tunnel job reads its token from the Keychain and uses its own config', () => {
    const tunnel = read('infra/staging/app.datascribe.staging-tunnel.plist');
    expect(tunnel).toContain('security find-generic-password -a nova -s datascribe-staging-tunnel');
    expect(tunnel).toContain('--config __REPO__/infra/staging/cloudflared.yml tunnel run');
  });
});
