'use client';

import type { Cta, Site } from '@datascribe/site-content';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LOGIN_LINKS } from './login-links';

const isCurrent = (pathname: string, href: string) =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/** Desktop links inline from md up; a disclosure menu below that. */
export function SiteNav({ nav, cta }: { nav: Site['nav']; cta: Cta }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const link = (item: Site['nav'][number], mobile: boolean) => {
    const current = isCurrent(pathname, item.href);
    return (
      <Link
        href={item.href}
        aria-current={current ? 'page' : undefined}
        className={
          mobile
            ? `block rounded-md px-3 py-3 text-base ${current ? 'bg-brand-50 font-semibold text-brand-800' : 'text-ink hover:bg-surface'}`
            : `rounded-md px-3 py-2 text-sm font-medium ${current ? 'text-brand-700 underline decoration-2 underline-offset-8' : 'text-ink hover:text-brand-700'}`
        }
      >
        {item.label}
      </Link>
    );
  };

  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
        {nav.map((item) => (
          <span key={item.href}>{link(item, false)}</span>
        ))}
        <span aria-hidden="true" className="mx-2 h-6 w-px bg-line" />
        {LOGIN_LINKS.map((item) => (
          <span key={item.href}>{link(item, false)}</span>
        ))}
        <Link
          href={cta.href}
          className="ml-3 inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {cta.label}
        </Link>
      </nav>
      <div className="lg:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor">
            {open ? (
              <path d="M5.3 4 4 5.3 8.7 10 4 14.7 5.3 16l4.7-4.7 4.7 4.7 1.3-1.3-4.7-4.7L16 5.3 14.7 4 10 8.7z" />
            ) : (
              <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h14v2H3z" />
            )}
          </svg>
          Menu
        </button>
      </div>
      {open && (
        <nav
          id="mobile-menu"
          aria-label="Main"
          className="absolute inset-x-0 top-full z-40 border-b border-line bg-white px-4 pb-4 shadow-md lg:hidden"
        >
          <ul className="space-y-1 pt-2">
            {nav.map((item) => (
              <li key={item.href}>{link(item, true)}</li>
            ))}
          </ul>
          <ul className="mt-2 space-y-1 border-t border-line pt-2">
            {LOGIN_LINKS.map((item) => (
              <li key={item.href}>{link(item, true)}</li>
            ))}
          </ul>
          <Link
            href={cta.href}
            className="mt-3 flex h-11 items-center justify-center rounded-md bg-brand-600 px-4 text-base font-medium text-white hover:bg-brand-700"
          >
            {cta.label}
          </Link>
        </nav>
      )}
    </>
  );
}
