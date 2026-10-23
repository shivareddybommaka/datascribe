/** `pnpm db:seed` — dev seed. Logic lives in seed-lib.ts (shared with the API tests). */
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { loadKey } from '@datascribe/shared';
import { PrismaClient } from '../generated/client/index.js';
import { seedDatabase } from './seed-lib';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed with NODE_ENV=production.');
  process.exit(1);
}

// Port 5432 on the dev Mac is another (live) system. Never seed it, whatever .env says.
const dbPort =
  new URL(process.env.DATABASE_URL ?? 'postgresql://x@localhost:5433/x').port || '5432';
if (dbPort === '5432') {
  console.error('Refusing to seed a database on port 5432. Datascribe uses 5433.');
  process.exit(1);
}

const password = process.env.SEED_USER_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set SEED_USER_PASSWORD (min 12 chars) in .env before seeding.');
  process.exit(1);
}

const prisma = new PrismaClient();

seedDatabase(prisma, { password, phiKey: loadKey(process.env.PHI_ENCRYPTION_KEY) })
  .then(({ counts: c }) => {
    console.log(
      `Seeded ${c.permissions} permissions, ${c.roles} roles, ${c.plans} plans, ` +
        `${c.orgs} orgs, ${c.users} users, ${c.cases} synthetic cases.`,
    );
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
