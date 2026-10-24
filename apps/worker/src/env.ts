import { deployProfileIssues, resolveDeployEnv, type DeployIssue } from '@datascribe/shared';
import { sentryEnvIssues } from '@datascribe/shared/sentry';

/**
 * The worker's start-up checks, same deploy profile as the API (D-120): staging refuses real
 * third parties and databases; production needs a real virus scanner and S3_SSE=aws:kms (D-117).
 */
export function workerEnvIssues(env: Record<string, string | undefined>): DeployIssue[] {
  const issues = [...deployProfileIssues(env), ...sentryEnvIssues(env)];
  if (issues.length) return issues;
  if (resolveDeployEnv(env) === 'production' && !env.CLAMAV_HOST?.trim()) {
    return [
      { path: 'CLAMAV_HOST', message: 'production needs a real virus scanner (set CLAMAV_HOST)' },
    ];
  }
  return [];
}

/** Throws with variable names and reasons only, never values. */
export function assertWorkerEnv(env: Record<string, string | undefined>): void {
  const issues = workerEnvIssues(env);
  if (issues.length) {
    throw new Error(
      `Invalid environment: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
  }
}
