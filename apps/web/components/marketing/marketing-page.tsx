import { PAGE_ROUTES, type PageSlug } from '@datascribe/site-content';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getPage } from '@/lib/cms';
import { seoMetadata } from '@/lib/seo';
import { Hero, Sections } from './sections';

export async function pageMetadata(slug: PageSlug): Promise<Metadata> {
  const page = await getPage(slug);
  return seoMetadata(page.seo, {
    title: `${page.title} | Datascribe`,
    description: page.hero.subheading ?? undefined,
    path: PAGE_ROUTES[slug],
  });
}

/** Hero + CMS sections; `children` render between them (pricing cards, contact form, post list). */
export async function MarketingPage({ slug, children }: { slug: PageSlug; children?: ReactNode }) {
  const page = await getPage(slug);
  return (
    <>
      <Hero hero={page.hero} compact={slug !== 'home'} />
      {children}
      <Sections sections={page.sections} />
    </>
  );
}
