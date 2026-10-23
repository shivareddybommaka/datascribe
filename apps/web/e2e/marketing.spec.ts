import { expect, test } from '@playwright/test';

/** §5.1: the 7 marketing pages at 375 / 768 / 1280 px, SEO files and consent-gated analytics. */
const PAGES = [
  '/',
  '/about',
  '/services',
  '/ai-medical-summary',
  '/pricing',
  '/resources',
  '/contact',
];
const WIDTHS = [375, 768, 1280];

for (const width of WIDTHS) {
  test(`marketing pages render without horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator('h1').first(), path).toBeVisible();
      await expect(page.getByRole('navigation').first(), path).toBeAttached();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
  });
}

test('every page has its own title, description and canonical URL', async ({ page }) => {
  const titles = new Set<string>();
  for (const path of PAGES) {
    await page.goto(path);
    const title = await page.title();
    expect(title, path).not.toBe('');
    titles.add(title);
    await expect(page.locator('meta[name="description"]'), path).toHaveAttribute('content', /\S/);
    await expect(page.locator('link[rel="canonical"]'), path).toHaveAttribute('href', /\S/);
  }
  expect(titles.size).toBe(PAGES.length);
});

test('sitemap.xml lists the pages and robots.txt keeps app routes out', async ({ request }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  for (const path of PAGES.filter((p) => p !== '/')) expect(sitemap).toContain(`${path}</loc>`);
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/console/);
  expect(robots).toMatch(/Disallow: \/portal/);
  expect(robots).toContain('Sitemap:');
});

test('no analytics requests before consent', async ({ page }) => {
  const analytics: string[] = [];
  page.on('request', (r) => {
    if (/googletagmanager|google-analytics/.test(r.url())) analytics.push(r.url());
  });
  await page.goto('/');
  await page.goto('/pricing');
  expect(analytics).toEqual([]);
});
