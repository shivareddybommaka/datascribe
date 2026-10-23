/**
 * Vitest global setup for API integration tests.
 * Creates (if needed) and resets the *_test database, applies migrations, seeds it and enables
 * MFA with a known secret for the internal seed users. Refuses any DB whose name isn't *_test.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@datascribe/db';
import { seedDatabase, SEED_USERS } from '@datascribe/db/seed';
import { encrypt } from '@datascribe/shared';
import { TEST_DATABASE_URL, TEST_PASSWORD, TEST_TOTP_SECRET, testPhiKey } from './constants';

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/db');

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": test database name must end with _test`);
  }

  // Create the test DB if missing (via the maintenance DB on the same server).
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    if (!String((err as Error).message).includes('already exists')) throw err;
  } finally {
    await admin.$disconnect();
  }

  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');

    execFileSync(
      process.execPath,
      [
        path.join(dbDir, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        path.join(dbDir, 'prisma/schema.prisma'),
      ],
      { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'pipe' },
    );

    await seedDatabase(prisma, { password: TEST_PASSWORD, phiKey: testPhiKey });

    const internalEmails = SEED_USERS.filter((u) => u.org === 'internal').map((u) => u.email);
    await prisma.user.updateMany({
      where: { email: { in: internalEmails } },
      data: { mfaEnabled: true, mfaSecret: encrypt(TEST_TOTP_SECRET, testPhiKey) },
    });
  } finally {
    await prisma.$disconnect();
  }
}
