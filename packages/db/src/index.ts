import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Shared client. Query logging is off on purpose: queries can carry PHI parameters. Prisma's own
 * error log prints the failed call with its arguments, so errors are logged by target only and
 * the caller logs `errorInfo(err)` (audit L7).
 */
function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
  client.$on('warn', (e) => console.warn(`prisma:warn ${e.target}: ${e.message}`));
  client.$on('error', (e) => console.error(`prisma:error ${e.target}`));
  return client;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export interface ErrorInfo {
  name: string;
  /** Prisma error code (P2002 …) or a Node / AWS error code */
  code?: string;
  model?: string;
  /** constraint columns from Prisma's `meta.target`: names, never values */
  fields?: string[];
  message?: string;
}

/**
 * What may be logged about an error (audit L7). Prisma messages quote the failed call with its
 * arguments (names, notes, emails …), so for Prisma errors only the name, code, model and
 * constraint column names are kept. Other errors keep their message.
 */
export function errorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) return { name: typeof err };
  const e = err as Error & { code?: unknown; errorCode?: unknown; meta?: unknown };
  const rawCode = e.code ?? e.errorCode;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  if (!e.name.startsWith('PrismaClient')) {
    return { name: e.name, ...(code ? { code } : {}), message: e.message };
  }
  const meta = (e.meta ?? {}) as { modelName?: unknown; target?: unknown };
  const fields = Array.isArray(meta.target)
    ? meta.target.filter((t): t is string => typeof t === 'string')
    : undefined;
  return {
    name: e.name,
    ...(code ? { code } : {}),
    ...(typeof meta.modelName === 'string' ? { model: meta.modelName } : {}),
    ...(fields?.length ? { fields } : {}),
  };
}
