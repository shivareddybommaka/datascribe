import { Prisma, type InvoiceKind, type PrismaClient } from '@datascribe/db';
import { reminderDue, reminderEmail } from './dunning';
import type { GatewayEvent, GatewayName, PaymentGateway } from './gateway/types';
import {
  addDays,
  addMonths,
  buildInvoice,
  buildSubscriptionInvoice,
  startOfUtcDay,
  type LineInput,
  type TaxRule,
} from './invoice';
import { formatUnits, sum, toUnits } from './money';
import { renderInvoicePdf, type CompanyDetails } from './pdf';
import { invoicePdfKey, type ObjectStore } from './storage';

type Db = PrismaClient | Prisma.TransactionClient;

export const PAGES_METRIC = 'pages_processed';

/** Business-rule failures; the API maps `status` straight onto the HTTP response. */
export class BillingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export interface Mailer {
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// ─────────────────────────── Settings ───────────────────────────

export interface BillingSettings {
  company: CompanyDetails;
  /** default tax rule */
  tax: TaxRule;
  /** per-currency overrides, e.g. { INR: { label: "GST", ratePercent: "18" } } */
  taxByCurrency: Record<string, TaxRule>;
  invoicePrefix: string;
  paymentTermsDays: number;
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const rate = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n.toFixed(2) : '0.00';
};

/**
 * Reads Setting "company" (seeded in M0; edited in the M2 admin settings screen). Missing keys
 * fall back to safe defaults: tax 0%, prefix INV, 14-day terms.
 */
export async function getBillingSettings(prisma: Db): Promise<BillingSettings> {
  const row = await prisma.setting.findUnique({ where: { key: 'company' } });
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const byCurrency: Record<string, TaxRule> = {};
  if (v.taxByCurrency && typeof v.taxByCurrency === 'object') {
    for (const [cur, rule] of Object.entries(v.taxByCurrency as Record<string, unknown>)) {
      const r = (rule ?? {}) as Record<string, unknown>;
      byCurrency[cur.toUpperCase()] = {
        label: str(r.label, 'Tax'),
        ratePercent: rate(r.ratePercent),
      };
    }
  }
  const terms = Number(v.paymentTermsDays);
  return {
    company: {
      name: str(v.name, 'Datascribe'),
      address: str(v.address, ''),
      email: str(v.email, '') || undefined,
      taxId: str(v.taxId, '') || undefined,
    },
    tax: { label: str(v.taxLabel, 'Tax'), ratePercent: rate(v.taxRatePercent) },
    taxByCurrency: byCurrency,
    invoicePrefix: /^[A-Z0-9]{1,10}$/.test(str(v.invoicePrefix, ''))
      ? str(v.invoicePrefix, '')
      : 'INV',
    paymentTermsDays: Number.isInteger(terms) && terms >= 0 && terms <= 120 ? terms : 14,
  };
}

export const taxFor = (s: BillingSettings, currency: string): TaxRule =>
  s.taxByCurrency[currency.toUpperCase()] ?? s.tax;

// ─────────────────────────── Numbering ───────────────────────────

/**
 * Gap-free sequential number from the Counter table (D-009). Must run inside the transaction
 * that creates the invoice: the row lock serialises concurrent issuers, and a rollback also
 * rolls the counter back, so numbers never skip.
 */
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  prefix: string,
  year: number,
): Promise<string> {
  const key = `invoice:${prefix}:${year}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("key", "value", "updatedAt") VALUES (${key}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1, "updatedAt" = now()
    RETURNING "value"`;
  return `${prefix}-${year}-${String(rows[0]!.value).padStart(5, '0')}`;
}

// ─────────────────────────── Usage ───────────────────────────

const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const;

