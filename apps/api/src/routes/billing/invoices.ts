import {
  createOneOffInvoice,
  invoicePdf,
  runDunning,
  runMonthlyInvoicing,
  voidInvoice,
} from '@datascribe/billing';
import type { Prisma } from '@datascribe/db';
import { notifyInvoicesIssued } from '@datascribe/db/notifications';
import type { Action } from '@datascribe/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth, requirePermission } from '../../auth/middleware';
import type { Deps } from '../../context';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { safeNotify } from '../../lib/notify';
import { parse } from '../../lib/validate';
import {
  Currency,
  Id,
  Pagination,
  UnitPrice,
  billingOrgWhere,
  requireStaffAll,
  serializeInvoice,
  serializeLine,
  serializePayment,
} from './common';

const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void', 'overdue', 'refunded'] as const;

const OneOffBody = z.object({
  organizationId: Id,
  currency: Currency.optional(),
  dueDays: z.number().int().min(0).max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        quantity: z
          .union([z.number(), z.string().trim()])
          .transform((v) => String(v))
          .refine(
            (v) => /^\d{1,8}(\.\d{1,2})?$/.test(v) && Number(v) > 0,
            'Quantity > 0, 2 decimals',
          ),
        unitPrice: UnitPrice,
      }),
    )
    .min(1)
    .max(50),
});

/** Runs the billing jobs on demand. `asOf` (simulate a later date) is refused in production. */
const RunBody = z.object({ asOf: z.string().datetime({ offset: true }).optional() });

/**
 * §5.6 / §9 invoices. View: invoices:view (client_admin own firm; finance, ops, sales all).
 * One-off create / void / runs: finance (all-scope staff). Pay: payments:create, which only
 * client_admin (own firm) and finance hold.
 */
