import { expect, test, type Browser, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';
import { syntheticRecordPdf } from '../../api/test/synthetic-pdf';

const CLIENT_USER = 'client.user@acme.example';
const CLIENT_ADMIN = 'client.admin@acme.example';
const MATTER = `Jacobs v. Riverside Logistics (synthetic ${Date.now()})`;
const FILE = 'synthetic-records-300p.pdf';
/** a submitted case, wherever the pipeline has got to by then */
const PAST_SUBMIT = /Submitted|Processing|In review/;

// Signed in once per account (the per-IP auth rate limit is shared with the other specs).
test.describe.configure({ mode: 'serial' });

async function portalLogin(browser: Browser, email: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto('/portal');
  await expect(page).toHaveURL(/\/portal\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  return page;
}

let user: Page;
let caseUrl = '';

test.beforeAll(async ({ browser }) => {
  user = await portalLogin(browser, CLIENT_USER);
});

test.afterAll(async () => {
  await user.close();
});

test('M4 DoD: client creates a case, uploads a 300-page PDF (interrupted, resumed) and submits it', async () => {
  test.setTimeout(120_000);
  const page = user;
  // client users see no billing or firm admin
  const nav = page.getByRole('navigation', { name: 'Portal' });
  await expect(nav.getByRole('link', { name: 'Billing' })).toHaveCount(0);

  await page.getByRole('link', { name: 'New case' }).click();
  await page.getByLabel('Matter name').fill(MATTER);
  await page.getByLabel('Case reference (optional)').fill('ACME-PI-E2E');
  await page.getByLabel('Patient / plaintiff name').fill('Ramiro608 Jacobs452');
  await page.getByLabel('Date of incident (optional)').fill('2025-03-14');
  await page.getByLabel('Case type').selectOption('personal_injury');
  await page.getByLabel('Priority').selectOption('high');
  await page.getByLabel('Summary').uncheck();
  await page.getByLabel('Notes for Datascribe (optional)').fill('Synthetic ER and clinic records.');
  await page.getByRole('button', { name: 'Create case' }).click();

  await expect(page).toHaveURL(/\/portal\/cases\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(MATTER);
  caseUrl = page.url();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft');
  await expect(page.getByText('Ramiro608 Jacobs452')).toBeVisible();

  // ~12 MB → 3 parts of 5 MiB. Part 2 keeps failing until the "network" comes back.
  const pdf = await syntheticRecordPdf({ pages: 300, padBytes: 11 * 1024 * 1024 });
  const isPart2 = (url: URL) => url.port === '9000' && url.searchParams.get('partNumber') === '2';
  await page.route(isPart2, (route) => route.abort('connectionreset'));

  await page.getByLabel('Add records').setInputFiles({
    name: FILE,
    mimeType: 'application/pdf',
    buffer: Buffer.from(pdf.bytes),
  });
  const resume = page.getByRole('button', { name: `Resume ${FILE}` });
  await expect(resume).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Interrupted', { exact: true })).toBeVisible();
  const progress = page.getByRole('progressbar', { name: `Upload progress for ${FILE}` });
  const pct = Number(await progress.getAttribute('aria-valuenow'));
  expect(pct).toBeGreaterThan(0);
  expect(pct).toBeLessThan(100);
  // the half-finished upload is listed on the case
  await expect(page.getByText('Incomplete. Choose the same file again to resume.')).toBeVisible();

  // network back: resuming sends only the missing part
  await page.unroute(isPart2);
  const sent: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (r.method() === 'PUT' && url.port === '9000') sent.push(url.searchParams.get('partNumber')!);
  });
  await resume.click();

  const row = page.getByRole('row').filter({ hasText: FILE });
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 60_000 });
  await expect(row.getByRole('cell', { name: '300', exact: true })).toBeVisible();
  await expect(row).toContainText('SHA-256');
  expect(sent).toEqual(['2']);

  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: `Download ${FILE}` }).click();
  expect((await download).suggestedFilename()).toBe(FILE);

  await page.getByRole('button', { name: 'Submit to Datascribe' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Submitted');
  await expect(page.getByRole('list', { name: 'Status timeline' })).toContainText('Submitted');
  await expect(page.getByRole('button', { name: 'Edit case' })).toHaveCount(0);

  await page.getByLabel('Message to Datascribe').fill('All records are uploaded (synthetic).');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
    'All records are uploaded (synthetic).',
  );
});