export async function currentSubscription(prisma: Db, organizationId: string) {
  return prisma.subscription.findFirst({
    where: { organizationId, status: { in: [...LIVE_STATUSES] } },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Record pages processed for a case (§5.6). Called by M6 delivery. Idempotent per case: a case's
 * pages count once, on first delivery (D-040). Usage is filed under the billing period that
 * contains `at` (the subscription's current period, or the calendar month without one).
 */
export async function recordUsage(
  prisma: PrismaClient,
  input: { organizationId: string; caseId?: string | null; pages: number; at?: Date },
): Promise<{ id: string; created: boolean; periodStart: Date }> {
  if (!Number.isInteger(input.pages) || input.pages < 0 || input.pages > 1_000_000) {
    throw new BillingError(400, 'invalid_pages', 'pages must be a whole number 0–1,000,000');
  }
  const at = input.at ?? new Date();
  if (input.caseId) {
    const c = await prisma.case.findUnique({ where: { id: input.caseId } });
    if (!c || c.organizationId !== input.organizationId) {
      throw new BillingError(400, 'invalid_case', 'Case does not belong to this organization');
    }
  }
  const sub = await currentSubscription(prisma, input.organizationId);
  const periodStart =
    sub && at >= sub.currentPeriodStart && at < sub.currentPeriodEnd
      ? sub.currentPeriodStart
      : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  try {
    const row = await prisma.usageRecord.create({
      data: {
        organizationId: input.organizationId,
        caseId: input.caseId ?? null,
        metric: PAGES_METRIC,
        quantity: input.pages,
        periodStart,
      },
    });
    return { id: row.id, created: true, periodStart };
  } catch (err) {
    if (!isUniqueViolation(err) || !input.caseId) throw err;
    const existing = await prisma.usageRecord.findUniqueOrThrow({
      where: { caseId_metric: { caseId: input.caseId, metric: PAGES_METRIC } },
    });
    return { id: existing.id, created: false, periodStart: existing.periodStart };
  }
}

/** Pages filed under periods starting in [start, end). */
export async function pagesInPeriod(
  prisma: Db,
  organizationId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const agg = await prisma.usageRecord.aggregate({
    where: { organizationId, metric: PAGES_METRIC, periodStart: { gte: start, lt: end } },
    _sum: { quantity: true },
  });
  return agg._sum.quantity ?? 0;
}

// ─────────────────────────── Subscriptions ───────────────────────────

/**
 * Switch plan now (§5.3 upgrade/downgrade). The period invoice uses the plan in force at the end
 * of the period (no proration in v1, D-040). Creates the subscription if the firm has none.
 */
export async function changePlan(
  prisma: PrismaClient,
  input: { organizationId: string; planId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
    if (!org || org.type !== 'client') throw new BillingError(404, 'not_found', 'Not found');
    const plan = await tx.subscriptionPlan.findUnique({ where: { id: input.planId } });
    if (!plan || !plan.active) {
      throw new BillingError(400, 'invalid_plan', 'Plan does not exist or is not active');
    }
    if (plan.currency !== org.currency) {
      throw new BillingError(
        400,
        'currency_mismatch',
        `Plan is priced in ${plan.currency} but the firm is billed in ${org.currency}`,
      );
    }
    const existing = await currentSubscription(tx, org.id);
    const sub = existing
      ? await tx.subscription.update({
          where: { id: existing.id },
          data: { planId: plan.id, cancelAtPeriodEnd: false },
          include: { plan: true },
        })
      : await tx.subscription.create({
          data: {
            organizationId: org.id,
            planId: plan.id,
            status: 'active',
            currentPeriodStart: startOfUtcDay(now),
            currentPeriodEnd: addMonths(startOfUtcDay(now), 1),
          },
          include: { plan: true },
        });
    await tx.organization.update({ where: { id: org.id }, data: { planId: plan.id } });
    return { subscription: sub, previousPlanId: existing?.planId ?? null };
  });
}

export async function setCancelAtPeriodEnd(
  prisma: PrismaClient,
  input: { organizationId: string; cancel: boolean },
) {
  const sub = await currentSubscription(prisma, input.organizationId);
  if (!sub) throw new BillingError(404, 'no_subscription', 'This firm has no active subscription');
  return prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: input.cancel },
    include: { plan: true },
  });
}

// ─────────────────────────── Invoices ───────────────────────────

export interface CreateInvoiceInput {
  organizationId: string;
  currency: string;
  kind: InvoiceKind;
  lines: LineInput[];
  subscriptionId?: string;
  periodStart?: Date;
  periodEnd?: Date;
  notes?: string | null;
  createdById?: string | null;
  dueDays?: number;
  now?: Date;
}

