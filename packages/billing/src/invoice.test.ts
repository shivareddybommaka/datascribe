import { describe, expect, it } from 'vitest';
import { addMonths, buildInvoice, buildLine, buildSubscriptionInvoice } from './invoice';
import {
  formatUnits,
  fromMinorUnits,
  multiply,
  percentOf,
  roundCents,
  toMinorUnits,
  toUnits,
} from './money';

const PRO = {
  name: 'Professional',
  priceMonthly: '1499.00',
  includedPages: 2000,
  overagePerPage: '0.7500',
};
const GST = { label: 'GST', ratePercent: '18' };
const NO_TAX = { label: 'Tax', ratePercent: '0' };
const MAY = { periodStart: new Date('2026-05-01T00:00:00Z'), periodEnd: new Date('2026-06-01T00:00:00Z') };

describe('money', () => {
  it('parses and formats without floating-point drift', () => {
    expect(toUnits('0.1') + toUnits('0.2')).toBe(toUnits('0.3'));
    expect(formatUnits(toUnits('12.5'))).toBe('12.50');
    expect(formatUnits(toUnits('0.7500'), 4)).toBe('0.7500');
    expect(formatUnits(toUnits(-3))).toBe('-3.00');
    expect(toUnits(1499)).toBe(14_990_000n);
  });

  it('rejects things that are not amounts', () => {
    for (const bad of ['', 'abc', '1.23456', '1e5', 'NaN', '1,000']) {
      expect(() => toUnits(bad)).toThrow(RangeError);
    }
  });

  it('rounds half up to cents', () => {
    expect(formatUnits(roundCents(toUnits('0.005')))).toBe('0.01');
    expect(formatUnits(roundCents(toUnits('0.0049')))).toBe('0.00');
    expect(formatUnits(roundCents(toUnits('-0.005')))).toBe('-0.01');
    expect(formatUnits(multiply(toUnits(3), toUnits('0.3333')))).toBe('1.00');
    expect(formatUnits(multiply(toUnits(7), toUnits('0.0050')))).toBe('0.04'); // 0.035 → 0.04
  });

  it('computes percentages', () => {
    expect(formatUnits(percentOf(toUnits('100.00'), toUnits('18')))).toBe('18.00');
    expect(formatUnits(percentOf(toUnits('19.99'), toUnits('8.25')))).toBe('1.65'); // 1.649175
  });

  it('converts to and from gateway minor units', () => {
    expect(toMinorUnits('1499.00', 'USD')).toBe(149_900);
    expect(toMinorUnits('0.015', 'USD')).toBe(2);
    expect(toMinorUnits('500', 'JPY')).toBe(500);
    expect(fromMinorUnits(149_900, 'usd')).toBe('1499.00');
    expect(fromMinorUnits(500, 'JPY')).toBe('500.00');
  });
});

describe('buildSubscriptionInvoice', () => {
  it('bills just the plan fee when usage is within the included pages', () => {
    const inv = buildSubscriptionInvoice({
      plan: PRO,
      pagesUsed: 1200,
      ...MAY,
      tax: NO_TAX,
      currency: 'USD',
    });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ quantity: '1.00', unitPrice: '1499.0000', amount: '1499.00' });
    expect(inv.lines[0]!.description).toContain('2026-05-01 to 2026-05-31');
    expect(inv.lines[0]!.description).toContain('1,200 processed');
    expect(inv).toMatchObject({ subtotal: '1499.00', tax: '0.00', total: '1499.00', overagePages: 0 });
  });

  it('adds an overage line for pages beyond the plan', () => {
    const inv = buildSubscriptionInvoice({
      plan: PRO,
      pagesUsed: 2347,
      ...MAY,
      tax: NO_TAX,
      currency: 'USD',
    });
    expect(inv.overagePages).toBe(347);
    expect(inv.lines[1]).toMatchObject({
      description: 'Overage: 347 pages beyond 2,000 included',
      quantity: '347.00',
      unitPrice: '0.7500',
      amount: '260.25',
    });
    expect(inv.subtotal).toBe('1759.25');
  });

  it('exactly at the limit has no overage', () => {
    const inv = buildSubscriptionInvoice({ plan: PRO, pagesUsed: 2000, ...MAY, tax: NO_TAX, currency: 'USD' });
    expect(inv.lines).toHaveLength(1);
  });

  it('applies the configured tax once, on the subtotal', () => {
    const inv = buildSubscriptionInvoice({ plan: PRO, pagesUsed: 2347, ...MAY, tax: GST, currency: 'INR' });
    expect(inv).toMatchObject({
      currency: 'INR',
      taxLabel: 'GST',
      taxRatePercent: '18.00',
      tax: '316.67', // 1759.25 × 18% = 316.665 → 316.67
      total: '2075.92',
    });
  });

  it('rejects impossible usage', () => {
    for (const pagesUsed of [-1, 1.5, Number.NaN]) {
      expect(() =>
        buildSubscriptionInvoice({ plan: PRO, pagesUsed, ...MAY, tax: NO_TAX, currency: 'USD' }),
      ).toThrow(RangeError);
    }
  });
});

describe('buildInvoice (one-off)', () => {
  it('totals several lines with fractional quantities', () => {
    const inv = buildInvoice(
      [
        { description: 'Rush surcharge', quantity: 1, unitPrice: '250' },
        { description: 'Extra pages', quantity: '2.5', unitPrice: '0.3333' },
      ],
      { label: 'Sales tax', ratePercent: '8.25' },
      'USD',
    );
    expect(inv.lines.map((l) => l.amount)).toEqual(['250.00', '0.83']);
    expect(inv).toMatchObject({ subtotal: '250.83', tax: '20.69', total: '271.52' });
  });

  it('needs lines and a sane tax rate', () => {
    expect(() => buildInvoice([], NO_TAX, 'USD')).toThrow(RangeError);
    expect(() =>
      buildInvoice([{ description: 'x', quantity: 1, unitPrice: 1 }], { label: 'T', ratePercent: '101' }, 'USD'),
    ).toThrow(RangeError);
  });

  it('credits (negative lines) never produce negative tax', () => {
    const inv = buildInvoice([{ description: 'Credit', quantity: 1, unitPrice: '-10' }], GST, 'USD');
    expect(inv).toMatchObject({ subtotal: '-10.00', tax: '0.00', total: '-10.00' });
    expect(buildLine({ description: 'x', quantity: 2, unitPrice: '1.005' }).amount).toBe('2.01');
  });
});

describe('addMonths', () => {
  it('keeps the day of month and clamps short months', () => {
    expect(addMonths(new Date('2026-01-15T00:00:00Z'), 1).toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addMonths(new Date('2026-12-01T00:00:00Z'), 1).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