test('portal: the case list finds the case; the dashboard counts it', async () => {
  const page = user;
  await page
    .getByRole('navigation', { name: 'Portal' })
    .getByRole('link', { name: 'Cases' })
    .click();
  await page.getByLabel('Search matter, reference or case number').fill('ACME-PI-E2E');
  await page.getByRole('button', { name: 'Search' }).click();
  const row = page.getByRole('row').filter({ hasText: MATTER });
  // the worker's pipeline may already have moved it on (M5)
  await expect(row).toContainText(PAST_SUBMIT);
  await page.getByLabel('Status').selectOption('draft');
  await expect(page.getByRole('row').filter({ hasText: MATTER })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Portal' })
    .getByRole('link', { name: 'Dashboard' })
    .click();
  await expect(page.getByRole('list', { name: 'Open cases by status' })).toContainText(PAST_SUBMIT);
});

test('portal: client admin sees the case, invites a colleague and pays an invoice by card', async ({
  browser,
  request,
}) => {
  // finance issues a one-off invoice to Acme through the API (staff sign-in needs TOTP)
  const first = await request.post('/api/v1/auth/login', {
    data: { email: 'finance@datascribe.example', password: TEST_PASSWORD },
  });
  const { mfaToken } = await first.json();
  const second = await request.post('/api/v1/auth/mfa/verify', {
    data: { mfaToken, code: authenticator.generate(TEST_TOTP_SECRET) },
  });
  const staff = { authorization: `Bearer ${(await second.json()).accessToken}` };
  const subs = await (
    await request.get('/api/v1/subscriptions?limit=500', { headers: staff })
  ).json();
  const acme = subs.items.find((s: { organization: { name: string } }) =>
    s.organization.name.startsWith('Acme'),
  ).organizationId;
  const created = await request.post('/api/v1/invoices', {
    headers: staff,
    data: {
      organizationId: acme,
      lines: [{ description: 'Rush chronology (synthetic)', quantity: 1, unitPrice: '240' }],
    },
  });
  expect(created.status()).toBe(201);
  const invoice = await created.json();

  const admin = await portalLogin(browser, CLIENT_ADMIN);
  // the firm admin sees every firm case, including the colleague's
  await admin.goto(caseUrl);
  await expect(admin.getByRole('heading', { level: 1 })).toContainText(MATTER);
  await expect(admin.getByRole('heading', { name: 'Shared with' })).toBeVisible();

  const nav = admin.getByRole('navigation', { name: 'Portal' });
  await nav.getByRole('link', { name: 'Firm' }).click();
  await expect(admin.getByRole('row').filter({ hasText: CLIENT_USER })).toBeVisible();
  const colleague = `paralegal.${Date.now()}@acme.example`;
  await admin.getByLabel('Email').fill(colleague);
  await admin.getByRole('button', { name: 'Send invite' }).click();
  await expect(admin.getByRole('status')).toContainText(`Invite sent to ${colleague}`);
  await expect(admin.getByText(colleague)).toHaveCount(2);

  await nav.getByRole('link', { name: 'Billing' }).click();
  await expect(admin.getByRole('meter', { name: 'Pages used this period' })).toBeVisible();
  await admin.getByRole('link', { name: invoice.number }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('issued');
  await admin.getByRole('button', { name: /Pay .* by card/ }).click();

  // Fake gateway's simulated checkout (no Stripe key in dev/E2E, D-042)
  await expect(admin.getByRole('heading', { name: 'Simulated checkout' })).toBeVisible();
  await admin.getByRole('button', { name: /^Pay / }).click();
  await expect(admin.getByRole('heading', { name: 'Payment received' })).toBeVisible();

  await admin.goto(`/portal/billing/invoices/${invoice.id}?paid=1`);
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('paid');
  await expect(admin.getByText('succeeded')).toBeVisible();
  await admin.close();
});