export function invoicesRouter(deps: Deps): Router {
  const { prisma, env, gateway, store } = deps;
  const r = Router();
  r.use(['/invoices', '/billing'], authenticate(deps));

  /** Load an invoice the caller may act on, or 404 (other firms' invoices aren't leaked). */
  async function loadInvoice(req: Request, module: 'invoices' | 'payments', action: Action) {
    const auth = requireAuth(req);
    const inv = await prisma.invoice.findFirst({
      where: { id: String(req.params.id), ...billingOrgWhere(auth, module, action) },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!inv) throw notFound();
    return inv;
  }

  r.get('/invoices', requirePermission('invoices', 'view'), async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(
      Pagination.extend({
        status: z.enum(INVOICE_STATUSES).optional(),
        kind: z.enum(['subscription', 'one_off']).optional(),
        organizationId: Id.optional(),
        q: z.string().trim().min(1).max(40).optional(),
      }),
      req.query,
    );
    const where: Prisma.InvoiceWhereInput = {
      AND: [
        billingOrgWhere(auth, 'invoices', 'view'),
        q.organizationId ? { organizationId: q.organizationId } : {},
        q.status ? { status: q.status } : {},
        q.kind ? { kind: q.kind } : {},
        q.q ? { number: { contains: q.q, mode: 'insensitive' } } : {},
      ],
    };
    const [items, total, outstanding] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: { organization: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.groupBy({
        by: ['currency'],
        where: { AND: [where, { status: { in: ['issued', 'overdue'] } }] },
        _sum: { total: true },
        _count: true,
      }),
    ]);
    res.json({
      total,
      items: items.map(serializeInvoice),
      outstanding: outstanding.map((o) => ({
        currency: o.currency,
        count: o._count,
        total: (o._sum.total ?? 0).toFixed(2),
      })),
    });
  });

  r.get('/invoices/:id', requirePermission('invoices', 'view'), async (req, res) => {
    const inv = await loadInvoice(req, 'invoices', 'view');
    const auth = requireAuth(req);
    const [lines, payments] = await Promise.all([
      prisma.invoiceLine.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: 'asc' } }),
      auth.permissions.some((p) => p.module === 'payments' && p.action === 'view')
        ? prisma.payment.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: 'asc' } })
        : Promise.resolve([]),
    ]);
    res.json({
      ...serializeInvoice(inv),
      lines: lines.map(serializeLine),
      payments: payments.map(serializePayment),
    });
  });

  r.get('/invoices/:id/pdf', requirePermission('invoices', 'view'), async (req, res) => {
    const inv = await loadInvoice(req, 'invoices', 'view');
    const pdf = await invoicePdf(prisma, store, inv.id);
    res
      .status(200)
      .type('application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${pdf.number}.pdf"`)
      .setHeader('Cache-Control', 'private, no-store')
      .send(Buffer.from(pdf.bytes));
  });

  r.post('/invoices', requireStaffAll('invoices', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(OneOffBody, req.body);
    const inv = await createOneOffInvoice(prisma, { ...body, createdById: auth.user.id });
    await invoicePdf(prisma, store, inv.id);
    await req.audit({
      action: 'invoice.create',
      entity: 'Invoice',
      entityId: inv.id,
      organizationId: inv.organizationId,
      metadata: { number: inv.number, total: inv.total.toFixed(2), currency: inv.currency },
    });
    await safeNotify(deps.logger, 'invoice_issued', () => notifyInvoicesIssued(prisma, [inv.id]));
    res.status(201).json({ ...serializeInvoice(inv), lines: inv.lines.map(serializeLine) });
  });

  r.post('/invoices/:id/void', requireStaffAll('invoices', 'edit'), async (req, res) => {
    const body = parse(z.object({ reason: z.string().trim().min(1).max(500) }), req.body);
    const inv = await loadInvoice(req, 'invoices', 'edit');
    const updated = await voidInvoice(prisma, inv.id);
    await req.audit({
      action: 'invoice.void',
      entity: 'Invoice',
      entityId: inv.id,
      organizationId: inv.organizationId,
      metadata: { number: inv.number, reason: body.reason },
    });
    res.json(serializeInvoice(updated));
  });

  /** §5.6 pay: start a hosted checkout. The webhook, not this call, marks the invoice paid. */
  r.post('/invoices/:id/pay', requirePermission('payments', 'create'), async (req, res) => {
    const auth = requireAuth(req);
    const inv = await loadInvoice(req, 'payments', 'create');
    if (!['issued', 'overdue'].includes(inv.status)) {
      throw new HttpError(409, 'not_payable', `A ${inv.status} invoice cannot be paid`);
    }
    if (Number(inv.total) <= 0) throw badRequest('not_payable', 'Nothing to pay on this invoice');
    const base = `${env.APP_URL}/portal/billing/invoices/${inv.id}`;
    const session = await gateway.createCheckout({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      amount: inv.total.toFixed(2),
      currency: inv.currency,
      customerEmail: auth.user.email,
      successUrl: `${base}?paid=1`,
      cancelUrl: `${base}?canceled=1`,
    });
    await req.audit({
      action: 'invoice.checkout',
      entity: 'Invoice',
      entityId: inv.id,
      organizationId: inv.organizationId,
      metadata: { gateway: gateway.name, sessionId: session.id, amount: inv.total.toFixed(2) },
    });
    res.status(201).json({ gateway: gateway.name, sessionId: session.id, url: session.url });
  });

  function asOf(body: z.infer<typeof RunBody>): Date {
    if (!body.asOf) return new Date();
    if (env.NODE_ENV === 'production') {
      throw badRequest('as_of_not_allowed', 'asOf is only available outside production');
    }
    return new Date(body.asOf);
  }

  r.post('/billing/run-invoicing', requireStaffAll('invoices', 'create'), async (req, res) => {
    const now = asOf(parse(RunBody, req.body ?? {}));
    const result = await runMonthlyInvoicing(prisma, { now, store, log: req.log });
    await req.audit({
      action: 'billing.run_invoicing',
      entity: 'Invoice',
      metadata: { asOf: now.toISOString(), invoices: result.invoiceIds.length },
    });
    await safeNotify(deps.logger, 'invoice_issued', () =>
      notifyInvoicesIssued(prisma, result.invoiceIds),
    );
    res.json(result);
  });

  r.post('/billing/run-dunning', requireStaffAll('invoices', 'edit'), async (req, res) => {
    const now = asOf(parse(RunBody, req.body ?? {}));
    const result = await runDunning(prisma, deps.mailer, {
      now,
      appUrl: env.APP_URL,
      log: req.log,
    });
    await req.audit({
      action: 'billing.run_dunning',
      entity: 'Invoice',
      metadata: { asOf: now.toISOString(), ...result },
    });
    res.json(result);
  });

  return r;
}
