import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local S3 (SeaweedFS, compose service `s3`) for upload tests. Credentials come from the
 * environment, else the checkout's .env (only the S3_ keys are read), else the compose defaults.
 * Buckets are per checkout, like the test DB: `ds-portal-test-documents` for .worktrees/portal.
 *
 * Kept apart from constants.ts: playwright.config imports this, and importing constants.ts there
 * would fix TEST_DATABASE_URL before the config points it at the *_e2e database.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.basename(path.resolve(here, '../../..'));

function dotEnvS3(): Record<string, string> {
  const file = path.resolve(here, '../../../.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^(S3_(?:ENDPOINT|ACCESS_KEY_ID|SECRET_ACCESS_KEY))=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}
const s3Env = { ...dotEnvS3(), ...process.env };
const bucketPrefix =
  repoDir === 'datascribe'
    ? 'ds-test'
    : `ds-${repoDir.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-test`;

export const TEST_S3 = {
  S3_ENDPOINT: s3Env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY_ID: s3Env.S3_ACCESS_KEY_ID ?? 'datascribe',
  S3_SECRET_ACCESS_KEY: s3Env.S3_SECRET_ACCESS_KEY ?? 'datascribe-dev-secret',
  S3_BUCKET_DOCUMENTS: `${bucketPrefix}-documents`,
  S3_BUCKET_DELIVERABLES: `${bucketPrefix}-deliverables`,
  // SeaweedFS has no SSE without a KMS (D-070); production refuses "none"
  S3_SSE: 'none',
  // S3's minimum, so multi-part uploads stay small in tests
  UPLOAD_PART_SIZE_MB: '5',
};
