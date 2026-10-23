import { REVALIDATE_SECONDS } from './cms';

/** Public plan as served by GET /api/v1/public/plans (money as decimal strings). */
export interface PublicPlan {
  id: string;
  name: string;
  priceMonthly: string;
  currency: string;
  includedPages: number;
  overagePerPage: string;
  features: string[];
}

/**
 * Plans come from the SubscriptionPlan table via the API (§5.1: prices never duplicated). Returns
 * null when the API can't be reached, and the page shows the CMS "unavailable" message instead.
 */
export async function getPlans(): Promise<PublicPlan[] | null> {
  const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  try {
    const res = await fetch(`${apiUrl}/api/v1/public/plans`, {
      next: { revalidate: REVALIDATE_SECONDS, tags: ['plans'] },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { plans: PublicPlan[] }).plans;
  } catch {
    console.warn('Plans API unreachable, showing the pricing fallback message');
    return null;
  }
}

export function formatMoney(amount: string, currency: string, maxFractionDigits = 2) {
  const value = Number(amount);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}
