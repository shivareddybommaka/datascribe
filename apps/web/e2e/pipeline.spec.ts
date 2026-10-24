import { expect, test } from '@playwright/test';
import { TEST_PASSWORD } from '../../api/test/constants';
import { pipelineResult } from '../../api/test/pipeline-check';
import { SYNTHETIC_CASE_PAGES, syntheticCasePdf } from '../../api/test/synthetic-pdf';
import { E2E, E2E_PHI_KEY } from '../playwright.config';

const FILE = 'synthetic-case-records.pdf';
const MATTER = `Jacobs v. Lakeside Transit (synthetic ${Date.now()})`;

test('M5 DoD: an uploaded case runs through the pipeline to review, every chronology entry cited', async ({
  page,
}) => {
  test.setTimeout(120_000);
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
});
