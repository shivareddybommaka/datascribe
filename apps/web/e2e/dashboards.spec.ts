import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';

const SALES = 'sales@datascribe.example';
const OPS = 'ops.manager@datascribe.example';
const SUMMARIZER = 'summarizer@datascribe.example';

async function signIn(page: Page, email: string) {
  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();
}

test('M9: sales sees the sales dashboard and can change its window', async ({ page }) => {
  await signIn(page, SALES);

  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/dashboards\/sales$/);
  await expect(page.getByRole('heading', { name: 'Sales dashboard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboards' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Proposal' })).toBeVisible();
  await expect(page.getByTestId('kpi-created')).toHaveText(/^\d+$/);

  const wide = page.waitForResponse((r) => r.url().includes('/dashboards/sales?days=365'));
  await page.getByLabel('Window').selectOption('365');
  expect((await wide).status()).toBe(200);
  await expect(page.getByTestId('kpi-created')).toHaveText(/^\d+$/);
});

test('M9: ops manager sees every case on the ops dashboard; a summarizer sees their own', async ({
  page,
}) => {
  await signIn(page, OPS);
  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/dashboards\/ops$/);
  await expect(page.getByRole('heading', { name: 'Operations dashboard' })).toBeVisible();
  await expect(page.getByTestId('ops-scope')).toHaveText('All cases');
  await expect(page.getByTestId('kpi-open')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('kpi-overdue')).toHaveText(/^\d+$/);
  await expect(page.getByRole('link', { name: 'Sales', exact: true })).toBeVisible();

  const week = page.waitForResponse((r) => r.url().includes('/dashboards/ops?days=7'));
  await page.getByLabel('Window').selectOption('7');
  expect((await week).status()).toBe(200);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, SUMMARIZER);
  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/dashboards\/ops$/);
  await expect(page.getByTestId('ops-scope')).toHaveText('Cases you summarize or review');
  await expect(page.getByTestId('kpi-open')).toHaveText(/^\d+$/);
  // a summarizer holds no sales grant, so the tab isn't offered
  await expect(page.getByRole('link', { name: 'Sales', exact: true })).toHaveCount(0);
});
