/**
 * Deploy profile (D-120): where a build runs, on top of NODE_ENV.
 *
 * - `local`: development and tests (NODE_ENV development / test).
 * - `staging`: a NODE_ENV=production build on Shiva's Mac behind a Cloudflare tunnel, synthetic
 *   data only. It may use the Mac's local services (SeaweedFS without SSE, the fake payment
 *   gateway, the mock virus scanner) but refuses anything that reaches a real third party or a
 *   real database: see {@link stagingViolations}.
 * - `production`: every production refusal applies (the default when NODE_ENV=production).
 *
 * No Node imports: the API, the worker and the web app all read it.
 */

export const DEPLOY_ENVS = ['local', 'staging', 'production'] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

type Raw = Record<string, string | undefined>;

/** DEPLOY_ENV, or its default: production when NODE_ENV=production, local otherwise. */
export function resolveDeployEnv(env: Raw): DeployEnv {
  const value = env.DEPLOY_ENV?.trim();
  if (value) return value as DeployEnv;
  return env.NODE_ENV === 'production' ? 'production' : 'local';
}

export interface DeployIssue {
  path: string;
  message: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const parseUrl = (value: string | undefined): URL | null => {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
};

/**
 * DEPLOY_ENV must match NODE_ENV: a production build is staging or production, never local
 * (that would switch every production refusal off), and only production builds are staging.
 */
export function deployEnvIssues(env: Raw): DeployIssue[] {
  const value = env.DEPLOY_ENV?.trim();
  if (!value) return [];
  if (!(DEPLOY_ENVS as readonly string[]).includes(value)) {
    return [{ path: 'DEPLOY_ENV', message: 'must be local, staging or production' }];
  }
  const prodBuild = env.NODE_ENV === 'production';
  if (prodBuild && value === 'local') {
    return [{ path: 'DEPLOY_ENV', message: 'NODE_ENV=production runs as staging or production' }];
  }
  if (!prodBuild && value !== 'local') {
    return [{ path: 'DEPLOY_ENV', message: `${value} needs NODE_ENV=production` }];
  }
  return [];
}

/**
 * What staging refuses (D-120). Staging is public behind the tunnel but holds synthetic data
 * only, so nothing may leave the Mac or touch a real system:
 * - a real LLM (SUMMARY_PROVIDER other than mock), AWS Textract OCR or live Stripe keys;
 * - SMTP anywhere but Mailpit on localhost;
 * - Postgres on 5432 (Shiva's CRM) or a database whose name lacks "staging";
 * - S3_SSE=none on anything but the Mac's own SeaweedFS;
 * - an http APP_URL (the tunnel serves https), except the local smoke test's explicit
 *   STAGING_ALLOW_HTTP_FOR_SMOKE=1 with a localhost APP_URL;
 * - the mock virus scanner unless STAGING_ALLOW_MOCK_SCAN=true, and auth rate limits or the
 *   response floor looser than production's defaults (D-125).
 */
export function stagingViolations(env: Raw): DeployIssue[] {
  const issues: DeployIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if ((env.SUMMARY_PROVIDER || 'mock') !== 'mock') {
    add('SUMMARY_PROVIDER', 'staging runs the mock summarizer only (no real LLM over any data)');
  }
  if (env.OCR_PROVIDER === 'textract') {
    add('OCR_PROVIDER', 'staging keeps OCR on the Mac (tesseract or mock), never AWS Textract');
  }
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'] as const) {
    if (/^(sk|rk|pk)_live_/.test(env[key] ?? '')) add(key, 'staging never uses live Stripe keys');
  }
  if (!LOCAL_HOSTS.has((env.SMTP_HOST || 'localhost').trim().toLowerCase())) {
    add('SMTP_HOST', 'staging sends mail to Mailpit on localhost only');
  }

