import { expect, test, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';
import { E2E } from '../playwright.config';

const SUPER = 'super.admin@datascribe.example';

// One super admin sign-in shared by the tests below (serial): the API's per-IP auth rate limit
// is shared with the other specs.
test.describe.configure({ mode: 'serial' });
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await browser.newPage();
  await admin.goto('/console/admin');
  await expect(admin).toHaveURL(/\/console\/login/);
  await admin.getByLabel('Email').fill(SUPER);
  await admin.getByLabel('Password').fill(TEST_PASSWORD);
  await admin.getByRole('button', { name: 'Continue' }).click();
  await admin.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await admin.getByRole('button', { name: 'Verify' }).click();
  await expect(admin.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await admin.close();
});

const nav = (name: string) =>
  admin.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name, exact: true });

/** Latest invite token sent to `to`, read from Mailpit (local only, synthetic data). */
async function inviteTokenFor(to: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const list = (await (
      await fetch(`${E2E.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
    ).json()) as { messages: { ID: string }[] };
    if (list.messages.length) {
      const msg = (await (
        await fetch(`${E2E.mailpit}/api/v1/message/${list.messages[0]!.ID}`)
      ).json()) as { Text: string };
      const m = /token=([A-Za-z0-9_-]+)/.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No invite email for ${to}`);
}

test('M2 DoD: a custom role built in the matrix takes effect for its holder without a restart', async ({
  browser,
}) => {
  const stamp = Date.now();
  const roleName = `Audit reader ${stamp}`;
  const email = `auditor.${stamp}@datascribe.example`;

  // 1. Super admin creates a staff role with CRM read access only
  await nav('Roles').click();
  await admin.getByRole('link', { name: 'New role' }).click();
  await admin.getByLabel('Role name').fill(roleName);
  await admin.getByRole('checkbox', { name: 'crm view all' }).check();
  await admin.getByRole('button', { name: 'Create role' }).click();
  await expect(admin).toHaveURL(/\/console\/admin\/roles\/(?!new)[^/]+$/);
  await expect(admin.getByRole('heading', { name: roleName })).toBeVisible();
  await expect(admin.getByRole('checkbox', { name: 'crm view all' })).toBeChecked();
  const roleUrl = admin.url();

  // 2. ...and invites a new staff member with it
  await nav('Users').click();
  await admin.getByRole('button', { name: 'Invite user' }).click();
  const invite = admin.getByRole('dialog', { name: 'Invite user' });
  await expect(
    invite.getByLabel('Organization').locator('option', { hasText: 'Datascribe' }),
  ).toHaveCount(1);
  await invite.getByLabel('Organization').selectOption({ label: 'Datascribe' });
  await invite.getByLabel('Email').fill(email);
  await invite.getByLabel('Role').selectOption({ label: roleName });
  await invite.getByRole('button', { name: 'Send invite' }).click();
  await expect(invite.getByRole('status')).toContainText(`Invite sent to ${email}`);
  await invite.getByRole('button', { name: 'Done' }).click();

  // 3. The new user accepts, enrols in MFA and signs in: no audit log access yet
  const ctx = await browser.newContext();
  const user = await ctx.newPage();
  await user.goto(`/invite/accept?token=${await inviteTokenFor(email)}`);
  await user.getByLabel('Your name').fill('Avery Auditor (synthetic)');
  await user.getByLabel('Password', { exact: true }).fill('Auditor-pass-12345');
  await user.getByLabel('Confirm password').fill('Auditor-pass-12345');
  await user.getByRole('button', { name: 'Create account' }).click();
  await expect(user.getByRole('status')).toContainText(email);

  await user.goto('/console/admin/audit');
  await expect(user).toHaveURL(/\/console\/login/);
  await user.getByLabel('Email').fill(email);
  await user.getByLabel('Password').fill('Auditor-pass-12345');
  await user.getByRole('button', { name: 'Continue' }).click();
  const secret = (await user.locator('code').first().textContent())!.trim();
  await user.getByLabel('Authentication code').fill(authenticator.generate(secret));
  await user.getByRole('button', { name: 'Verify' }).click();
  await expect(user.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(user.getByRole('main').getByRole('alert')).toContainText('permission');

  // 4. Super admin ticks audit_log view in the matrix
  await admin.goto(roleUrl);
  await expect(admin.getByRole('heading', { name: roleName })).toBeVisible();
  await admin.getByRole('checkbox', { name: 'audit_log view all' }).check();
  await admin.getByRole('button', { name: 'Save permissions' }).click();
  await expect(admin.getByRole('status')).toContainText('Saved. 2 permission(s)');

  // 5. Same API process, same user: the next load has access
  await user.reload();
  await expect(
    user.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Audit log' }),
  ).toBeVisible();
  await expect(user.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(
    user.getByRole('row').filter({ hasText: 'admin.role.updated' }).first(),
  ).toBeVisible();
  await user.screenshot({ path: 'test-results/screens/admin-audit.png', fullPage: true });
  await ctx.close();
});

test('§4.4: super admin views as a client admin read-only, with a banner, and stops', async () => {
  await admin.goto('/console/admin/users');
  await admin.getByLabel('Search users').fill('client.admin@acme.example');
  await admin.getByRole('button', { name: 'Search' }).click();
  await admin.getByRole('button', { name: 'Manage client.admin@acme.example' }).click();
  await admin.getByRole('button', { name: 'View as Acme Client Admin (read-only)' }).click();

  const banner = admin.getByRole('region', { name: 'Impersonation' });
  await expect(banner).toContainText('Viewing as Acme Client Admin');
  await expect(banner).toContainText('read-only');
  await expect(admin.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  // the client admin's view: own firm only, no staff screens
  await expect(
    admin.getByRole('row').filter({ hasText: 'client.user@acme.example' }),
  ).toBeVisible();
  await expect(admin.getByRole('row').filter({ hasText: 'harbor.example' })).toHaveCount(0);
  await expect(nav('Settings')).toHaveCount(0);
  await admin.screenshot({ path: 'test-results/screens/admin-impersonation.png', fullPage: true });

  // writes are refused by the API
  await admin.getByRole('button', { name: 'Manage client.user@acme.example' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Acme Client User' });
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Read-only');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await banner.getByRole('button', { name: /Stop viewing as/ }).click();
  await expect(banner).toHaveCount(0);
  await expect(nav('Settings')).toBeVisible();

  // both ends are in the audit log, marked with the impersonator
  await nav('Audit log').click();
  await admin.getByLabel('Action starts with').fill('admin.impersonation');
  await admin.getByRole('button', { name: 'Apply' }).click();
  await expect(
    admin.getByRole('row').filter({ hasText: 'admin.impersonation.started' }).first(),
  ).toContainText(`via ${SUPER}`);
  await expect(
    admin.getByRole('row').filter({ hasText: 'admin.impersonation.stopped' }).first(),
  ).toContainText(`via ${SUPER}`);
});

test('M9: super admin edits a notification email, previews it, and restores the default', async () => {
  await admin.goto('/console/admin/settings');
  await admin
    .getByLabel('Template', { exact: true })
    .selectOption({ label: 'Notification: Upload checked' });
  const subject = admin.getByLabel('Subject', { exact: true });
  await expect(subject).toHaveValue('Record checked on case {{caseNumber}}');

  await subject.fill('Checked: {{caseNumber}}');
  await admin.getByLabel('Body (plain text)').fill('Your record is clean. {{link}}');
  await admin.getByRole('button', { name: 'Preview' }).click();
  await expect(admin.getByText('Checked: DS-2026-0001')).toBeVisible();
  // the preferences link is always added below non-critical notification emails
  await expect(admin.getByText(/Choose which emails you get/)).toBeVisible();

  await admin.getByRole('button', { name: 'Save template' }).click();
  await expect(
    admin.getByRole('option', { name: 'Notification: Upload checked (edited)' }),
  ).toBeAttached();
  await admin.getByRole('button', { name: 'Restore default' }).click();
  await expect(subject).toHaveValue('Record checked on case {{caseNumber}}');
});
