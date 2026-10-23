// Reset + migrate + seed the e2e DB with the same routine the API integration tests use.
// TEST_DATABASE_URL is set to the *_e2e database in playwright.config.ts; the routine refuses
// any database whose name doesn't end in _test or _e2e.
import apiSetup from '../../api/test/global-setup';

export default async function globalSetup() {
  if (!process.env.TEST_DATABASE_URL?.endsWith('/datascribe_e2e')) {
    throw new Error('E2E must run against datascribe_e2e');
  }
  await apiSetup();
}
