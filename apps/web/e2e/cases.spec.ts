import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';

const OPS = 'ops.manager@datascribe.example';
const SEEDED = 'DS-SEED-0002'; // synthetic, submitted, seeded with all three assignees

async function signIn(page: Page, email: string) {
  await page.goto('/console/cases');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/\/console\/login/);
}

test('M6: ops manager filters the case queue and reassigns the QA reviewer (§5.4)', async ({
  page,
}) => {
  await signIn(page, OPS);
  await page.goto('/console/cases');
  await expect(page.getByRole('heading', { name: 'Case queue' })).toBeVisible();

  const search = page.waitForResponse((r) => r.url().includes(`q=${SEEDED}`));
  await page.getByLabel('Case number, matter or reference').fill(SEEDED);
  await page.getByRole('button', { name: 'Search' }).click();
  expect((await search).status()).toBe(200);
  const row = page.getByRole('row').filter({ hasText: SEEDED });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Acme');

  // the SLA filter is sent to the API
  const flagged = page.waitForResponse((r) => r.url().includes('sla=any'));
  await page.getByLabel('SLA').selectOption('any');
  expect((await flagged).status()).toBe(200);
  await page.getByLabel('SLA').selectOption('');

  // clear the QA reviewer, then put them back
  await row.getByRole('button', { name: `Assign ${SEEDED}` }).click();
  const dialog = page.getByRole('dialog', { name: `Assign ${SEEDED}` });
  const qa = dialog.getByLabel('QA reviewer');
  await expect(qa).toBeEnabled();
  const original = await qa.inputValue();
  expect(original).not.toBe('');
  await qa.selectOption('');
  const saved = page.waitForResponse((r) => r.url().includes('/assign'));
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('cell').nth(8)).toHaveText('—');

  await row.getByRole('button', { name: `Assign ${SEEDED}` }).click();
  await expect(dialog.getByLabel('QA reviewer')).toBeEnabled();
  await dialog.getByLabel('QA reviewer').selectOption(original);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('cell').nth(8)).not.toHaveText('—');
});
