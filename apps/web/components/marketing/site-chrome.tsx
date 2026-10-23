import { PAGE_LABELS, PAGE_ROUTES, PAGE_SLUGS, type Site } from '@datascribe/site-content';
import Link from 'next/link';
import { Logo } from '@/components/logo';
import { CookieSettingsButton } from './consent-analytics';
import { SiteNav } from './site-nav';

export function MarketingHeader({ site }: { site: Site }) {
  return (
    <header className="relative border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Logo height={36} />
        <SiteNav nav={site.nav} cta={site.headerCta} />
      </div>
    </header>
  );
}

export function MarketingFooter({ site, cookieSettings }: { site: Site; cookieSettings: boolean }) {
  return (
    <footer className="bg-navy-900 text-navy-50">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <p className="text-lg font-semibold text-white">{site.siteName}</p>
          <p className="mt-2 text-sm leading-6">{site.footer.tagline}</p>
        </div>
        <nav aria-label="Footer" className="md:col-span-2">
          <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {PAGE_SLUGS.map((slug) => (
              <li key={slug}>
                <Link href={PAGE_ROUTES[slug]} className="hover:text-white hover:underline">
                  {PAGE_LABELS[slug]}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/portal" className="hover:text-white hover:underline">
                Client portal
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-white/15">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {site.footer.legal}
          </p>
          {cookieSettings && (
            <CookieSettingsButton className="self-start underline hover:text-white" />
          )}
        </div>
      </div>
    </footer>
  );
}
