import { PAGES_METRIC, SCALE, formatUnits, multiply, toUnits } from '@datascribe/billing';
import type { Prisma } from '@datascribe/db';
import {
  CASE_STATUSES,
  LEAD_STAGES,
  type Action,
  type CaseStatus,
  type Module,
} from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../auth/context';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { caseScopeWhere } from '../auth/scoping';
import type { Deps } from '../context';
import { forbidden } from '../lib/errors';
import { parse } from '../lib/validate';
import { billingOrgWhere } from './billing/common';
import { requireInternal } from './crm/common';

const FinanceRange = z.object({
  /** payments on invoices paid in the last N days count as revenue (default 90) */
  days: z.coerce.number().int().min(1).max(730).default(90),
});

const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const;
/** Revenue rows per currency before the rest are folded into "other clients". */
const TOP_CLIENTS = 10;

/** Adds `units` to the running total for `key`. */
const add = (m: Map<string, bigint>, key: string, units: bigint) =>
  m.set(key, (m.get(key) ?? 0n) + units);
const byCurrency = (m: Map<string, bigint>) =>
  [...m]
    .map(([currency, units]) => ({ currency, amount: formatUnits(units) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

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

const ClientRange = z.object({
  /** pages processed and payments on invoices paid in the last N days (default 30) */
  days: z.coerce.number().int().min(1).max(730).default(30),
});

/** Does the caller hold module:action, optionally only at one of `scopes`? */
const holds = (auth: AuthContext, module: Module, action: Action, scopes?: string[]) =>
  auth.permissions.some(
    (p) => p.module === module && p.action === action && (!scopes || scopes.includes(p.scope)),
  );
const FIRM = ['firm', 'all'];

/**
 * §5.9 dashboards (M9 part 2, D-092). Aggregates only: counts and sums, never lead rows, so a
 * dashboard grant shows no contact or case details. Sales (D-092), ops (D-093), finance (D-094)
 * and client (D-095).
 */
export function dashboardsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/dashboards', authenticate(deps));

  /**
   * Client portal dashboard (D-095): client-org users only, always pinned to their own firm.
   * Cases and pages follow the caller's `cases:view` scope (firm for client admins, own + shared
   * for client users); spend needs `invoices:view` and is null without it.
   */
  r.get('/dashboards/client', async (req, res) => {
    const auth = requireAuth(req);
    if (auth.user.orgType !== 'client') throw forbidden();
    const canCases = holds(auth, 'cases', 'view');
    // invoices are firm records: only a firm-wide grant shows spend (billingOrgWhere)
    const canSpend = holds(auth, 'invoices', 'view', FIRM);
    if (!canCases && !holds(auth, 'dashboard_client', 'view')) throw forbidden();
    const { days } = parse(ClientRange, req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const organizationId = auth.user.organizationId;
    const cases = canCases ? caseScopeWhere(auth, 'cases', 'view') : null;
    // firm-wide viewers also count usage not tied to a case; others only their cases' pages
    const firmWide = holds(auth, 'cases', 'view', FIRM);

    const [byStatus, pages, payments] = await Promise.all([
      cases ? prisma.case.groupBy({ by: ['status'], where: cases, _count: { _all: true } }) : null,
      cases
        ? prisma.usageRecord.aggregate({
            where: {
              organizationId,
              metric: PAGES_METRIC,
              createdAt: { gte: since },
              ...(firmWide ? {} : { case: cases }),
            },
            _sum: { quantity: true },
            _count: { _all: true },
          })
        : null,
      canSpend
        ? prisma.payment.findMany({
            where: {
              status: { in: ['succeeded', 'refunded'] },
              invoice: { ...billingOrgWhere(auth, 'invoices', 'view'), paidAt: { gte: since } },
            },
            select: { amount: true, refundedAmount: true, currency: true },
          })
        : null,
    ]);

    let spend: { currency: string; amount: string; payments: number }[] | null = null;
    if (payments) {
      const net = new Map<string, bigint>();
      const count = new Map<string, number>();
      for (const p of payments) {
        add(net, p.currency, toUnits(p.amount) - toUnits(p.refundedAmount));
        count.set(p.currency, (count.get(p.currency) ?? 0) + 1);
      }
      spend = byCurrency(net).map((m) => ({ ...m, payments: count.get(m.currency) ?? 0 }));
    }

    res.json({
      days,
      /** `firm` = every case of the firm, `own` = cases the caller created or that are shared */
      scope: cases ? (firmWide ? 'firm' : 'own') : null,
      cases: byStatus
        ? {
            total: byStatus.reduce((n, s) => n + s._count._all, 0),
            byStatus: CASE_STATUSES.map((status) => ({
              status,
              count: byStatus.find((s) => s.status === status)?._count._all ?? 0,
            })),
          }
        : null,
      /** pages are counted once per case, on first delivery (D-040) */
      pages: pages ? { processed: pages._sum.quantity ?? 0, cases: pages._count._all } : null,
      spend,
    });
  });

  r.use('/dashboards', requireInternal);

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

  r.get('/dashboards/finance', requirePermission('dashboard_finance', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const { days } = parse(FinanceRange, req.query);
    const org = billingOrgWhere(auth, 'dashboard_finance', 'view');
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);

    const [subs, plans, outstanding, overdue, payments] = await Promise.all([
      prisma.subscription.groupBy({ by: ['planId', 'status'], where: org, _count: { _all: true } }),
      prisma.subscriptionPlan.findMany({
        select: { id: true, priceMonthly: true, currency: true },
      }),
      prisma.invoice.groupBy({
        by: ['currency'],
        where: { ...org, status: { in: ['issued', 'overdue'] } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      prisma.invoice.groupBy({
        by: ['currency'],
        where: {
          ...org,
          OR: [{ status: 'overdue' }, { status: 'issued', dueAt: { lt: now } }],
        },
        _count: { _all: true },
        _sum: { total: true },
      }),
      // net of refunds, so a fully refunded payment counts as zero
      prisma.payment.findMany({
        where: {
          status: { in: ['succeeded', 'refunded'] },
          invoice: { ...org, paidAt: { gte: since } },
        },
        select: {
          amount: true,
          refundedAmount: true,
          currency: true,
          invoice: { select: { organizationId: true } },
        },
      }),
    ]);

    // MRR as on the finance overview (D-044): every subscription that isn't canceled, at its
    // plan's monthly price, per currency
    const mrr = new Map<string, bigint>();
    const mrrSubs = new Map<string, number>();
    for (const s of subs) {
      const plan = plans.find((p) => p.id === s.planId);
      if (!plan || s.status === 'canceled') continue;
      add(mrr, plan.currency, multiply(BigInt(s._count._all) * SCALE, toUnits(plan.priceMonthly)));
      mrrSubs.set(plan.currency, (mrrSubs.get(plan.currency) ?? 0) + s._count._all);
    }

    const perClient = new Map<string, { units: bigint; payments: number }>();
    const revenue = new Map<string, bigint>();
    for (const p of payments) {
      const net = toUnits(p.amount) - toUnits(p.refundedAmount);
      const key = `${p.currency}\u0000${p.invoice.organizationId}`;
      const row = perClient.get(key) ?? { units: 0n, payments: 0 };
      perClient.set(key, { units: row.units + net, payments: row.payments + 1 });
      add(revenue, p.currency, net);
    }
    const orgIds = [...new Set(payments.map((p) => p.invoice.organizationId))];
    const orgs = orgIds.length
      ? await prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];
    const clients = [...perClient]
      .map(([key, v]) => {
        const [currency, organizationId] = key.split('\u0000') as [string, string];
        return { currency, organizationId, ...v };
      })
      .sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) ||
          (b.units > a.units ? 1 : b.units < a.units ? -1 : 0),
      );
    const byClient: {
      organizationId: string | null;
      name: string | null;
      currency: string;
      amount: string;
      payments: number;
    }[] = [];
    for (const currency of new Set(clients.map((c) => c.currency))) {
      const rows = clients.filter((c) => c.currency === currency);
      for (const c of rows.slice(0, TOP_CLIENTS)) {
        byClient.push({
          organizationId: c.organizationId,
          name: orgs.find((o) => o.id === c.organizationId)?.name ?? null,
          currency,
          amount: formatUnits(c.units),
          payments: c.payments,
        });
      }
      const rest = rows.slice(TOP_CLIENTS);
      if (rest.length) {
        byClient.push({
          organizationId: null, // "other clients"
          name: null,
          currency,
          amount: formatUnits(rest.reduce((n, c) => n + c.units, 0n)),
          payments: rest.reduce((n, c) => n + c.payments, 0),
        });
      }
    }

    const money = (g: {
      currency: string;
      _count: { _all: number };
      _sum: { total: unknown };
    }) => ({
      currency: g.currency,
      count: g._count._all,
      amount: formatUnits(g._sum.total ? toUnits(String(g._sum.total)) : 0n),
    });
    res.json({
      days,
      mrr: byCurrency(mrr).map((m) => ({ ...m, subscriptions: mrrSubs.get(m.currency) ?? 0 })),
      subscriptions: SUBSCRIPTION_STATUSES.map((status) => ({
        status,
        count: subs.filter((s) => s.status === status).reduce((n, s) => n + s._count._all, 0),
      })),
      outstanding: outstanding.map(money).sort((a, b) => a.currency.localeCompare(b.currency)),
      overdue: overdue.map(money).sort((a, b) => a.currency.localeCompare(b.currency)),
      revenue: { total: byCurrency(revenue), byClient },
    });
  });

  return r;
}
