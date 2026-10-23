'use client';

import { usePathname } from 'next/navigation';
import Script from 'next/script';
import { useEffect, useState } from 'react';
import type { Site } from '@datascribe/site-content';
import {
  analyticsScripts,
  CONSENT_COOKIE,
  hasAnalytics,
  readConsent,
  shouldLoadAnalytics,
  type AnalyticsIds,
  type Consent,
} from '@/lib/analytics';

export const COOKIE_SETTINGS_EVENT = 'ds:cookie-settings';

function saveConsent(value: Consent) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${CONSENT_COOKIE}=${value}; Max-Age=${60 * 60 * 24 * 180}; Path=/; SameSite=Lax${secure}`;
}

/** Best effort: remove Google Analytics cookies when consent is withdrawn. */
function clearAnalyticsCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name && /^(_ga|_gid|_gat)/.test(name)) {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${window.location.hostname}`;
    }
  }
}

/**
 * Cookie banner + GA4/GTM. Rendered only by the marketing layout. Nothing non-essential loads until
 * the visitor accepts; no choice counts as declined. Without configured IDs there is nothing to
 * consent to, so no banner is shown.
 */
export function ConsentAnalytics({ ids, copy }: { ids: AnalyticsIds; copy: Site['cookieBanner'] }) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const current = readConsent(document.cookie);
    setConsent(current);
    setOpen(current === null);
    const reopen = () => setOpen(true);
    window.addEventListener(COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(COOKIE_SETTINGS_EVENT, reopen);
  }, []);

  if (!hasAnalytics(ids)) return null;

  const choose = (value: Consent) => {
    const wasGranted = consent === 'granted';
    saveConsent(value);
    setConsent(value);
    setOpen(false);
    if (value === 'denied' && wasGranted) {
      clearAnalyticsCookies();
      window.location.reload(); // unload scripts that already ran
    }
  };

  return (
    <>
      {shouldLoadAnalytics(pathname, consent, ids) &&
        analyticsScripts(ids).map((tag) =>
          tag.src ? (
            <Script key={tag.id} id={tag.id} src={tag.src} strategy="afterInteractive" />
          ) : (
            <Script key={tag.id} id={tag.id} strategy="afterInteractive">
              {tag.inline}
            </Script>
          ),
        )}
      {open && (
        <section
          aria-label="Cookie consent"
          className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-white shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-6">
            <p className="flex-1 text-sm text-body">{copy.message}</p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => choose('denied')}
                className="h-10 rounded-md border border-line bg-white px-4 text-sm font-medium text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                {copy.declineLabel}
              </button>
              <button
                type="button"
                onClick={() => choose('granted')}
                className="h-10 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                {copy.acceptLabel}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT))}
    >
      Cookie settings
    </button>
  );
}
