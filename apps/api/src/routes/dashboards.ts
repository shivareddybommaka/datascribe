import { LEAD_STAGES } from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../auth/middleware';
import type { Deps } from '../context';
import { parse } from '../lib/validate';
import { requireInternal } from './crm/common';

const Range = z.object({
  /** leads created in the last N days count towards conversion and sources (default 90) */
  days: z.coerce.number().int().min(1).max(730).default(90),
});

/**
 * §5.9 dashboards (M9 part 2, D-092). Aggregates only: counts and sums, never lead rows, so a
 * dashboard grant shows no contact details. Sales first; ops, finance and client follow.
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

  return r;
}
