import {
  DEFAULT_PAGES,
  DEFAULT_POSTS,
  DEFAULT_SITE,
  type MediaRef,
  type Page,
  type PageSlug,
  type Post,
  type Site,
} from '@datascribe/site-content';

/**
 * Server-side reads from Payload's REST API (apps/cms), cached with time-based revalidation.
 * If the CMS can't be reached (e.g. `next build` without it running) the bundled default copy is
 * rendered instead and the page retries on the next revalidation, so the site never goes blank.
 */

export const REVALIDATE_SECONDS = 60;

export const cmsUrl = () =>
  (process.env.CMS_URL || `http://localhost:${process.env.CMS_PORT || 3001}`).replace(/\/$/, '');

let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  console.warn(`${message}; rendering default content until the CMS responds (${cmsUrl()})`);
}

async function cmsGet<T>(path: string, tag: string): Promise<T | null> {
  // CMS_URL=none: no CMS at all, the bundled copy only (staging on the Mac, D-124)
  if (process.env.CMS_URL === 'none') return null;
  try {
    const res = await fetch(`${cmsUrl()}/api${path}`, {
      next: { revalidate: REVALIDATE_SECONDS, tags: ['cms', tag] },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      warnOnce(`CMS returned HTTP ${res.status}`);
      return null;
    }
    warned = false;
    return (await res.json()) as T;
  } catch {
    warnOnce('CMS unreachable');
    return null;
  }
}

type Docs<T> = { docs: T[] };

/** Drop null/empty values so partially filled CMS groups fall back field by field. */
function filled<T extends object>(value: T | null | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ) as Partial<T>;
}

export async function getPage(slug: PageSlug): Promise<Page> {
  const fallback = DEFAULT_PAGES[slug];
  const data = await cmsGet<Docs<Page>>(
    `/pages?where[slug][equals]=${slug}&limit=1&depth=1`,
    `page:${slug}`,
  );
  const page = data?.docs[0];
  if (!page) return fallback;
  return {
    ...page,
    hero: { ...fallback.hero, ...filled(page.hero) },
    sections: page.sections ?? [],
    pricing: fallback.pricing ? { ...fallback.pricing, ...filled(page.pricing) } : page.pricing,
    contactForm: fallback.contactForm
      ? { ...fallback.contactForm, ...filled(page.contactForm) }
      : page.contactForm,
    seo: { ...fallback.seo, ...filled(page.seo) },
  };
}

export async function getSite(): Promise<Site> {
  const site = await cmsGet<Partial<Site>>('/globals/site?depth=0', 'site');
  if (!site) return DEFAULT_SITE;
  return {
    siteName: site.siteName || DEFAULT_SITE.siteName,
    nav: site.nav?.length ? site.nav : DEFAULT_SITE.nav,
    headerCta: { ...DEFAULT_SITE.headerCta, ...filled(site.headerCta) },
    footer: { ...DEFAULT_SITE.footer, ...filled(site.footer) },
    cookieBanner: { ...DEFAULT_SITE.cookieBanner, ...filled(site.cookieBanner) },
  };
}

export async function getPosts(): Promise<Post[]> {
  const data = await cmsGet<Docs<Post>>('/posts?sort=-publishedAt&limit=50&depth=1', 'posts');
  return data ? data.docs : DEFAULT_POSTS;
}

export async function getPost(slug: string): Promise<Post | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const data = await cmsGet<Docs<Post>>(
    `/posts?where[slug][equals]=${slug}&limit=1&depth=1`,
    `post:${slug}`,
  );
  if (data) return data.docs[0] ?? null;
  return DEFAULT_POSTS.find((p) => p.slug === slug) ?? null;
}

/** Stable (server-rendered, cached) publication date: fixed locale and UTC. */
export const postDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Absolute URL for an upload (Payload returns paths on the CMS origin). */
export function mediaUrl(ref: MediaRef | undefined): string | undefined {
  if (!ref || typeof ref !== 'object' || !ref.url) return undefined;
  return /^https?:\/\//.test(ref.url) ? ref.url : `${cmsUrl()}${ref.url}`;
}
