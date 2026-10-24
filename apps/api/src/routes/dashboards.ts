import type { Prisma } from '@datascribe/db';
import { CASE_STATUSES, LEAD_STAGES, type CaseStatus } from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import type { Deps } from '../context';
import { forbidden } from '../lib/errors';
import { parse } from '../lib/validate';
import { requireInternal } from './crm/common';

const Range = z.object({
  /** leads created in the last N days count towards conversion and sources (default 90) */
  days: z.coerce.number().int().min(1).max(730).default(90),
});

const OpsRange = z.object({
  /** cases delivered / reaching review in the last N days count towards turnaround (default 30) */
  days: z.coerce.number().int().min(1).max(730).default(30),
});

/** Submitted and not finished: these count as workload and can be overdue. */
const OPEN: CaseStatus[] = [
  'submitted',
  'processing',
  'in_review',
  'qa',
  'changes_requested',
  'approved',
  'on_hold',
];

type OpsScope = 'all' | 'assigned' | 'own';

/**
 * Which cases the ops dashboard counts (D-093). `all` = every case; `assigned` (case manager's
 * "team") = cases they manage or work on; `own` (summarizer / QA) = cases they summarize or review.
 * `own` differs from caseScopeWhere's, which means "created or shared" and fits client users.
 */
function opsScope(auth: AuthContext): { scope: OpsScope; where: Prisma.CaseWhereInput } {
  const scopes = new Set(
    auth.permissions
      .filter((p) => p.module === 'dashboard_ops' && p.action === 'view')
      .map((p) => p.scope),
  );
  const me = auth.user.id;
  if (scopes.has('all')) return { scope: 'all', where: {} };
  if (scopes.has('assigned')) {
    return {
      scope: 'assigned',
      where: { OR: [{ caseManagerId: me }, { summarizerId: me }, { qaReviewerId: me }] },
    };
  }
  if (scopes.has('own')) {
    return { scope: 'own', where: { OR: [{ summarizerId: me }, { qaReviewerId: me }] } };
  }
  throw forbidden(); // e.g. only a `firm` grant, which means nothing for internal ops
}

const HOUR = 3_600_000;
const avgHours = (spans: number[]) =>
  spans.length
    ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length / HOUR) * 10) / 10
    : null;

/**
 * §5.9 dashboards (M9 part 2, D-092). Aggregates only: counts and sums, never lead rows, so a
 * dashboard grant shows no contact or case details. Sales (D-092) and ops (D-093); finance and
 * client follow.
 */
