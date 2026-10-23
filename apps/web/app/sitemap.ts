import { PAGE_ROUTES, PAGE_SLUGS } from '@datascribe/site-content';
import type { MetadataRoute } from 'next';
import { getPosts } from '@/lib/cms';
import { siteUrl } from '@/lib/seo';

export const revalidate = 3600;

/** Public marketing pages and blog posts only (never /console, /portal or /invite). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const posts = await getPosts();
  return [
    ...PAGE_SLUGS.map((slug) => ({
      url: `${base}${PAGE_ROUTES[slug] === '/' ? '' : PAGE_ROUTES[slug]}`,
      changeFrequency: 'weekly' as const,
      priority: slug === 'home' ? 1 : 0.7,
    })),
    ...posts.map((p) => ({
      url: `${base}/resources/${p.slug}`,
      lastModified: new Date(p.publishedAt),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ];
}
