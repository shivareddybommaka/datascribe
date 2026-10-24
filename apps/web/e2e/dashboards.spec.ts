import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';

const SALES = 'sales@datascribe.example';

test('M9: sales sees the sales dashboard and can change its window', async ({ page }) => {
  await page.goto('/console/dashboards');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill(SALES);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();

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
