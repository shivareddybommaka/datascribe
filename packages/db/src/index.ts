import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Shared client. Query logging is off on purpose: queries can carry PHI parameters. */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
