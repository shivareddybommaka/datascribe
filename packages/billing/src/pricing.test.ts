import { describe, expect, it } from 'vitest';
import { effectivePlanPricing } from './service';

const plan = {
  name: 'Professional',
  priceMonthly: '1499.00',
  includedPages: 2000,
  overagePerPage: '0.7500',
};

describe('effectivePlanPricing (firm custom pricing, D-062)', () => {
  it('uses the plan when the firm has no custom pricing', () => {
    expect(effectivePlanPricing(plan, {})).toEqual(plan);
    expect(effectivePlanPricing(plan, null)).toEqual(plan);
    expect(effectivePlanPricing(plan, { customPricing: null })).toEqual(plan);
  });

  it('replaces fee, included pages and overage price', () => {
    expect(
      effectivePlanPricing(plan, {
        customPricing: { priceMonthly: '999', includedPages: 3000, overagePerPage: '0.5' },
      }),
    ).toEqual({
      name: 'Professional (custom pricing)',
      priceMonthly: '999.00',
      includedPages: 3000,
      overagePerPage: '0.5000',
    });
  });

  it('ignores malformed custom pricing', () => {
    for (const customPricing of [
      { priceMonthly: '-1', includedPages: 10, overagePerPage: '1' },
      { priceMonthly: '10', includedPages: 1.5, overagePerPage: '1' },
      { priceMonthly: '10', includedPages: 10, overagePerPage: 'abc' },
    ]) {
      expect(effectivePlanPricing(plan, { customPricing })).toEqual(plan);
    }
  });
});
