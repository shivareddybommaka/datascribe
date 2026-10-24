import { resolveDeployEnv } from '@datascribe/shared/deploy';

/**
 * Staging (D-120, D-123): read on the server. Pages are prerendered at build time, so the staging
 * build itself must run with DEPLOY_ENV=staging (`pnpm staging:build` does, and `staging:start`
 * refuses a build that wasn't made for staging).
 */
export const isStaging = (env: Record<string, string | undefined> = process.env) =>
  resolveDeployEnv(env) === 'staging';

export const STAGING_BANNER_TEXT =
  'Staging — synthetic data only. Do not upload real patient records.';

/** Response headers every staging page and asset gets: never indexed or cached by crawlers. */
export const STAGING_HEADERS = [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }];
