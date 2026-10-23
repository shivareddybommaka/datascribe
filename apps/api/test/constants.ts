/** Test-only values. Synthetic, never used outside the *_test database. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://datascribe:datascribe@localhost:5433/datascribe_test';

export const TEST_PASSWORD = 'Test-password-123!';

/** Base32 TOTP secret given to every internal seed user in the test DB. */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export const testPhiKey = Buffer.alloc(32, 7);
