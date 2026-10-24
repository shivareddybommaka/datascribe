import { expect, test } from '@playwright/test';
import { TEST_PASSWORD } from '../../api/test/constants';
import { E2E } from '../playwright.config';

const HARBOR_ADMIN = 'client.admin@harbor.example';

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

test('M9: the bell shows a notification after an invite is accepted, and marks it read', async ({
  page,
  request,
}) => {
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/login/);
  await page.getByLabel('Email').fill(HARBOR_ADMIN);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Portal' })
    .getByRole('link', { name: 'Firm' })
    .click();
  const colleague = `associate.${Date.now()}@harbor.example`;
  await page.getByLabel('Email').fill(colleague);
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('status')).toContainText(`Invite sent to ${colleague}`);

  const accepted = await request.post(`/api/v1/invites/${await inviteTokenFor(colleague)}/accept`, {
    data: { name: 'Associate Synthetic', password: TEST_PASSWORD },
  });
  expect(accepted.status()).toBe(201);

  // the bell polls every 30 s; a reload shows it at once
  await page.reload();
  const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel.getByText('Invite accepted').first()).toBeVisible();
  await expect(panel.getByText(colleague)).toBeVisible();

  await panel.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  // notification centre (the panel stays open after "Mark all read"): list + preferences
  await panel.getByRole('link', { name: 'All notifications and settings' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Payment failed: email' })).toBeDisabled();
  const invoiceEmail = page.getByRole('checkbox', { name: 'Invoice issued: email' });
  await expect(invoiceEmail).toBeChecked();
  // controlled input: it flips once the PUT returns, so click and wait rather than uncheck()
  await invoiceEmail.click();
  await expect(invoiceEmail).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Invoice issued: email' })).not.toBeChecked();
});
