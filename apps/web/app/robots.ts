import type { MetadataRoute } from 'next';
import { isStaging } from '@/lib/deploy';
import { siteUrl } from '@/lib/seo';

/**
 * Crawlers may index the marketing site; the apps and API stay out (§5.1). Staging is closed to
 * every crawler (D-123).
 */
export default function robots(): MetadataRoute.Robots {
  if (isStaging()) return { rules: [{ userAgent: '*', disallow: '/' }] };
  const base = siteUrl();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/console', '/portal', '/invite', '/api/'] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
