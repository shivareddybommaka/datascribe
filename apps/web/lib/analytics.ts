/**
 * GA4 / GTM rules (§2, §5.1): marketing routes only, never /console or /portal (or any other app
 * route), and only after the visitor accepts analytics cookies. No choice yet = declined.
 */

export const CONSENT_COOKIE = 'ds_consent';
export type Consent = 'granted' | 'denied';

/** Path prefixes that must never load analytics, whatever the layout tree looks like. */
const PRIVATE_PREFIXES = ['/console', '/portal', '/invite', '/api'];

export const isPrivatePath = (pathname: string) =>
  PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export interface AnalyticsIds {
  ga4Id?: string;
  gtmId?: string;
}

/** Only well-formed IDs are used, so an env value can never inject script text. */
export function analyticsIds(env: Record<string, string | undefined> = process.env): AnalyticsIds {
  const ga4 = env.GA4_MEASUREMENT_ID?.trim();
  const gtm = env.GTM_ID?.trim();
  return {
    ga4Id: ga4 && /^G-[A-Z0-9]{4,20}$/.test(ga4) ? ga4 : undefined,
    gtmId: gtm && /^GTM-[A-Z0-9]{4,12}$/.test(gtm) ? gtm : undefined,
  };
}

export const hasAnalytics = (ids: AnalyticsIds) => Boolean(ids.ga4Id || ids.gtmId);

export function readConsent(cookieHeader: string | undefined | null): Consent | null {
  const match = (cookieHeader ?? '').match(
    new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=(granted|denied)`),
  );
  return (match?.[1] as Consent | undefined) ?? null;
}

export function shouldLoadAnalytics(pathname: string, consent: Consent | null, ids: AnalyticsIds) {
  return consent === 'granted' && hasAnalytics(ids) && !isPrivatePath(pathname);
}

export interface ScriptTag {
  id: string;
  src?: string;
  inline?: string;
}

/** The tags to inject once consent is granted. */
export function analyticsScripts(ids: AnalyticsIds): ScriptTag[] {
  const tags: ScriptTag[] = [];
  if (ids.gtmId) {
    tags.push({
      id: 'gtm',
      inline: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${ids.gtmId}');`,
    });
  }
  if (ids.ga4Id) {
    tags.push({ id: 'ga4-src', src: `https://www.googletagmanager.com/gtag/js?id=${ids.ga4Id}` });
    tags.push({
      id: 'ga4',
      inline: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ids.ga4Id}',{anonymize_ip:true});`,
    });
  }
  return tags;
}