  const db = parseUrl(env.DATABASE_URL);
  if (!db) {
    add('DATABASE_URL', 'must be a URL');
  } else {
    if ((db.port || '5432') === '5432') {
      add('DATABASE_URL', 'port 5432 is another system on this Mac; Datascribe uses 5433');
    }
    const name = decodeURIComponent(db.pathname.replace(/^\//, ''));
    if (!name.includes('staging')) {
      add('DATABASE_URL', 'staging only connects to a database whose name contains "staging"');
    }
  }

  if (env.S3_SSE === 'none') {
    const s3 = parseUrl(env.S3_ENDPOINT);
    if (!s3 || !LOCAL_HOSTS.has(s3.hostname)) {
      add('S3_SSE', 'S3_SSE=none is only for the local SeaweedFS (S3_ENDPOINT on localhost)');
    }
  }

  const app = parseUrl(env.APP_URL);
  const smoke = env.STAGING_ALLOW_HTTP_FOR_SMOKE === '1';
  if (!app || app.protocol !== 'https:') {
    if (!smoke) add('APP_URL', 'staging is served over https (the Cloudflare tunnel)');
    else if (!app || !LOCAL_HOSTS.has(app.hostname)) {
      add('APP_URL', 'STAGING_ALLOW_HTTP_FOR_SMOKE=1 only allows a localhost APP_URL');
    }
  }

  // Staging is on the open internet (no Access gate, D-125): scan uploads for real.
  if (!env.CLAMAV_HOST?.trim() && env.STAGING_ALLOW_MOCK_SCAN !== 'true') {
    add('CLAMAV_HOST', 'staging needs ClamAV (or STAGING_ALLOW_MOCK_SCAN=true to opt out)');
  }
  // Auth limits stay as strict as production's defaults: stricter is fine, looser is refused.
  for (const [key, max] of Object.entries(AUTH_LIMIT_DEFAULTS)) {
    const value = env[key]?.trim();
    if (value && Number(value) > max) add(key, `staging keeps the production limit (≤ ${max})`);
  }
  const floor = env.AUTH_RESPONSE_FLOOR_MS?.trim();
  if (floor && Number(floor) < AUTH_FLOOR_DEFAULT_MS) {
    add(
      'AUTH_RESPONSE_FLOOR_MS',
      `staging keeps the production floor (≥ ${AUTH_FLOOR_DEFAULT_MS})`,
    );
  }
  return issues;
}

/** The API's production defaults (apps/api/src/config/env.ts); staging may not loosen them. */
export const AUTH_LIMIT_DEFAULTS = {
  RATE_LIMIT_AUTH: 30,
  RATE_LIMIT_PUBLIC: 10,
  RATE_LIMIT_ACCOUNT: 10,
} as const;
export const AUTH_FLOOR_DEFAULT_MS = 400;

/** Staging-only switches; production refuses them so they can't be left on by mistake. */
const STAGING_ONLY = [
  'STAGING_ALLOW_HTTP_FOR_SMOKE',
  'STAGING_ALLOW_SIGNUP',
  'STAGING_ALLOW_MOCK_SCAN',
] as const;

/**
 * What production refuses here (the API schema adds its own rules):
 * - the staging-only switches, so they can't be left on by mistake;
 * - any S3_SSE but aws:kms (D-117). Documents are PHI, so production writes them with the
 *   customer-managed KMS key Terraform creates; the default AES256 (S3-managed keys) is refused
 *   as well as none. S3_SSE_KMS_KEY_ID stays optional (the bucket's default key otherwise).
 */
export function productionViolations(env: Raw): DeployIssue[] {
  const on = (v: string | undefined) => v?.trim() === 'true' || v?.trim() === '1';
  const issues: DeployIssue[] = STAGING_ONLY.filter((key) => on(env[key])).map((path) => ({
    path,
    message: 'is for staging only; not allowed in production',
  }));
  if ((env.S3_SSE?.trim() || 'AES256') !== 'aws:kms') {
    issues.push({
      path: 'S3_SSE',
      message: 'production stores documents with S3_SSE=aws:kms only',
    });
  }
  return issues;
}

/** Every deploy-profile problem for this environment (empty = fine). */
export function deployProfileIssues(env: Raw): DeployIssue[] {
  const issues = deployEnvIssues(env);
  if (issues.length) return issues;
  const profile = resolveDeployEnv(env);
  if (profile === 'staging') return stagingViolations(env);
  if (profile === 'production') return productionViolations(env);
  return [];
}