export function dashboardsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/dashboards', authenticate(deps), requireInternal);

  r.get('/dashboards/sales', requirePermission('dashboard_sales', 'view'), async (req, res) => {
    const { days } = parse(Range, req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const [byStage, bySource, cohort] = await Promise.all([
      prisma.lead.groupBy({
        by: ['stage', 'currency'],
        _count: { _all: true },
        _sum: { value: true },
      }),
      prisma.lead.groupBy({
        by: ['source'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ['stage'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    // pipeline value per stage, one total per currency (leads aren't converted between currencies)
    const pipeline = LEAD_STAGES.map((stage) => {
      const rows = byStage.filter((s) => s.stage === stage);
      return {
        stage,
        count: rows.reduce((n, s) => n + s._count._all, 0),
        value: rows
          .filter((s) => s._sum.value !== null)
          .map((s) => ({ currency: s.currency, amount: s._sum.value!.toFixed(2) }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    });

    const inCohort = (stage: string) => cohort.find((c) => c.stage === stage)?._count._all ?? 0;
    const created = cohort.reduce((n, c) => n + c._count._all, 0);
    const won = inCohort('won');
    const lost = inCohort('lost');

    res.json({
      days,
      pipeline,
      conversion: {
        created,
        won,
        lost,
        /** won ÷ created in the window; null when nothing was created */
        rate: created ? won / created : null,
        /** won ÷ (won + lost): of the leads that closed, how many were won */
        winRate: won + lost ? won / (won + lost) : null,
      },
      sources: bySource
        .map((s) => ({ source: s.source, count: s._count._all }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    });
  });

  r.get('/dashboards/ops', requirePermission('dashboard_ops', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const { days } = parse(OpsRange, req.query);
    const { scope, where } = opsScope(auth);
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const open: Prisma.CaseWhereInput = { AND: [where, { status: { in: OPEN } }] };
    const overdueWhere: Prisma.CaseWhereInput = { AND: [open, { dueAt: { lt: now } }] };
    // `own` sees its own workload row only, not colleagues' counts
    const mine: Prisma.CaseWhereInput = scope === 'own' ? { summarizerId: auth.user.id } : {};

    const [byStatus, openCount, overdue, delivered, reviewed, load, loadOverdue] =
      await Promise.all([
        prisma.case.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.case.count({ where: open }),
        prisma.case.count({ where: overdueWhere }),
        prisma.case.findMany({
          where: { AND: [where, { deliveredAt: { gte: since }, submittedAt: { not: null } }] },
          select: { submittedAt: true, deliveredAt: true },
        }),
        // the pipeline's move to in_review is only recorded in the status timeline (D-073)
        prisma.auditLog.findMany({
          where: {
            action: 'case.status',
            entity: 'Case',
            createdAt: { gte: since },
            metadata: { path: ['to'], equals: 'in_review' },
          },
          select: { entityId: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.case.groupBy({
          by: ['summarizerId'],
          where: { AND: [open, mine] },
          _count: { _all: true },
        }),
        prisma.case.groupBy({
          by: ['summarizerId'],
          where: { AND: [overdueWhere, mine] },
          _count: { _all: true },
        }),
      ]);

    // first move to review per case, measured from the case's submission; out-of-scope ids drop out
    const firstReview = new Map<string, Date>();
    for (const a of reviewed) {
      if (a.entityId && !firstReview.has(a.entityId)) firstReview.set(a.entityId, a.createdAt);
    }
    const reviewCases = firstReview.size
      ? await prisma.case.findMany({
          where: {
            AND: [where, { id: { in: [...firstReview.keys()] }, submittedAt: { not: null } }],
          },
          select: { id: true, submittedAt: true },
        })
      : [];
    const reviewSpans = reviewCases
      .map((c) => firstReview.get(c.id)!.getTime() - c.submittedAt!.getTime())
      .filter((ms) => ms >= 0);
    const deliverySpans = delivered.map((c) => c.deliveredAt!.getTime() - c.submittedAt!.getTime());

    const ids = load.map((l) => l.summarizerId).filter((id): id is string => !!id);
    const people = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const workload = load
      .map((l) => ({
        userId: l.summarizerId,
        name: l.summarizerId ? (people.find((p) => p.id === l.summarizerId)?.name ?? null) : null,
        open: l._count._all,
        overdue: loadOverdue.find((o) => o.summarizerId === l.summarizerId)?._count._all ?? 0,
      }))
      // unassigned last, then busiest first
      .sort(
        (a, b) =>
          Number(a.userId === null) - Number(b.userId === null) ||
          b.open - a.open ||
          (a.name ?? '').localeCompare(b.name ?? ''),
      );

    res.json({
      days,
      scope,
      byStatus: CASE_STATUSES.map((status) => ({
        status,
        count: byStatus.find((s) => s.status === status)?._count._all ?? 0,
      })),
      open: openCount,
      overdue,
      turnaround: {
        /** submitted → delivered, for cases delivered in the window */
        delivered: { count: deliverySpans.length, avgHours: avgHours(deliverySpans) },
        /** submitted → first in_review, for cases reaching review in the window */
        inReview: { count: reviewSpans.length, avgHours: avgHours(reviewSpans) },
      },
      workload,
    });
  });

  return r;
}
