import type { ReactNode } from 'react';
import { ConsentAnalytics } from '@/components/marketing/consent-analytics';
import { MarketingFooter, MarketingHeader } from '@/components/marketing/site-chrome';
import { analyticsIds, hasAnalytics } from '@/lib/analytics';
import { getSite } from '@/lib/cms';

/**
 * Public marketing routes (§5.1). The only place analytics can load: /console, /portal and
 * /invite live outside this route group and never render ConsentAnalytics.
 */
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const site = await getSite();
  const ids = analyticsIds();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-brand-700 focus:shadow"
      >
        Skip to content
      </a>
      <MarketingHeader site={site} />
      <main id="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
      <MarketingFooter site={site} cookieSettings={hasAnalytics(ids)} />
      <ConsentAnalytics ids={ids} copy={site.cookieBanner} />
    </>
  );
}
