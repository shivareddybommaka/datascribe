import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/seo';

/** Crawlers may index the marketing site; the apps and API stay out (§5.1). */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/console', '/portal', '/invite', '/api/'] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
