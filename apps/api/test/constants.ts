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