/** Create an issued invoice with its number, lines and tax line. Call inside a transaction. */
export async function createInvoiceTx(
  tx: Prisma.TransactionClient,
  settings: BillingSettings,
  input: CreateInvoiceInput,
) {
  const now = input.now ?? new Date();
  const built = buildInvoice(input.lines, taxFor(settings, input.currency), input.currency);
  const number = await nextInvoiceNumber(tx, settings.invoicePrefix, now.getUTCFullYear());
  return tx.invoice.create({
    data: {
      organizationId: input.organizationId,
      number,
      status: 'issued',
      kind: input.kind,
      subscriptionId: input.subscriptionId ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      currency: input.currency,
      subtotal: built.subtotal,
      taxLabel: built.taxLabel,
      taxRatePercent: built.taxRatePercent,
      tax: built.tax,
      total: built.total,
      issuedAt: now,
      dueAt: addDays(startOfUtcDay(now), input.dueDays ?? settings.paymentTermsDays),
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      lines: { create: built.lines },
    },
    include: { lines: true },
  });
}

/** One-off invoice issued manually by finance (§5.6). Currency defaults to the firm's. */
export async function createOneOffInvoice(
  prisma: PrismaClient,
  input: Omit<CreateInvoiceInput, 'kind' | 'currency'> & { currency?: string },
) {
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  if (!org || org.type !== 'client') throw new BillingError(404, 'not_found', 'Not found');
  const settings = await getBillingSettings(prisma);
  try {
    return await prisma.$transaction((tx) =>
      createInvoiceTx(tx, settings, {
        ...input,
        kind: 'one_off',
        currency: input.currency ?? org.currency,
      }),
    );
  } catch (err) {
    if (err instanceof RangeError) throw new BillingError(400, 'invalid_invoice', err.message);
    throw err;
  }
}

/** PDF for an invoice: from the store, or rendered (and stored) on first request. */
export async function invoicePdf(prisma: PrismaClient, store: ObjectStore, invoiceId: string) {
  const inv = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: { orderBy: { createdAt: 'asc' } }, organization: true },
  });
  const key = inv.pdfS3Key ?? invoicePdfKey(inv.organizationId, inv.number);
  const cached = inv.pdfS3Key ? await store.get(key) : null;
  if (cached) return { key, bytes: cached, number: inv.number };

  const settings = await getBillingSettings(prisma);
  const bytes = await renderInvoicePdf({
    company: settings.company,
    billTo: { name: inv.organization.name },
    number: inv.number,
    status: inv.status,
    currency: inv.currency,
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    lines: inv.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity.toFixed(2),
      unitPrice: l.unitPrice.toFixed(4),
      amount: l.amount.toFixed(2),
    })),
    subtotal: inv.subtotal.toFixed(2),
    taxLabel: inv.taxLabel ?? settings.tax.label,
    taxRatePercent: inv.taxRatePercent?.toFixed(2) ?? '0.00',
    tax: inv.tax.toFixed(2),
    total: inv.total.toFixed(2),
    notes: inv.notes,
  });
  await store.put(key, bytes, 'application/pdf');
  if (!inv.pdfS3Key)
    await prisma.invoice.update({ where: { id: inv.id }, data: { pdfS3Key: key } });
  return { key, bytes, number: inv.number };
}

export async function voidInvoice(prisma: PrismaClient, invoiceId: string, now = new Date()) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: { where: { status: 'succeeded' } } },
  });
  if (!inv) throw new BillingError(404, 'not_found', 'Not found');
  if (!['draft', 'issued', 'overdue'].includes(inv.status) || inv.payments.length > 0) {
    throw new BillingError(409, 'not_voidable', `A ${inv.status} invoice cannot be voided`);
  }
  // pdf is regenerated so the stored copy shows the new status
  return prisma.invoice.update({
    where: { id: inv.id },
    data: { status: 'void', voidedAt: now, pdfS3Key: null },
  });
}

// ─────────────────────────── Monthly job ───────────────────────────

export interface PlanPricing {
  name: string;
  priceMonthly: string;
  includedPages: number;
  overagePerPage: string;
}

