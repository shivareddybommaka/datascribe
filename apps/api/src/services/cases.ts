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

/** Submitted and not yet delivered: the work Datascribe owes, so these carry SLA flags (§5.4). */
export const SLA_STATUSES: readonly CaseStatus[] = [
  'submitted',
  'processing',
  'in_review',
  'qa',
  'changes_requested',
  'approved',
  'on_hold',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** §5.4 SLA flag: overdue → red, due in under 24 h → amber, otherwise none (D-083). */
export function slaFlag(
  c: { status: CaseStatus; dueAt: Date | null },
  now: Date = new Date(),
): 'red' | 'amber' | null {
  if (!c.dueAt || !SLA_STATUSES.includes(c.status)) return null;
  const left = c.dueAt.getTime() - now.getTime();
  if (left < 0) return 'red';
  return left < DAY_MS ? 'amber' : null;
}

/** Prisma filter matching slaFlag(): red = overdue, amber = due within 24 h. */
export function slaWhere(flag: 'red' | 'amber', now: Date = new Date()): Prisma.CaseWhereInput {
  const status = { in: [...SLA_STATUSES] };
  return flag === 'red'
    ? { status, dueAt: { lt: now } }
    : { status, dueAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) } };
}

/** The three staff assignments on a case (§5.4) and the case column holding each. */
export const ASSIGNMENT_ROLES = ['case_manager', 'summarizer', 'qa_reviewer'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_FIELD = {
  case_manager: 'caseManagerId',
  summarizer: 'summarizerId',
  qa_reviewer: 'qaReviewerId',
} as const satisfies Record<AssignmentRole, string>;

/**
 * Who can fill an assignment, by permission rather than role key so custom roles work (D-083):
 * a case manager edits cases firm-wide or wider, a summarizer edits deliverables, a QA reviewer
 * approves them. Always internal, active users.
 */
export const ASSIGNABLE_BY: Record<
  AssignmentRole,
  { module: 'cases' | 'deliverables'; action: 'edit' | 'approve'; scopes: string[] }
> = {
  case_manager: { module: 'cases', action: 'edit', scopes: ['all'] },
  summarizer: { module: 'deliverables', action: 'edit', scopes: ['all', 'assigned'] },
  qa_reviewer: { module: 'deliverables', action: 'approve', scopes: ['all', 'assigned'] },
};

/** Statuses in which assignments may change: not before submit, not after the case ends. */
export const ASSIGNABLE_STATUSES: readonly CaseStatus[] = [...SLA_STATUSES, 'delivered'];
