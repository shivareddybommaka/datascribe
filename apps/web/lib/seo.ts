import type { Seo } from '@datascribe/site-content';
import type { Metadata } from 'next';
import { mediaUrl } from './cms';

export const siteUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

/** Per-page metadata from the CMS SEO group (§5.1), with page-title fallbacks. */
export function seoMetadata(
  seo: Seo | null | undefined,
  fallback: { title: string; description?: string; path: string; type?: 'website' | 'article' },
): Metadata {
  const title = seo?.title || fallback.title;
  const description = seo?.description || fallback.description;
  const image = mediaUrl(seo?.ogImage);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: fallback.path },
    openGraph: {
      title,
      description,
      url: fallback.path,
      siteName: 'Datascribe',
      type: fallback.type ?? 'website',
      ...(image ? { images: [{ url: image, width: 1200, height: 630 }] } : {}),
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}
