import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';

const FINANCE = 'finance@datascribe.example';
const ACME = 'Acme Injury Law (synthetic)';

// One sign-in shared by the tests below (in order): signing in per test trips the per-IP auth
// rate limit once the CRM specs have run. Tests move between screens with the console nav.
test.describe.configure({ mode: 'serial' });
let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/console/finance');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill(FINANCE);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await page.close();
});

const nav = (name: string) =>
  page.getByRole('navigation', { name: 'Finance' }).getByRole('link', { name, exact: true });

test('M8: finance issues a one-off invoice, downloads the PDF and voids it', async () => {
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  // Subscriptions show the seeded firms with a usage meter
  await nav('Subscriptions').click();
  const acmeRow = page.getByRole('row').filter({ hasText: ACME });
  await expect(acmeRow).toContainText('Professional');
  await expect(acmeRow.getByRole('meter', { name: 'Pages used this period' })).toBeVisible();

  // One-off invoice: 3 × 150.00 + 1 × 25.50 = 475.50 before tax
  await nav('Invoices').click();
  await page.getByRole('button', { name: 'New one-off invoice' }).click();
  const dialog = page.getByRole('dialog', { name: 'New one-off invoice' });
  await dialog.getByLabel('Client').selectOption({ label: ACME });
  await dialog.getByLabel('Line 1 description').fill('Rush summaries (synthetic)');
  await dialog.getByLabel('Line 1 quantity').fill('3');
  await dialog.getByLabel('Line 1 unit price').fill('150');
  await dialog.getByRole('button', { name: 'Add line' }).click();
  await dialog.getByLabel('Line 2 description').fill('Courier (synthetic)');
  await dialog.getByLabel('Line 2 unit price').fill('25.50');
  await expect(dialog).toContainText('$475.50');
  await dialog.getByRole('button', { name: 'Issue invoice' }).click();

  // Detail page
  await expect(page).toHaveURL(/\/console\/finance\/invoices\/[^/]+$/);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toContainText('issued');
  await expect(page.getByRole('cell', { name: 'Rush summaries (synthetic)' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Subtotal' })).toContainText('$475.50');
  const number = (await heading.textContent())!.replace('issued', '').trim();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toBe(`${number}.pdf`);

  // Void needs a reason
  await page.getByRole('button', { name: 'Void' }).click();
  const voidDialog = page.getByRole('dialog', { name: 'Void invoice' });
  await expect(voidDialog.getByRole('button', { name: 'Void invoice' })).toBeDisabled();
  await voidDialog.getByLabel('Reason').fill('Raised against the wrong firm (synthetic)');
  await voidDialog.getByRole('button', { name: 'Void invoice' }).click();
  await expect(heading).toContainText('void');
  await expect(page.getByRole('button', { name: 'Void' })).toHaveCount(0);

  // The list finds it by number
  await page.getByRole('link', { name: '← Invoices' }).click();
  await page.getByLabel('Invoice number').fill(number);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('row').filter({ hasText: number })).toContainText('void');
});

test('M8 DoD (console side): usage over the limit → monthly run bills plan fee + overage', async () => {
  // Acme is on Professional: US$1,499.00 with 2,000 pages, then US$0.75 a page
  await nav('Subscriptions').click();
  const acmeRow = page.getByRole('row').filter({ hasText: ACME });
  await acmeRow.getByRole('button', { name: 'Add usage' }).click();
  const dialog = page.getByRole('dialog', { name: /Add usage/ });
  await dialog.getByLabel('Pages processed').fill('2400');
  await dialog.getByRole('button', { name: 'Add pages' }).click();
  await expect(acmeRow).toContainText('400 over');

  // Run invoicing as of 40 days from now: the current period has ended
  await nav('Overview').click();
  const later = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('As of (dev only)').fill(later);
  await page.getByRole('button', { name: 'Run monthly invoicing' }).click();
  await expect(page.getByRole('status')).toContainText(/Invoicing: [1-9]\d* invoice\(s\) issued/);

  await nav('Invoices').click();
  await page.getByLabel('Kind').selectOption('subscription');
  // the list keeps the previous rows while the filtered query loads
  await expect(page.getByRole('row').filter({ hasText: 'One-off' })).toHaveCount(0);
  // +40 days can close one or two periods (one invoice each, newest first); the usage is in the
  // oldest one.
  await page.getByRole('row').filter({ hasText: ACME }).last().getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('issued');
  const overage = page.getByRole('row').filter({ hasText: 'Overage: 400 pages beyond 2,000' });
  await expect(overage).toContainText('$300.00');
  await expect(page.getByRole('row').filter({ hasText: 'Subtotal' })).toContainText('$1,799.00');
});

test('M8: finance adds a plan; inactive plans stay listed', async () => {
  const name = `Enterprise ${Date.now()}`;
  await nav('Plans').click();
  await page.getByRole('button', { name: 'New plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'New plan' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Monthly price').fill('2499');
  await dialog.getByLabel('Included pages / month').fill('20000');
  await dialog.getByLabel('Overage price / page').fill('0.09');
  await dialog.getByLabel('Features (one per line)').fill('Dedicated reviewer\nSLA 24 h');
  await dialog.getByLabel(/^Active/).uncheck();
  await dialog.getByRole('button', { name: 'Create plan' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('$2,499.00');
  await expect(row).toContainText('inactive');
});
