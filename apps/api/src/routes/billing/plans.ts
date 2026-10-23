import { Prisma } from '@datascribe/db';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../../auth/middleware';
import type { Deps } from '../../context';
import { conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Currency, Money, requireStaffAll, serializePlan } from './common';

const OveragePrice = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(4) : v))
  .refine((v) => /^\d{1,8}(\.\d{1,4})?$/.test(v), 'Use a price with up to 4 decimals');

const PlanBody = z.object({
  name: z.string().trim().min(1).max(80),
  priceMonthly: Money,
  currency: Currency.default('USD'),
  includedPages: z.number().int().min(0).max(10_000_000),
  overagePerPage: OveragePrice,
  features: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

/**
 * §5.6 plans, managed by finance / super_admin (subscriptions:create|edit at all scope, staff only).
 * Any signed-in user may list active plans (they are public prices: the pricing page shows them).
 * Plans are deactivated rather than deleted, because subscriptions and invoices reference them.
 */
export function plansRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/plans', authenticate(deps));

  r.get('/plans', async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(z.object({ includeInactive: z.enum(['true', 'false']).optional() }), req.query);
    const mayManage =
      auth.user.orgType === 'internal' &&
      auth.permissions.some((p) => p.module === 'subscriptions' && p.action === 'edit');
    const plans = await prisma.subscriptionPlan.findMany({
      where: q.includeInactive === 'true' && mayManage ? {} : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ items: plans.map(serializePlan) });
  });

  r.post('/plans', requireStaffAll('subscriptions', 'create'), async (req, res) => {
    const body = parse(PlanBody, req.body);
    try {
      const plan = await prisma.subscriptionPlan.create({ data: body });
      await req.audit({
        action: 'plan.create',
        entity: 'SubscriptionPlan',
        entityId: plan.id,
        metadata: { priceMonthly: body.priceMonthly, currency: body.currency },
      });
      res.status(201).json(serializePlan(plan));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('duplicate_plan', 'A plan with that name already exists');
      }
      throw err;
    }
  });

  r.patch('/plans/:id', requireStaffAll('subscriptions', 'edit'), async (req, res) => {
    const body = parse(PlanBody.partial().strict(), req.body);
    const id = String(req.params.id);
    const before = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!before) throw notFound();
    try {
      const plan = await prisma.subscriptionPlan.update({ where: { id }, data: body });
      await req.audit({
        action: 'plan.update',
        entity: 'SubscriptionPlan',
        entityId: id,
        metadata: {
          fields: Object.keys(body),
          ...(body.priceMonthly ? { from: before.priceMonthly.toFixed(2), to: body.priceMonthly } : {}),
        },
      });
      res.json(serializePlan(plan));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('duplicate_plan', 'A plan with that name already exists');
      }
      throw err;
    }
  });

  return r;
}
