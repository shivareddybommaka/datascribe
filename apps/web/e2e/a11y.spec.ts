import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';

/**
 * §10 WCAG 2.1 AA (D-118): axe-core on the public website, both sign-in pages and one page each
 * of the portal and the console after sign-in. Serious and critical violations fail the test;
 * moderate and minor ones are attached to the report. axe finds roughly a third of WCAG issues
 * (no keyboard paths, focus order or screen-reader review), so this is a floor, not an audit.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const PUBLIC_PAGES = [
  '/',
  '/about',
  '/services',
  '/ai-medical-summary',
  '/pricing',
  '/resources',
  '/contact',
  '/console/login',
  '/portal/login',
];

async function expectAccessible(page: Page, name: string) {
  const { violations, passes } = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // Next's dev overlay (e2e runs `next dev`) isn't part of the app
    .exclude('nextjs-portal')
    .analyze();
  // guard against an empty or blocked page passing trivially
  expect(passes.length, `${name}: axe ran no checks`).toBeGreaterThan(10);
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const others = violations.filter((v) => !blocking.includes(v));
  if (others.length) {
    await test.info().attach(`axe ${name} (moderate/minor)`, {
      body: JSON.stringify(
        others.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
  const summary = blocking.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}x, e.g. ${v.nodes[0]?.target.join(' ')})`,
  );
  expect(summary, `${name}: WCAG 2.1 AA serious/critical violations`).toEqual([]);
}

test('the check catches a critical violation', async ({ page }) => {
  await page.goto('/about');
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    document.querySelector('main')?.append(img);
  });
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(violations.find((v) => v.id === 'image-alt')?.impact).toBe('critical');
});

test('public website and sign-in pages pass axe WCAG 2.1 AA', async ({ page }) => {
  for (const path of PUBLIC_PAGES) {
    await page.goto(path);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expectAccessible(page, path);
  }
});

test('the home page at phone width passes axe WCAG 2.1 AA', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.locator('h1').first()).toBeVisible();
  await expectAccessible(page, '/ (375px)');
});

test('the client portal dashboard passes axe WCAG 2.1 AA', async ({ page }) => {
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/login/);
  await page.getByLabel('Email').fill('client.user@acme.example');
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expectAccessible(page, '/portal');
});

test('a console page passes axe WCAG 2.1 AA', async ({ page }) => {
  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill('ops.manager@datascribe.example');
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/\/console\/login/);
  await page.goto('/console/dashboards');
  await expect(page.getByRole('heading', { name: /dashboard/i }).first()).toBeVisible();
  await expectAccessible(page, '/console/dashboards');
});
