import { currentSubscription } from '@datascribe/billing';
import type { Prisma } from '@datascribe/db';
import { broadestScope } from '@datascribe/shared';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../auth/middleware';
import { caseScopeWhere } from '../auth/scoping';
import type { Deps } from '../context';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { CLOSED_STATUSES } from '../services/cases';
import { serializeInvoice, usageSummary } from './billing/common';

/** Portal-only routes are for users of client firms; staff use the console. */
const requireClientOrg: RequestHandler = (req, _res, next) => {
  if (requireAuth(req).user.orgType !== 'client') {
    throw forbidden('This is part of the client portal');
  }
  next();
};

/**
 * §5.3 client portal: dashboard and the client_admin's light firm management (profile, MFA
 * policy, pending invites). Firm users are listed via /admin/users (firm-scoped) and invited via
 * POST /invites; staff-side organisation admin is M2.
 */
export function portalRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use(['/portal', '/firm'], authenticate(deps), requireClientOrg);

  r.get('/portal/dashboard', requirePermission('cases', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const has = (module: Parameters<typeof broadestScope>[1]) =>
      !!broadestScope(auth.permissions, module, 'view');
    const orgId = auth.user.organizationId;

    const byStatus = await prisma.case.groupBy({
      by: ['status'],
      where: {
        AND: [caseScopeWhere(auth, 'cases', 'view'), { status: { notIn: [...CLOSED_STATUSES] } }],
      },
      _count: { _all: true },
    });

    const deliverables = has('deliverables')
      ? await prisma.deliverable.findMany({
          where: {
            status: 'delivered',
            case: { is: caseScopeWhere(auth, 'deliverables', 'view') },
          },
          include: { case: { select: { id: true, number: true, matterName: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 5,
        })
      : [];

    let usage = null;
    if (has('subscriptions')) {
      const sub = await currentSubscription(prisma, orgId);
      if (sub) {
        usage = {
          plan: { id: sub.plan.id, name: sub.plan.name },
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          ...(await usageSummary(prisma, sub)),
        };
      }
    }

    let invoices = null;
    if (has('invoices')) {
      const where: Prisma.InvoiceWhereInput = {
        organizationId: orgId,
        status: { in: ['issued', 'overdue'] },
      };
      const [items, totals] = await Promise.all([
        prisma.invoice.findMany({ where, orderBy: { dueAt: 'asc' }, take: 5 }),
        prisma.invoice.groupBy({
          by: ['currency'],
          where,
          _sum: { total: true },
          _count: { _all: true },
        }),
      ]);
      invoices = {
        items: items.map(serializeInvoice),
        outstanding: totals.map((t) => ({
          currency: t.currency,
          count: t._count._all,
          total: (t._sum.total ?? 0).toFixed(2),
        })),
      };
    }

    res.json({
      openCases: byStatus
        .map((g) => ({ status: g.status, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      recentDeliverables: deliverables.map((d) => ({
        id: d.id,
        type: d.type,
        version: d.version,
        deliveredAt: d.updatedAt,
        case: d.case,
      })),
      usage,
      invoices,
    });
  });

  // ── Firm profile + MFA policy (client_admin) ──────────────────────────
  const firmView = async (organizationId: string) => {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        plan: { select: { id: true, name: true } },
        _count: { select: { users: true } },
      },
    });
    if (!org) throw notFound();
    const settings = (org.settings ?? {}) as { enforceMfa?: boolean };
    return {
      id: org.id,
      name: org.name,
      status: org.status,
      currency: org.currency,
      plan: org.plan,
      userCount: org._count.users,
      enforceMfa: settings.enforceMfa === true,
    };
  };

  r.get('/firm', requirePermission('users', 'view'), async (req, res) => {
    res.json(await firmView(requireAuth(req).user.organizationId));
  });

  r.patch('/firm', requirePermission('users', 'edit'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(2).max(200).optional(),
          enforceMfa: z.boolean().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
      req.body,
    );
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: auth.user.organizationId },
    });
    const settings = { ...((org.settings ?? {}) as Record<string, unknown>) };
    if (body.enforceMfa !== undefined) settings.enforceMfa = body.enforceMfa;
    await prisma.organization.update({
      where: { id: org.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        settings: settings as Prisma.InputJsonValue,
      },
    });
    await req.audit({
      action: 'organization.update',
      entity: 'Organization',
      entityId: org.id,
      organizationId: org.id,
      metadata: {
        fields: Object.keys(body).sort(),
        ...(body.enforceMfa !== undefined ? { enforceMfa: body.enforceMfa } : {}),
      },
    });
    res.json(await firmView(org.id));
  });

  r.get('/firm/invites', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const invites = await prisma.invite.findMany({
      where: {
        organizationId: auth.user.organizationId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { role: { select: { key: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({
      items: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    });
  });

  return r;
}
