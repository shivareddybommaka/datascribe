import type { Prisma } from '@datascribe/db';
import { broadestScope, type Action } from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../auth/context';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { Pagination, requireInternal } from '../crm/common';

/** Org settings JSON (schema.prisma Organization.settings) as the admin console edits it. */
export interface OrgSettings {
  enforceMfa?: boolean;
  /** delete source documents this many days after a case is closed (§10, default 180) */
  retentionDays?: number;
  /** replaces the plan's price/limits for this firm in monthly invoicing (D-062) */
  customPricing?: { priceMonthly: string; includedPages: number; overagePerPage: string } | null;
}

export const DEFAULT_RETENTION_DAYS = 180;

const orgInclude = {
  plan: { select: { id: true, name: true, priceMonthly: true, currency: true } },
  _count: { select: { users: true } },
} satisfies Prisma.OrganizationInclude;

type OrgRow = Prisma.OrganizationGetPayload<{ include: typeof orgInclude }>;

function serializeOrg(org: OrgRow) {
  const s = (org.settings ?? {}) as OrgSettings;
  return {
    id: org.id,
    name: org.name,
    type: org.type,
    status: org.status,
    currency: org.currency,
    plan: org.plan
      ? { id: org.plan.id, name: org.plan.name, priceMonthly: org.plan.priceMonthly.toFixed(2) }
      : null,
    userCount: org._count.users,
    enforceMfa: s.enforceMfa === true,
    retentionDays: s.retentionDays ?? DEFAULT_RETENTION_DAYS,
    customPricing: s.customPricing ?? null,
    createdAt: org.createdAt,
  };
}

/**
 * Organisations are platform-level records: managed by internal staff holding `users:<action>`
 * at `all` scope (super_admin, ops_manager). Client admins edit their own firm via the portal (M4).
 */
function requireOrgAdmin(auth: AuthContext, action: Action) {
  if (broadestScope(auth.permissions, 'users', action) !== 'all') throw forbidden();
}

const Money = (decimals: number) =>
  z
    .union([z.number(), z.string().trim()])
    .transform((v) => String(v))
    .refine(
      (v) => new RegExp(`^\\d{1,10}(\\.\\d{1,${decimals}})?$`).test(v),
      `Use a positive amount with up to ${decimals} decimals`,
    );

const Patch = z
  .object({
    name: z.string().trim().min(2).max(200),
    status: z.enum(['active', 'suspended', 'closed']),
    planId: z.string().min(1).max(64).nullable(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'ISO-4217 code, e.g. USD'),
    enforceMfa: z.boolean(),
    retentionDays: z.number().int().min(30).max(3650),
    customPricing: z
      .object({
        priceMonthly: Money(2),
        includedPages: z.number().int().min(0).max(10_000_000),
        overagePerPage: Money(4),
      })
      .nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export function organizationsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/admin/organizations', authenticate(deps), requireInternal);

  r.get('/admin/organizations', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    requireOrgAdmin(auth, 'view');
    const q = parse(
      Pagination.extend({
        q: z.string().trim().min(1).max(100).optional(),
        status: z.enum(['active', 'suspended', 'closed']).optional(),
        type: z.enum(['client', 'internal']).optional(),
      }),
      req.query,
    );
    const where: Prisma.OrganizationWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        include: orgInclude,
        orderBy: [{ type: 'desc' }, { name: 'asc' }],
        take: q.limit,
        skip: q.offset,
      }),
      prisma.organization.count({ where }),
    ]);
    res.json({ total, items: items.map(serializeOrg) });
  });

  r.get('/admin/organizations/:id', requirePermission('users', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    requireOrgAdmin(auth, 'view');
    const org = await prisma.organization.findUnique({
      where: { id: String(req.params.id) },
      include: orgInclude,
    });
    if (!org) throw notFound();
    const subscription = await prisma.subscription.findFirst({
      where: { organizationId: org.id, status: { not: 'canceled' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        plan: { select: { id: true, name: true } },
      },
    });
    res.json({ ...serializeOrg(org), subscription });
  });

  /** Apply a validated patch; shared by PATCH and the suspend/reactivate shortcuts. */
  async function update(req: Request, id: string, body: z.infer<typeof Patch>) {
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) throw notFound();
    if (body.status && body.status !== 'active' && org.type === 'internal') {
      throw forbidden('The Datascribe organisation cannot be suspended');
    }
    if (body.planId) {
      const plan = await prisma.subscriptionPlan.findUnique({ where: { id: body.planId } });
      if (!plan) throw badRequest('unknown_plan', 'Unknown plan');
    }
    const settings: OrgSettings = { ...((org.settings ?? {}) as OrgSettings) };
    if (body.enforceMfa !== undefined) settings.enforceMfa = body.enforceMfa;
    if (body.retentionDays !== undefined) settings.retentionDays = body.retentionDays;
    if (body.customPricing !== undefined) settings.customPricing = body.customPricing;

    const updated = await prisma.organization.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        settings: settings as Prisma.InputJsonValue,
      },
      include: orgInclude,
    });

    // Suspending ends every session in the firm at once (logins are already refused).
    let sessionsRevoked = 0;
    const suspended = body.status && body.status !== 'active' && org.status === 'active';
    if (suspended) {
      ({ count: sessionsRevoked } = await prisma.session.updateMany({
        where: { user: { organizationId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      }));
    }
    const statusChanged = body.status !== undefined && body.status !== org.status;
    await req.audit({
      action: statusChanged
        ? body.status === 'active'
          ? 'admin.org.reactivated'
          : 'admin.org.suspended'
        : 'admin.org.updated',
      entity: 'Organization',
      entityId: id,
      organizationId: id,
      metadata: {
        fields: Object.keys(body).sort(),
        ...(statusChanged ? { from: org.status, to: body.status } : {}),
        ...(body.planId !== undefined ? { planId: body.planId } : {}),
        ...(suspended ? { sessionsRevoked } : {}),
      },
    });
    return serializeOrg(updated);
  }

  r.patch('/admin/organizations/:id', requirePermission('users', 'edit'), async (req, res) => {
    requireOrgAdmin(requireAuth(req), 'edit');
    res.json(await update(req, String(req.params.id), parse(Patch, req.body)));
  });

  r.post(
    '/admin/organizations/:id/suspend',
    requirePermission('users', 'edit'),
    async (req, res) => {
      requireOrgAdmin(requireAuth(req), 'edit');
      const org = await prisma.organization.findUnique({ where: { id: String(req.params.id) } });
      if (!org) throw notFound();
      if (org.status === 'suspended') throw badRequest('already_suspended', 'Already suspended');
      res.json(await update(req, org.id, { status: 'suspended' }));
    },
  );

  r.post(
    '/admin/organizations/:id/reactivate',
    requirePermission('users', 'edit'),
    async (req, res) => {
      requireOrgAdmin(requireAuth(req), 'edit');
      const org = await prisma.organization.findUnique({ where: { id: String(req.params.id) } });
      if (!org) throw notFound();
      if (org.status === 'active') throw badRequest('not_suspended', 'Organisation is active');
      res.json(await update(req, org.id, { status: 'active' }));
    },
  );

  return r;
}
