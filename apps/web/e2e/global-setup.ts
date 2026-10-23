// Reset + migrate + seed the e2e DB with the same routine the API integration tests use.
// TEST_DATABASE_URL is set to the *_e2e database in playwright.config.ts; the routine refuses
// any database whose name doesn't end in _test or _e2e.
import apiSetup from '../../api/test/global-setup';

export default async function globalSetup() {
  if (!/\/datascribe(_[a-z0-9]+)?_e2e$/.test(process.env.TEST_DATABASE_URL ?? '')) {
    throw new Error('E2E must run against a datascribe*_e2e database');
  }
  await apiSetup();
}
