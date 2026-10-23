import {
  changePlan,
  currentSubscription,
  recordUsage,
  setCancelAtPeriodEnd,
} from '@datascribe/billing';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import {
  Id,
  Pagination,
  billingOrgWhere,
  requireStaffAll,
  serializeSubscription,
  targetOrg,
  usageSummary,
} from './common';

/**
 * §5.3 / §5.6 subscriptions. Read: subscriptions:view (client_admin own firm; finance, ops, sales
 * any). Change plan / cancel at period end: subscriptions:manage (client_admin own firm; finance
 * any). Manual usage entries: finance only.
 */
export function subscriptionsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use(['/subscriptions', '/usage'], authenticate(deps));

  r.get('/subscriptions/current', requirePermission('subscriptions', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(z.object({ organizationId: Id.optional() }), req.query);
    const orgId = targetOrg(auth, 'subscriptions', 'view', q.organizationId);
    const org = await prisma.organization.findFirst({ where: { id: orgId, type: 'client' } });
    if (!org) throw notFound();
    const sub = await currentSubscription(prisma, org.id);
    res.json({
      organization: { id: org.id, name: org.name, currency: org.currency },
      subscription: sub ? serializeSubscription(sub) : null,
      usage: sub ? await usageSummary(prisma, sub) : null,
    });
  });

  r.get('/subscriptions', requirePermission('subscriptions', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      Pagination.extend({
        status: z.enum(['trialing', 'active', 'past_due', 'canceled']).optional(),
      }),
      req.query,
    );
    const where = {
      ...billingOrgWhere(auth, 'subscriptions', 'view'),
      ...(q.status ? { status: q.status } : {}),
    };
    const [subs, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        include: { plan: true, organization: { select: { id: true, name: true } } },
        orderBy: { currentPeriodEnd: 'asc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.subscription.count({ where }),
    ]);
    res.json({
      total,
      items: await Promise.all(
        subs.map(async (s) => ({
          ...serializeSubscription(s),
          organization: s.organization,
          usage: await usageSummary(prisma, s),
        })),
      ),
    });
  });

  r.post(
    '/subscriptions/change',
    requirePermission('subscriptions', 'manage'),
    async (req, res) => {
      const auth = requireAuth(req);
      const body = parse(z.object({ organizationId: Id.optional(), planId: Id }), req.body);
      const orgId = targetOrg(auth, 'subscriptions', 'manage', body.organizationId);
      const { subscription, previousPlanId } = await changePlan(prisma, {
        organizationId: orgId,
        planId: body.planId,
      });
      await req.audit({
        action: 'subscription.change_plan',
        entity: 'Subscription',
        entityId: subscription.id,
        organizationId: orgId,
        metadata: { fromPlanId: previousPlanId, toPlanId: body.planId },
      });
      res.json({
        subscription: serializeSubscription(subscription),
        usage: await usageSummary(prisma, subscription),
      });
    },
  );

  r.post(
    '/subscriptions/cancel',
    requirePermission('subscriptions', 'manage'),
    async (req, res) => {
      const auth = requireAuth(req);
      const body = parse(
        z.object({ organizationId: Id.optional(), cancelAtPeriodEnd: z.boolean().default(true) }),
        req.body,
      );
      const orgId = targetOrg(auth, 'subscriptions', 'manage', body.organizationId);
      const sub = await setCancelAtPeriodEnd(prisma, {
        organizationId: orgId,
        cancel: body.cancelAtPeriodEnd,
      });
      await req.audit({
        action: body.cancelAtPeriodEnd ? 'subscription.cancel' : 'subscription.resume',
        entity: 'Subscription',
        entityId: sub.id,
        organizationId: orgId,
        metadata: { cancelAtPeriodEnd: body.cancelAtPeriodEnd, periodEnd: sub.currentPeriodEnd },
      });
      res.json({ subscription: serializeSubscription(sub) });
    },
  );

  /**
   * Manual usage entry (corrections, or pages processed outside the pipeline). Case deliveries
   * call recordUsage() directly from M6. Idempotent per case.
   */
  r.post('/usage', requireStaffAll('subscriptions', 'edit'), async (req, res) => {
    const body = parse(
      z.object({
        organizationId: Id,
        caseId: Id.optional(),
        pages: z.number().int().min(0).max(1_000_000),
      }),
      req.body,
    );
    const org = await prisma.organization.findFirst({
      where: { id: body.organizationId, type: 'client' },
    });
    if (!org) throw notFound();
    const usage = await recordUsage(prisma, body);
    await req.audit({
      action: 'usage.record',
      entity: 'UsageRecord',
      entityId: usage.id,
      organizationId: org.id,
      metadata: { pages: body.pages, caseId: body.caseId ?? null, created: usage.created },
    });
    res.status(usage.created ? 201 : 200).json(usage);
  });

  return r;
}
