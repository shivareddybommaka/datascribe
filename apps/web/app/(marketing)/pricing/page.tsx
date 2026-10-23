import { DEFAULT_PAGES } from '@datascribe/site-content';
import { CtaLink } from '@/components/marketing/cta-link';
import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';
import { getPage } from '@/lib/cms';
import { formatMoney, getPlans } from '@/lib/plans';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('pricing');

/** Card copy from the CMS; names, prices, pages and features from SubscriptionPlan (§5.1). */
export default async function PricingPage() {
  const [page, plans] = await Promise.all([getPage('pricing'), getPlans()]);
  const copy = page.pricing ?? DEFAULT_PAGES.pricing.pricing!;
  const tagline = (name: string) => copy.taglines?.find((t) => t.planName === name)?.tagline;

  return (
    <MarketingPage slug="pricing">
      <section aria-labelledby="plans-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <h2
            id="plans-heading"
            className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl"
          >
            {copy.heading}
          </h2>
          {copy.intro && <p className="mt-3 max-w-2xl text-lg text-body">{copy.intro}</p>}

          {plans && plans.length > 0 ? (
            <ul className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {plans.map((plan) => {
                const highlighted = plan.name === copy.highlightedPlan;
                return (
                  <li
                    key={plan.id}
                    aria-labelledby={`plan-${plan.id}`}
                    className={`flex flex-col rounded-xl border bg-white p-6 ${highlighted ? 'border-brand-600 ring-2 ring-brand-600' : 'border-line'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 id={`plan-${plan.id}`} className="text-xl font-semibold text-ink">
                        {plan.name}
                      </h3>
                      {highlighted && (
                        <span className="rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
                          Most popular
                        </span>
                      )}
                    </div>
                    {tagline(plan.name) && <p className="mt-2 text-body">{tagline(plan.name)}</p>}
                    <p className="mt-6">
                      <span className="text-4xl font-semibold tracking-tight text-ink">
                        {formatMoney(plan.priceMonthly, plan.currency)}
                      </span>
                      <span className="text-body"> / month</span>
                    </p>
                    <dl className="mt-4 space-y-1 text-sm text-body">
                      <div className="flex gap-1">
                        <dt className="font-semibold text-ink">
                          {plan.includedPages.toLocaleString('en-US')}
                        </dt>
                        <dd>{copy.includedPagesLabel}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt className="font-semibold text-ink">
                          {formatMoney(plan.overagePerPage, plan.currency, 4)}
                        </dt>
                        <dd>{copy.overageLabel}</dd>
                      </div>
                    </dl>
                    <ul className="mt-6 flex-1 space-y-2 text-sm text-body">
                      {plan.features.map((f) => (
                        <li key={f} className="flex gap-2">
                          <span aria-hidden="true" className="font-bold text-brand-600">
                            ✓
                          </span>
                          {f}
                        </li>
                      ))}
                    </ul>
                    <CtaLink
                      cta={{ ...copy.cardCta, variant: highlighted ? 'primary' : 'secondary' }}
                      ariaLabel={`${copy.cardCta.label}: ${plan.name}`}
                      className="mt-8 w-full"
                    />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status" className="mt-10 max-w-2xl rounded-lg bg-surface p-6 text-ink">
              {copy.unavailableMessage}
            </p>
          )}
          {copy.footnote && <p className="mt-6 text-sm text-muted">{copy.footnote}</p>}
        </div>
      </section>
    </MarketingPage>
  );
}