/**
 * A firm's custom pricing (Organization.settings.customPricing, set in the M2 admin console,
 * D-062) replaces the plan's fee, included pages and overage price. Malformed values are ignored.
 */
export function effectivePlanPricing(plan: PlanPricing, orgSettings: unknown): PlanPricing {
  const cp = (orgSettings as { customPricing?: Record<string, unknown> | null } | null)
    ?.customPricing;
  if (!cp) return plan;
  const price = String(cp.priceMonthly ?? '');
  const overage = String(cp.overagePerPage ?? '');
  const pages = cp.includedPages;
  if (
    !/^\d{1,10}(\.\d{1,2})?$/.test(price) ||
    !/^\d{1,10}(\.\d{1,4})?$/.test(overage) ||
    !Number.isInteger(pages) ||
    (pages as number) < 0
  ) {
    return plan;
  }
  return {
    name: `${plan.name} (custom pricing)`,
    priceMonthly: Number(price).toFixed(2),
    includedPages: pages as number,
    overagePerPage: Number(overage).toFixed(4),
  };
}

export interface InvoicingResult {
  invoiceIds: string[];
  periodsClosed: number;
  canceled: number;
}

/**
 * The monthly invoicing run (§5.6), executed by the worker's repeatable job. For every live
 * subscription whose period has ended: plan fee + overage invoice, then roll the period forward
 * (or cancel, if cancel-at-period-end). Each period is one transaction; the unique
 * (subscriptionId, periodStart) index makes re-runs and concurrent runs harmless.
 */
export async function runMonthlyInvoicing(
  prisma: PrismaClient,
  opts: { now?: Date; store?: ObjectStore; log?: Log } = {},
): Promise<InvoicingResult> {
  const now = opts.now ?? new Date();
  const settings = await getBillingSettings(prisma);
  const result: InvoicingResult = { invoiceIds: [], periodsClosed: 0, canceled: 0 };
  const due = await prisma.subscription.findMany({
    where: { status: { in: [...LIVE_STATUSES] }, currentPeriodEnd: { lte: now } },
    select: { id: true },
  });

  for (const { id } of due) {
    // catch up period by period (e.g. the worker was down for two months)
    for (let guard = 0; guard < 24; guard++) {
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { id },
        include: { plan: true, organization: true },
      });
      if (!LIVE_STATUSES.includes(sub.status as never) || sub.currentPeriodEnd > now) break;
      const { currentPeriodStart: start, currentPeriodEnd: end } = sub;
      const pages = await pagesInPeriod(prisma, sub.organizationId, start, end);
      const built = buildSubscriptionInvoice({
        plan: effectivePlanPricing(
          {
            name: sub.plan.name,
            priceMonthly: sub.plan.priceMonthly.toFixed(2),
            includedPages: sub.plan.includedPages,
            overagePerPage: sub.plan.overagePerPage.toFixed(4),
          },
          sub.organization.settings,
        ),
        pagesUsed: pages,
        periodStart: start,
        periodEnd: end,
        tax: taxFor(settings, sub.organization.currency),
        currency: sub.organization.currency,
      });
      try {
        const invoice = await prisma.$transaction(async (tx) => {
          // claim the period: only one runner moves it forward
          const moved = await tx.subscription.updateMany({
            where: { id, currentPeriodStart: start },
            data: sub.cancelAtPeriodEnd
              ? { status: 'canceled' }
              : { currentPeriodStart: end, currentPeriodEnd: addMonths(end, 1) },
          });
          if (moved.count === 0) return null;
          return createInvoiceTx(tx, settings, {
            organizationId: sub.organizationId,
            currency: sub.organization.currency,
            kind: 'subscription',
            subscriptionId: id,
            periodStart: start,
            periodEnd: end,
            lines: built.lines,
            now,
          });
        });
        if (!invoice) continue;
        result.invoiceIds.push(invoice.id);
        result.periodsClosed += 1;
        if (sub.cancelAtPeriodEnd) {
          result.canceled += 1;
          await prisma.organization.update({
            where: { id: sub.organizationId },
            data: { planId: null },
          });
        }
        opts.log?.info(
          { subscriptionId: id, invoiceId: invoice.id, pages, overagePages: built.overagePages },
          'subscription invoice issued',
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        opts.log?.warn({ subscriptionId: id }, 'period already invoiced by another run');
      }
    }
  }

  if (opts.store) {
    for (const invoiceId of result.invoiceIds) await invoicePdf(prisma, opts.store, invoiceId);
  }
  return result;
}

