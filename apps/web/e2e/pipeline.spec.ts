import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { TEST_PASSWORD, TEST_TOTP_SECRET } from '../../api/test/constants';
import { pipelineResult } from '../../api/test/pipeline-check';
import { SYNTHETIC_CASE_PAGES, syntheticCasePdf } from '../../api/test/synthetic-pdf';
import { E2E, E2E_PHI_KEY } from '../playwright.config';

const FILE = 'synthetic-case-records.pdf';
const MATTER = `Jacobs v. Lakeside Transit (synthetic ${Date.now()})`;

test('M5 DoD: an uploaded case runs through the pipeline to review, every chronology entry cited', async ({
  page,
  browser,
}) => {
  test.setTimeout(210_000);
  await page.goto('/portal');
  await page.getByLabel('Email').fill('client.user@acme.example');
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'New case' }).click();
  await page.getByLabel('Matter name').fill(MATTER);
  await page.getByLabel('Patient / plaintiff name').fill('Ramiro608 Jacobs452');
  await page.getByLabel('Case type').selectOption('personal_injury');
  await page.getByRole('button', { name: 'Create case' }).click();
  await expect(page).toHaveURL(/\/portal\/cases\/(?!new$)[^/]+$/);
  const caseId = new URL(page.url()).pathname.split('/').pop()!;

  // stage 1 runs in the worker as the upload completes
  await page.getByLabel('Add records').setInputFiles({
    name: FILE,
    mimeType: 'application/pdf',
    buffer: Buffer.from(await syntheticCasePdf()),
  });
  const row = page.getByRole('row').filter({ hasText: FILE });
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Submit to Datascribe' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Submitted');

  // scan → extract → classify → events → coding → deliverables → ready for review
  const heading = page.getByRole('heading', { level: 1 });
  await expect
    .poll(
      async () => {
        await page.reload();
        return heading.textContent();
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toContain('In review');
  const timeline = page.getByRole('list', { name: 'Status timeline' });
  await expect(timeline).toContainText('Processing');
  await expect(timeline).toContainText('In review');

  const result = await pipelineResult(E2E.dbUrl, E2E_PHI_KEY, caseId);
  // one succeeded job per §7 stage
  expect(result.jobs.map((j) => [j.stage, j.status])).toEqual(
    [
      'scan',
      'extract',
      'classify',
      'extract_events',
      'code',
      'build_deliverables',
      'ready_for_review',
    ].map((s) => [s, 'succeeded']),
  );
  // stage 7 told the case managers (no summarizer assigned yet) that the case is ready (M9)
  expect(result.noticeTypes).toContain('processing_complete');
  // every page stored (encrypted) and classified
  expect(result.pages).toHaveLength(SYNTHETIC_CASE_PAGES.length);
  for (const p of result.pages) expect(p.encrypted).toBe(true);
  expect(new Set(result.pages.map((p) => p.recordType))).toContain('billing');

  expect(result.types).toEqual(['chronology', 'index', 'summary']);
  expect(result.index.rows.length).toBeGreaterThan(0);
  expect(result.summary?.kind).toBe('summary');

  // the DoD: dated, in order, and every entry cites a real page of the uploaded file
  const entries = result.chronology.entries;
  expect(entries.length).toBeGreaterThanOrEqual(5);
  const dates = entries.map((e) => e.date);
  expect(dates.slice(0, 5)).toEqual([
    '2025-01-05',
    '2025-02-01',
    '2025-02-10',
    '2025-03-14',
    '2025-04-02',
  ]);
  for (const e of entries) {
    expect(e.citation.fileName).toBe(FILE);
    expect(e.citation.pageNumber).toBeGreaterThanOrEqual(1);
    expect(e.citation.pageNumber).toBeLessThanOrEqual(SYNTHETIC_CASE_PAGES.length);
  }

  // M6 part 2 (D-084): staff open the workspace; a chronology entry jumps to its source page
  const staff = await staffPage(browser, 'ops.manager@datascribe.example');
  await staff.goto(`/console/cases/${caseId}`);
  await expect(staff.getByRole('heading', { level: 1 })).toContainText(MATTER);
  await expect(staff.getByLabel('Document')).toContainText(FILE);
  const target = entries[entries.length - 1]!;
  const items = staff
    .getByRole('tabpanel', { name: 'Chronology' })
    .getByRole('list', { name: 'Chronology entries' })
    .getByRole('listitem');
  // the ops manager may view drafts but not edit them
  await expect(
    staff.getByRole('tabpanel', { name: 'Chronology' }).getByRole('button', { name: 'Edit' }),
  ).toHaveCount(0);
  await expect(items).toHaveCount(entries.length);
  await items.last().getByRole('button').click();
  await expect(
    staff.getByRole('button', { name: `Page ${target.citation.pageNumber}`, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  // part 2b (D-085): the page the worker rendered, with thumbnails, and the text view on demand
  const pageLabel = `Page ${target.citation.pageNumber} of ${SYNTHETIC_CASE_PAGES.length}`;
  const pictured = staff.getByRole('region', { name: 'Page image' });
  await expect(pictured).toContainText(pageLabel);
  const img = pictured.getByRole('img', { name: `Page ${target.citation.pageNumber} of ${FILE}` });
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1100);
  await expect(staff.getByRole('list', { name: 'Pages' }).locator('img').first()).toHaveJSProperty(
    'complete',
    true,
  );
  await staff.getByRole('button', { name: 'Text', exact: true }).click();
  const text = staff.getByRole('region', { name: 'Page text' });
  await expect(text).toContainText(pageLabel);
  await expect(text.locator('pre')).not.toHaveText(/Loading…|No text on this page\./);
  await staff.getByRole('tab', { name: 'Index' }).click();
  await expect(staff.getByRole('tabpanel', { name: 'Index' })).toContainText(FILE);
  await staff.close();

  // part 3b (D-087): an editor edits an entry (a new version), then restores the pipeline's. The
  // super admin, because crm.spec resets the case manager's password.
  const cm = await staffPage(browser, 'super.admin@datascribe.example');
  await cm.goto(`/console/cases/${caseId}`);
  const panel = cm.getByRole('tabpanel', { name: 'Chronology' });
  const first = panel
    .getByRole('list', { name: 'Chronology entries' })
    .getByRole('listitem')
    .first();
  await panel.getByRole('button', { name: 'Edit', exact: true }).click();
  const edited = 'Follow-up visit, edited by staff (synthetic)';
  const description = panel.getByLabel('Entry 1 description');
  const original = await description.inputValue();
  expect(original).not.toBe('');
  await description.fill(edited);
  await panel.getByRole('button', { name: 'Save new version' }).click();
  await expect(first).toContainText(edited);
  await expect(panel).toContainText('Version 2 · draft · edited by');
  const history = panel.getByRole('region', { name: 'Version history' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await history.getByRole('button', { name: 'Restore version 1' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(3);
  await expect(first).toContainText(original);
  await expect(panel).toContainText('Version 3 · draft');

  // part 4b (D-089): QA. The editor assigns the seeded QA reviewer and submits; the reviewer asks
  // for changes, the editor resubmits, the reviewer approves and the drafts lock.
  const status = cm.getByRole('heading', { level: 1 }).locator('..');
  await expect(cm.getByRole('button', { name: 'Submit for QA' })).toBeVisible();
  await cm.getByRole('button', { name: 'Assign', exact: true }).click();
  const assign = cm.getByRole('dialog', { name: /^Assign / });
  const reviewer = assign.getByLabel('QA reviewer');
  await expect(reviewer).toBeEnabled();
  await reviewer.selectOption({ label: await optionLabel(reviewer, 'Seed QA Reviewer') });
  await assign.getByRole('button', { name: 'Save' }).click();
  await expect(assign).toBeHidden();
  await expect(cm.getByRole('region', { name: 'Assignees' })).toContainText(
    'QA reviewer: Seed QA Reviewer',
  );
  await cm.getByRole('button', { name: 'Submit for QA' }).click();
  await expect(status).toContainText('Quality check');
  await expect(panel).toContainText('Version 3 · in qa');
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  const qa = await staffPage(browser, 'qa.reviewer@datascribe.example');
  await qa.goto(`/console/cases/${caseId}`);
  const decision = qa.getByRole('form', { name: 'QA decision' });
  await decision.getByRole('button', { name: 'Request changes' }).click();
  await expect(decision.getByRole('alert')).toHaveText('Say what needs to change');
  const comment = 'Entry 1: add the provider (synthetic QA note)';
  await decision.getByLabel('QA comments').fill(comment);
  await decision.getByRole('button', { name: 'Request changes' }).click();
  await expect(qa.getByRole('heading', { level: 1 }).locator('..')).toContainText(
    'Changes requested',
  );
  await expect(decision).toHaveCount(0);

  await cm.reload();
  const qaHistory = cm.getByRole('region', { name: 'QA history' });
  await expect(qaHistory.getByRole('listitem')).toHaveCount(1);
  await expect(qaHistory).toContainText('Changes requested');
  await expect(qaHistory).toContainText(comment);
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await cm.getByRole('button', { name: 'Submit for QA' }).click();
  await expect(status).toContainText('Quality check');

  await qa.reload();
  await decision.getByRole('button', { name: 'Approve' }).click();
  // the worker delivers an approved case within seconds (D-098), so either state may show
  await expect(qa.getByRole('heading', { level: 1 }).locator('..')).toContainText(
    /Approved|Delivered/,
  );
  const approvedHistory = qa.getByRole('region', { name: 'QA history' });
  await expect(approvedHistory.getByRole('listitem')).toHaveCount(2);
  await expect(approvedHistory.getByRole('listitem').first()).toContainText('Approved');
  await expect(qa.getByRole('tabpanel', { name: 'Chronology' })).toContainText(
    /Version 3 · (approved|delivered)/,
  );
  await qa.close();

  // M6 part 5: the final report is rendered and the case delivered
  await expect(async () => {
    await cm.reload();
    await expect(status).toContainText('Delivered', { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(cm.getByRole('button', { name: 'Submit for QA' })).toHaveCount(0);
  await cm.close();
});

/** The full text of the option starting with `name` (options read "Name (3 open)"). */
async function optionLabel(select: Locator, name: string): Promise<string> {
  const labels = await select.locator('option').allTextContents();
  const label = labels.find((l) => l.startsWith(name));
  expect(label, `option ${name}`).toBeTruthy();
  return label!;
}

async function staffPage(browser: Browser, email: string): Promise<Page> {
  const p = await browser.newPage();
  await p.goto('/console/cases');
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill(TEST_PASSWORD);
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByLabel('Authentication code').fill(authenticator.generate(TEST_TOTP_SECRET));
  await p.getByRole('button', { name: 'Verify' }).click();
  await expect(p).not.toHaveURL(/\/console\/login/);
  return p;
}
