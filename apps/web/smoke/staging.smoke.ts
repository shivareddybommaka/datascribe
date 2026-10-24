/**
 * Staging smoke (D-124) against the production-built staging stack: guard rails, console login
 * (with MFA enrolment), the client portal and a file upload through the storage relay.
 * Synthetic data only. Run by scripts/staging-smoke.mjs, never on its own.
 */
import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { syntheticRecordPdf } from '../../api/test/synthetic-pdf';

const PASSWORD = process.env.SMOKE_PASSWORD ?? '';
const BANNER = 'Staging — synthetic data only. Do not upload real patient records.';
const FILE = 'synthetic-staging-smoke.pdf';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(PASSWORD.length, 'SMOKE_PASSWORD is set by the smoke script').toBeGreaterThanOrEqual(12);
});

async function expectBanner(page: Page) {
  const banner = page.getByRole('region', { name: 'Staging notice' });
  await expect(banner).toHaveText(BANNER);
  await expect(banner).toBeInViewport();
  expect(await banner.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
}

test('guard rails: banner, noindex, robots.txt, no analytics', async ({ page, request }) => {
  const home = await page.goto('/');
  expect(home!.headers()['x-robots-tag']).toContain('noindex');
  await expectBanner(page);
  await expect(page.locator('script[src*="googletagmanager"]')).toHaveCount(0);
  expect(await page.content()).not.toMatch(/googletagmanager|gtag\(/);
  // the cookie banner only appears when analytics are configured
  await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);

  const robots = await request.get('/robots.txt');
  expect(robots.headers()['x-robots-tag']).toContain('noindex');
  const text = await robots.text();
  expect(text).toMatch(/Disallow: \/\s*$/m);
  expect(text).not.toContain('Sitemap');

  // the API, through the web app's rewrite, gets the header too
  const health = await request.get('/api/v1/health');
  expect(health.status()).toBe(200);
  expect(health.headers()['x-robots-tag']).toContain('noindex');
});

test('console: super admin signs in with MFA enrolment', async ({ page, context }) => {
  await page.goto('/console');
  await expect(page).toHaveURL(/\/console\/login/);
  await expectBanner(page);
  await page.getByLabel('Email').fill('super.admin@datascribe.example');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  // internal users must enrol on first sign-in; the setup screen shows the secret
  const secret = (await page.locator('code').first().textContent())!.trim();
  await page.getByLabel('Authentication code').fill(authenticator.generate(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/\/console\/login/);
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expectBanner(page);

  // production-build cookie flags
  const refresh = (await context.cookies()).find((c) => c.path === '/api/v1/auth');
  expect(refresh, 'refresh cookie').toBeTruthy();
  expect(refresh!.secure).toBe(true);
  expect(refresh!.httpOnly).toBe(true);
  expect(refresh!.sameSite).toBe('Strict');

  await page.goto('/console/crm/leads');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('portal: client creates a case, uploads a file through the relay and downloads it', async ({
  page,
}) => {
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/login/);
  await page.getByLabel('Email').fill('client.user@acme.example');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expectBanner(page);

  await page.getByRole('link', { name: 'New case' }).click();
  await page.getByLabel('Matter name').fill(`Staging smoke v. Synthetic Co (${Date.now()})`);
  await page.getByLabel('Patient / plaintiff name').fill('Synthetic Smoke Patient');
  await page.getByLabel('Case type').selectOption('personal_injury');
  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page).toHaveURL(/\/portal\/cases\/(?!new$)[^/]+$/);

  // every part goes to the same origin (the relay), never to localhost:9000
  const putHosts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT') putHosts.push(new URL(r.url()).origin);
  });
  const pdf = await syntheticRecordPdf({ pages: 12 });
  await page.getByLabel('Add records').setInputFiles({
    name: FILE,
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.bytes),
  });
  const row = page.getByRole('row').filter({ hasText: FILE });
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 90_000 });
  await expect(row.getByRole('cell', { name: '12', exact: true })).toBeVisible();
  expect(putHosts.length).toBeGreaterThan(0);
  expect(new Set(putHosts)).toEqual(new Set([new URL(page.url()).origin]));

  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: `Download ${FILE}` }).click();
  expect((await download).suggestedFilename()).toBe(FILE);
});
