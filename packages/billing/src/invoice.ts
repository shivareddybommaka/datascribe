import { formatUnits, multiply, percentOf, sum, toUnits } from './money';

/** Pure invoice maths (§5.6). No DB, no clock: everything comes in as arguments. */

export interface PlanTerms {
  name: string;
  priceMonthly: string;
  includedPages: number;
  overagePerPage: string;
}

export interface TaxRule {
  /** e.g. "GST", "Sales tax" */
  label: string;
  /** up to 2 decimals, e.g. "18" or "8.25" */
  ratePercent: string;
}

export interface LineInput {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
}

export interface BuiltLine {
  description: string;
  /** 2 decimals */
  quantity: string;
  /** 4 decimals */
  unitPrice: string;
  /** 2 decimals, quantity × unitPrice rounded half-up */
  amount: string;
}

export interface BuiltInvoice {
  currency: string;
  lines: BuiltLine[];
  subtotal: string;
  taxLabel: string;
  taxRatePercent: string;
  tax: string;
  total: string;
}

export function buildLine(line: LineInput): BuiltLine {
  const quantity = toUnits(line.quantity);
  const unitPrice = toUnits(line.unitPrice);
  return {
    description: line.description,
    quantity: formatUnits(quantity),
    unitPrice: formatUnits(unitPrice, 4),
    amount: formatUnits(multiply(quantity, unitPrice)),
  };
}

/** Lines + tax → totals. Tax is applied once to the subtotal (not per line) and rounded half-up. */
export function buildInvoice(lines: LineInput[], tax: TaxRule, currency: string): BuiltInvoice {
  if (lines.length === 0) throw new RangeError('An invoice needs at least one line');
  const built = lines.map(buildLine);
  const subtotal = sum(built.map((l) => toUnits(l.amount)));
  const rate = toUnits(tax.ratePercent);
  if (rate < 0n || rate > toUnits(100)) throw new RangeError('Tax rate must be 0–100%');
  const taxAmount = subtotal > 0n ? percentOf(subtotal, rate) : 0n;
  return {
    currency,
    lines: built,
    subtotal: formatUnits(subtotal),
    taxLabel: tax.label,
    taxRatePercent: formatUnits(rate),
    tax: formatUnits(taxAmount),
    total: formatUnits(subtotal + taxAmount),
  };
}

const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Monthly subscription invoice: one plan-fee line, plus an overage line when pages processed in the
 * period exceed the plan's included pages.
 */
export function buildSubscriptionInvoice(input: {
  plan: PlanTerms;
  pagesUsed: number;
  periodStart: Date;
  periodEnd: Date;
  tax: TaxRule;
  currency: string;
}): BuiltInvoice & { overagePages: number } {
  const { plan, pagesUsed, periodStart, periodEnd } = input;
  if (!Number.isInteger(pagesUsed) || pagesUsed < 0) {
    throw new RangeError('pagesUsed must be a non-negative integer');
  }
  // The period end is exclusive; show the last day actually covered.
  const lastDay = new Date(periodEnd.getTime() - 1);
  const period = `${fmtDay(periodStart)} to ${fmtDay(lastDay)}`;
  const lines: LineInput[] = [
    {
      description: `${plan.name} plan, ${period} (${plan.includedPages.toLocaleString('en-US')} pages included; ${pagesUsed.toLocaleString('en-US')} processed)`,
      quantity: 1,
      unitPrice: plan.priceMonthly,
    },
  ];
  const overagePages = Math.max(0, pagesUsed - plan.includedPages);
  if (overagePages > 0) {
    lines.push({
      description: `Overage: ${overagePages.toLocaleString('en-US')} pages beyond ${plan.includedPages.toLocaleString('en-US')} included`,
      quantity: overagePages,
      unitPrice: plan.overagePerPage,
    });
  }
  return { ...buildInvoice(lines, input.tax, input.currency), overagePages };
}

/** Same day-of-month next month, clamped (31 Jan → 28/29 Feb). UTC. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
