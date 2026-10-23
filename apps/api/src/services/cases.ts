import type { CaseStatus, Prisma } from '@datascribe/db';

/** Records can be added (or removed) until processing starts; on_hold reopens that window. */
export const UPLOADABLE_STATUSES: readonly CaseStatus[] = ['draft', 'submitted', 'on_hold'];

/** "Open" for dashboards and the default list filter. */
export const CLOSED_STATUSES: readonly CaseStatus[] = ['closed', 'cancelled'];

/**
 * Case number DS-<year>-<000001>, gap-free per year from the Counter table (D-009). Must run inside
 * the transaction that creates the case so a rollback also rolls the counter back.
 */
export async function nextCaseNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  const key = `case:${year}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("key", "value", "updatedAt") VALUES (${key}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1, "updatedAt" = now()
    RETURNING "value"`;
  return `DS-${year}-${String(rows[0]!.value).padStart(6, '0')}`;
}

/** Audit actions that make up a case's status timeline (M6 writes `case.status` the same way). */
export const TIMELINE_ACTIONS = ['case.create', 'case.submit', 'case.status'] as const;
