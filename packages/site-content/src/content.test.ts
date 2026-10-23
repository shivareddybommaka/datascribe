import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGES,
  DEFAULT_POSTS,
  DEFAULT_SITE,
  PAGE_ROUTES,
  PAGE_SLUGS,
  plainText,
  richText,
} from '.';

describe('default site content', () => {
  it('has a page for each of the 7 marketing slugs, with SEO fields', () => {
    expect(PAGE_SLUGS).toHaveLength(7);
    for (const slug of PAGE_SLUGS) {
      const page = DEFAULT_PAGES[slug];
      expect(page.slug).toBe(slug);
      expect(page.hero.heading).not.toBe('');
      expect(page.seo?.title).toBeTruthy();
      expect(page.seo?.description).toBeTruthy();
      expect(PAGE_ROUTES[slug]).toMatch(/^\//);
    }
  });

  it('never hard-codes prices (they come from SubscriptionPlan)', () => {
    const json = JSON.stringify({ DEFAULT_PAGES, DEFAULT_POSTS, DEFAULT_SITE });
    expect(json).not.toMatch(/[$₹€£]\s?\d/);
    expect(json).not.toMatch(/\b\d+(\.\d+)?\s?(USD|INR)\b/);
  });

  it('only links to public routes', () => {
    const hrefs = JSON.stringify(DEFAULT_PAGES).match(/"href":"[^"]+"/g) ?? [];
    for (const h of hrefs) expect(h).not.toMatch(/\/(console|portal)/);
  });

  it('post slugs are unique and URL-safe', () => {
    const slugs = DEFAULT_POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('richText / plainText', () => {
  it('round-trips paragraphs, headings and lists', () => {
    const rt = richText('Intro', { h2: 'Heading' }, { ul: ['One', 'Two'] });
    expect(rt.root.children?.map((c) => c.type)).toEqual(['paragraph', 'heading', 'list']);
    expect(plainText(rt)).toBe('Intro\nHeading\nOne\nTwo');
    expect(plainText(null)).toBe('');
  });
});
