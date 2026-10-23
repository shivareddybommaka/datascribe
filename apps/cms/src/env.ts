import fs from 'node:fs';
import path from 'node:path';

/**
 * The monorepo keeps one `.env` at the root. `pnpm --filter @datascribe/cms …` runs with the package
 * directory as cwd, for Next and for the Payload CLI alike. Variables already set win.
 */
export function loadRootEnv() {
  const file = path.resolve(process.cwd(), '../../.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
