import { pagesInPeriod } from '@datascribe/billing';
import type {
  Invoice,
  InvoiceLine,
  Payment,
  PrismaClient,
  Subscription,
  SubscriptionPlan,
} from '@datascribe/db';
import type { Action, Module } from '@datascribe/shared';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../auth/context';
import { requireAuth } from '../../auth/middleware';
import { badRequest, forbidden, notFound } from '../../lib/errors';

/**
 * Org filter for firm-owned billing records (invoices, payments, subscriptions), from the union of
 * the caller's scopes. Client-org users are always pinned to their own firm (§4.4 rule 1).
 * `assigned` / `own` don't apply to billing records, so they grant nothing here.
 */
export function billingOrgWhere(
  auth: AuthContext,
  module: Module,
  action: Action,
): { organizationId?: string } {
  const scopes = new Set(
    auth.permissions.filter((p) => p.module === module && p.action === action).map((p) => p.scope),
  );
  const own = { organizationId: auth.user.organizationId };
  if (scopes.size === 0) throw forbidden();
  if (auth.user.orgType === 'client') {
    if (scopes.has('all') || scopes.has('firm')) return own;
    throw forbidden();
  }
  if (scopes.has('all')) return {};
  if (scopes.has('firm')) return own;
  throw forbidden();
}

/**
 * The firm a single-firm route acts on: client users → their own firm (asking for another is a
 * 404, so existence isn't leaked); staff with all-scope → the `organizationId` they pass.
 */
export function targetOrg(
  auth: AuthContext,
  module: Module,
  action: Action,
  requested: string | undefined,
): string {
  const where = billingOrgWhere(auth, module, action);
  if (where.organizationId) {
    if (requested && requested !== where.organizationId) throw notFound();
    return where.organizationId;
  }
  if (!requested) throw badRequest('organization_required', 'organizationId is required');
  return requested;
}

/** Datascribe-wide finance actions (plans, one-off invoices, refunds, billing runs). */
export function requireStaffAll(module: Module, action: Action): RequestHandler {
  return (req, _res, next) => {
    const auth = requireAuth(req);
    const ok =
      auth.user.orgType === 'internal' &&
      auth.permissions.some((p) => p.module === module && p.action === action && p.scope === 'all');
    if (!ok) throw forbidden();
    next();
  };
}

export const Id = z.string().trim().min(1).max(40);
export const Currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code');
export const Money = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v))
  .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Use an amount with up to 2 decimals');
export const UnitPrice = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(4) : v))
  .refine((v) => /^-?\d{1,8}(\.\d{1,4})?$/.test(v), 'Use a price with up to 4 decimals');

export const serializePlan = (p: SubscriptionPlan) => ({
  id: p.id,
  name: p.name,
  priceMonthly: p.priceMonthly.toFixed(2),
  currency: p.currency,
  includedPages: p.includedPages,
  overagePerPage: p.overagePerPage.toFixed(4),
  features: p.features,
  active: p.active,
  sortOrder: p.sortOrder,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Usage this period vs the plan limit (§5.3 usage meter). */
export async function usageSummary(
  prisma: PrismaClient,
  sub: Subscription & { plan: SubscriptionPlan },
) {
  const pagesUsed = await pagesInPeriod(
    prisma,
    sub.organizationId,
    sub.currentPeriodStart,
    sub.currentPeriodEnd,
  );
  const included = sub.plan.includedPages;
  return {
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
    pagesUsed,
    includedPages: included,
    overagePages: Math.max(0, pagesUsed - included),
    percentUsed: included > 0 ? Math.round((pagesUsed / included) * 100) : null,
  };
}

export const serializeSubscription = (s: Subscription & { plan: SubscriptionPlan }) => ({
  id: s.id,
  organizationId: s.organizationId,
  status: s.status,
  currentPeriodStart: s.currentPeriodStart,
  currentPeriodEnd: s.currentPeriodEnd,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  plan: serializePlan(s.plan),
});

export const serializeInvoice = (
  i: Invoice & { organization?: { id: string; name: string } | null },
) => ({
  id: i.id,
  organizationId: i.organizationId,
  organization: i.organization ? { id: i.organization.id, name: i.organization.name } : undefined,
  number: i.number,
  kind: i.kind,
  status: i.status,
  currency: i.currency,
  subtotal: i.subtotal.toFixed(2),
  taxLabel: i.taxLabel,
  taxRatePercent: i.taxRatePercent?.toFixed(2) ?? null,
  tax: i.tax.toFixed(2),
  total: i.total.toFixed(2),
  periodStart: i.periodStart,
  periodEnd: i.periodEnd,
  issuedAt: i.issuedAt,
  dueAt: i.dueAt,
  paidAt: i.paidAt,
  voidedAt: i.voidedAt,
  remindersSent: i.remindersSent,
  notes: i.notes,
  createdAt: i.createdAt,
});

export const serializeLine = (l: InvoiceLine) => ({
  id: l.id,
  description: l.description,
  quantity: l.quantity.toFixed(2),
  unitPrice: l.unitPrice.toFixed(4),
  amount: l.amount.toFixed(2),
});

export const serializePayment = (p: Payment) => ({
  id: p.id,
  invoiceId: p.invoiceId,
  gateway: p.gateway,
  gatewayRef: p.gatewayRef,
  amount: p.amount.toFixed(2),
  currency: p.currency,
  status: p.status,
  refundedAmount: p.refundedAmount.toFixed(2),
  refundedAt: p.refundedAt,
  receiptUrl: p.receiptUrl,
  createdAt: p.createdAt,
});

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