// ─────────────────────────── Payments ───────────────────────────

export type ApplyResult =
  | { outcome: 'recorded'; paymentId: string; invoicePaid: boolean }
  | { outcome: 'duplicate'; paymentId: string }
  | { outcome: 'ignored'; reason: string };

/** Net amount received on an invoice: succeeded payments minus refunds. */
async function netPaid(tx: Db, invoiceId: string): Promise<bigint> {
  const payments = await tx.payment.findMany({
    where: { invoiceId, status: { in: ['succeeded', 'refunded'] } },
  });
  return sum(payments.map((p) => toUnits(p.amount) - toUnits(p.refundedAmount)));
}

/**
 * Apply a verified webhook event. Idempotent: Payment is unique on (gateway, gatewayRef), so a
 * redelivered event finds its row and changes nothing.
 */
export async function applyGatewayEvent(
  prisma: PrismaClient,
  gateway: GatewayName,
  event: GatewayEvent,
  now = new Date(),
): Promise<ApplyResult & { organizationId?: string; invoiceId?: string }> {
  if (event.kind === 'ignored') return { outcome: 'ignored', reason: event.type };
  const invoice = await prisma.invoice.findUnique({ where: { id: event.invoiceId } });
  if (!invoice) return { outcome: 'ignored', reason: 'unknown_invoice' };
  const ids = { organizationId: invoice.organizationId, invoiceId: invoice.id };

  try {
    return await prisma.$transaction(async (tx) => {
      const key = { gateway_gatewayRef: { gateway, gatewayRef: event.gatewayRef } };
      const existing = await tx.payment.findUnique({ where: key });
      if (existing && existing.status !== 'pending' && existing.status !== 'failed') {
        return { outcome: 'duplicate' as const, paymentId: existing.id, ...ids };
      }
      if (existing && event.kind === 'payment_failed') {
        return { outcome: 'duplicate' as const, paymentId: existing.id, ...ids };
      }
      const status = event.kind === 'payment_succeeded' ? 'succeeded' : 'failed';
      const data = {
        amount: event.amount,
        currency: event.currency,
        status,
        receiptUrl: event.receiptUrl ?? null,
      } as const;
      const payment = existing
        ? await tx.payment.update({ where: { id: existing.id }, data })
        : await tx.payment.create({
            data: { ...data, invoiceId: invoice.id, gateway, gatewayRef: event.gatewayRef },
          });

      let invoicePaid = false;
      if (
        status === 'succeeded' &&
        event.currency === invoice.currency &&
        ['issued', 'overdue', 'draft'].includes(invoice.status) &&
        (await netPaid(tx, invoice.id)) >= toUnits(invoice.total)
      ) {
        await tx.invoice.update({
          where: { id: invoice.id },
          // pdf regenerated on next download so it shows "paid"
          data: { status: 'paid', paidAt: now, pdfS3Key: null },
        });
        invoicePaid = true;
      }
      return { outcome: 'recorded' as const, paymentId: payment.id, invoicePaid, ...ids };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // the same event raced in concurrently and the other delivery won
    const p = await prisma.payment.findUniqueOrThrow({
      where: { gateway_gatewayRef: { gateway, gatewayRef: event.gatewayRef } },
    });
    return { outcome: 'duplicate', paymentId: p.id, ...ids };
  }
}

/**
 * Refund all or part of a payment (§5.6, finance only). The gateway is called first; the row is
 * then updated with a compare-and-set on refundedAmount so two refunds can't both apply.
 */
export async function refundPayment(
  prisma: PrismaClient,
  gateway: PaymentGateway,
  input: { paymentId: string; amount?: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    include: { invoice: true },
  });
  if (!payment) throw new BillingError(404, 'not_found', 'Not found');
  if (payment.status !== 'succeeded') {
    throw new BillingError(409, 'not_refundable', `A ${payment.status} payment cannot be refunded`);
  }
  if (payment.gateway !== gateway.name) {
    throw new BillingError(
      409,
      'gateway_mismatch',
      `Payment was taken by ${payment.gateway}; the active gateway is ${gateway.name}`,
    );
  }
  const remaining = toUnits(payment.amount) - toUnits(payment.refundedAmount);
  const amount = input.amount === undefined ? remaining : toUnits(input.amount);
  if (amount <= 0n || amount > remaining) {
    throw new BillingError(
      400,
      'invalid_amount',
      `Refund must be between 0.01 and ${formatUnits(remaining)} ${payment.currency}`,
    );
  }

  const refund = await gateway.refund({
    gatewayRef: payment.gatewayRef,
    amount: formatUnits(amount),
    currency: payment.currency,
  });

  const refunded = toUnits(payment.refundedAmount) + amount;
  const full = refunded === toUnits(payment.amount);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, refundedAmount: payment.refundedAmount },
      data: {
        refundedAmount: formatUnits(refunded),
        refundedAt: now,
        ...(full ? { status: 'refunded' } : {}),
      },
    });
    if (updated.count === 0) {
      throw new BillingError(409, 'conflict', 'Payment changed during refund; reload and retry');
    }
    let invoiceStatus = payment.invoice.status;
    if (payment.invoice.status === 'paid' && (await netPaid(tx, payment.invoiceId)) <= 0n) {
      invoiceStatus = 'refunded';
      await tx.invoice.update({
        where: { id: payment.invoiceId },
        data: { status: 'refunded', pdfS3Key: null },
      });
    }
    const row = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return {
      payment: row,
      refund,
      amount: formatUnits(amount),
      invoiceStatus,
      organizationId: payment.invoice.organizationId,
    };
  });
}

