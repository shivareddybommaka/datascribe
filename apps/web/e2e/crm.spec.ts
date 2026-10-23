import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';
import { E2E } from '../playwright.config';

const SALES = 'sales@datascribe.example';

async function signInAsSales(page: Page) {
  await page.goto('/console/crm');
  await expect(page).toHaveURL(/\/console\/login/);
  await page.getByLabel('Email').fill(SALES);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'CRM overview' })).toBeVisible();
}

/** Latest invite token sent to `to`, read from Mailpit's API (local only, synthetic data). */
async function inviteTokenFor(to: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const list = (await (
      await fetch(`${E2E.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    ).json()) as {
      messages: { ID: string }[];
    };
    if (list.messages.length) {
      const msg = (await (
        await fetch(`${E2E.mailpit}/api/v1/message/${list.messages[0]!.ID}`)
      ).json()) as {
        Text: string;
      };
      const m = /token=([A-Za-z0-9_-]+)/.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No invite email for ${to}`);
}

test('M7: website demo request → lead on the board → converted to a client with an invited admin', async ({
  page,
}) => {
  const stamp = Date.now();
  const company = `Brightwater Injury Law ${stamp} (synthetic)`;
  const adminEmail = `robin.${stamp}@brightwater.example`;

  // 1. Public website form
  await page.goto('/contact?kind=demo');
  await page.getByLabel('Your name').fill('Robin Synthetic');
  await page.getByLabel('Firm').fill(company);
  await page.getByLabel('Work email').fill(adminEmail);
  await page.getByLabel('Message (optional)').fill('About 40 PI matters a month.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Thanks');

  // 2. Sales signs in (password + TOTP) and finds the lead on the board
  await signInAsSales(page);
  await expect(page.getByRole('heading', { name: 'My tasks today' })).toBeVisible();
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByLabel('Search leads').fill(company);
  await page.getByRole('button', { name: 'Search' }).click();
  const newColumn = page.getByRole('region', { name: 'New column' });
  const card = newColumn.getByRole('link', { name: company });
  await expect(card).toBeVisible();

  // 3. Drag it to "Contacted" on the kanban board
  await card.locator('..').dragTo(page.getByRole('region', { name: 'Contacted column' }));
  await expect(
    page.getByRole('region', { name: 'Contacted column' }).getByRole('link', { name: company }),
  ).toBeVisible();

  await page.getByLabel('Search leads').fill('');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.screenshot({ path: 'test-results/screens/crm-board.png', fullPage: true });
  await page.getByLabel('Search leads').fill(company);
  await page.getByRole('button', { name: 'Search' }).click();

  // Table view shows the same lead with its new stage
  await page.getByRole('button', { name: 'table' }).click();
  const row = page.getByRole('row').filter({ hasText: company });
  await expect(row).toContainText('Contacted');
  await expect(row).toContainText('Website demo');

  // 4. Open it, log a task, convert to client
  await row.getByRole('link', { name: company }).click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();
  await page.getByLabel('Type').selectOption('task');
  await page.getByLabel('Subject').fill('Send onboarding pack');
  await page.getByLabel('Due').fill('2030-01-01T10:00');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText('Send onboarding pack')).toBeVisible();

  await page.screenshot({ path: 'test-results/screens/crm-lead.png', fullPage: true });
  await page.getByRole('button', { name: 'Convert to client' }).click();
  await expect(page.getByLabel('Client admin email')).toHaveValue(adminEmail);
  await page.getByRole('button', { name: 'Convert and send invite' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert to client' });
  await expect(dialog.getByRole('status')).toContainText(`Invite sent to ${adminEmail}`);
  // behind the dialog: the converted banner and the history note in the activity timeline
  await expect(page.getByText(/^Converted to client .* on /)).toBeAttached();
  await expect(page.getByText(`Converted to client: ${company}`)).toBeAttached();
  await dialog.getByRole('link', { name: 'Open account' }).click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();
  await expect(page.getByText('No users yet (invite pending).')).toBeVisible();

  // 5. The invited client admin accepts the emailed invite
  const token = await inviteTokenFor(adminEmail);
  await page.goto(`/invite/accept?token=${token}`);
  await page.getByLabel('Your name').fill('Robin Synthetic');
  await page.getByLabel('Password', { exact: true }).fill('Brightwater-pass-123');
  await page.getByLabel('Confirm password').fill('Brightwater-pass-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(adminEmail);
});

test('marking a lead lost on the board requires a reason', async ({ page }) => {
  const company = `Lost Cause Legal ${Date.now()} (synthetic)`;
  await signInAsSales(page);
  await page.goto('/console/crm/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Company').fill(company);
  await page.getByLabel('Contact name').fill('Sam Synthetic');
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('heading', { name: company })).toBeVisible();

  await page.goto(`/console/crm/leads?q=${encodeURIComponent(company)}`);
  const card = page
    .getByRole('region', { name: 'New column' })
    .getByRole('link', { name: company });
  await card.locator('..').dragTo(page.getByRole('region', { name: 'Lost column' }));
  await expect(page.getByRole('heading', { name: /Mark .* as lost/ })).toBeVisible();
  await page.getByLabel('Lost reason (required)').fill('Budget frozen');
  await page.getByRole('button', { name: 'Mark lost' }).click();
  await expect(
    page.getByRole('region', { name: 'Lost column' }).getByRole('link', { name: company }),
  ).toBeVisible();
});

test('forgot password: emailed link sets a new password that works', async ({ page }) => {
  const email = 'case.manager@datascribe.example';
  await page.goto('/console/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await page.waitForLoadState('networkidle'); // hydrated: submit goes through React, not a native GET
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('reset link is on its way');

  let token = '';
  for (let i = 0; i < 20 && !token; i++) {
    const list = (await (
      await fetch(
        `${E2E.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:Reset`)}`,
      )
    ).json()) as { messages: { ID: string }[] };
    if (list.messages[0]) {
      const msg = (await (
        await fetch(`${E2E.mailpit}/api/v1/message/${list.messages[0].ID}`)
      ).json()) as {
        Text: string;
      };
      token = /token=([A-Za-z0-9_-]+)/.exec(msg.Text)?.[1] ?? '';
    }
    if (!token) await new Promise((r) => setTimeout(r, 250));
  }
  expect(token).not.toBe('');

  const newPassword = 'Reset-flow-password-789';
  await page.goto(`/reset-password?token=${token}`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('New password (12+ characters)').fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('status')).toContainText('password was changed');

  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(newPassword);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Authentication code')).toBeVisible();
});

test('client users cannot use the staff console', async ({ page }) => {
  await page.goto('/console/login');
  await page.getByLabel('Email').fill('client.admin@acme.example');
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('The staff console is for Datascribe staff only.')).toBeVisible();
});
