import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { TEST_S3 } from './s3';

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

/**
 * Redis for the shared-store tests (D-111). DB 15 locally; every run uses its own key prefix, so
 * checkouts sharing it don't interfere. CI sets it and requires it to be reachable.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export const TEST_PASSWORD = 'Test-password-123!';

/** Base32 TOTP secret given to every internal seed user in the test DB. */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const testPhiKey = Buffer.alloc(32, 7);