// ─────────────────────────── Dunning ───────────────────────────

/**
 * Dunning (§5.6): reminders to the firm's client admins at the due date, +7 and +14 days. Unpaid
 * invoices past their due date become `overdue`. A reminder is claimed (compare-and-set on
 * remindersSent) before it is sent, so concurrent runs never email twice.
 */
export async function runDunning(
  prisma: PrismaClient,
  mailer: Mailer,
  opts: { now?: Date; appUrl: string; log?: Log },
): Promise<{ remindersSent: number; emails: number; markedOverdue: number }> {
  const now = opts.now ?? new Date();
  const overdue = await prisma.invoice.updateMany({
    where: { status: 'issued', dueAt: { lt: startOfUtcDay(now) } },
    data: { status: 'overdue' },
  });

  const candidates = await prisma.invoice.findMany({
    where: {
      status: { in: ['issued', 'overdue'] },
      dueAt: { lt: addDays(startOfUtcDay(now), 1) },
      remindersSent: { lt: 3 },
    },
    include: { organization: true },
  });

  let remindersSent = 0;
  let emails = 0;
  for (const inv of candidates) {
    const due = reminderDue({ dueAt: inv.dueAt!, remindersSent: inv.remindersSent }, now);
    if (!due) continue;
    const claimed = await prisma.invoice.updateMany({
      where: { id: inv.id, remindersSent: inv.remindersSent },
      data: { remindersSent: due.remindersSent, lastReminderAt: now },
    });
    if (claimed.count === 0) continue;
    remindersSent += 1;

    const admins = await prisma.user.findMany({
      where: {
        organizationId: inv.organizationId,
        status: 'active',
        roles: { some: { role: { key: 'client_admin' } } },
      },
      select: { email: true },
    });
    const mail = reminderEmail({
      stage: due.stage,
      number: inv.number,
      total: inv.total.toFixed(2),
      currency: inv.currency,
      dueAt: inv.dueAt!,
      organizationName: inv.organization.name,
      payUrl: `${opts.appUrl}/portal/billing/invoices/${inv.id}`,
    });
    for (const a of admins) {
      try {
        await mailer.send({ to: a.email, ...mail });
        emails += 1;
      } catch (err) {
        opts.log?.warn({ invoiceId: inv.id, err: (err as Error).name }, 'dunning email failed');
      }
    }
    opts.log?.info({ invoiceId: inv.id, stage: due.stage, recipients: admins.length }, 'dunning');
  }
  return { remindersSent, emails, markedOverdue: overdue.count };
}
