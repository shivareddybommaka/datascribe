import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test DB per checkout, so parallel git worktrees (subagents) never reset each other's database:
 * the main repo uses `datascribe_test`; a worktree at `.worktrees/ledger` uses `datascribe_ledger_test`.
 */
const repoDir = path.basename(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const dbName =
  repoDir === 'datascribe'
    ? 'datascribe_test'
    : `datascribe_${repoDir.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_test`;

/** Test-only values. Synthetic, never used outside the *_test database. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? `postgresql://datascribe:datascribe@localhost:5433/${dbName}`;

export const TEST_PASSWORD = 'Test-password-123!';

/** Base32 TOTP secret given to every internal seed user in the test DB. */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const testPhiKey = Buffer.alloc(32, 7);

/**
 * Local S3 (SeaweedFS, compose service `s3`) for upload tests. Credentials come from the
 * environment, else the checkout's .env (only the S3_ keys are read), else the compose defaults.
 * Buckets are per checkout, like the test DB: `ds-portal-test-documents` for .worktrees/portal.
 */
function dotEnvS3(): Record<string, string> {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
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
