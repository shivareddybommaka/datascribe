#!/usr/bin/env node
/**
 * Local staging CLI (D-124, docs/STAGING.md). Account nova, repo root:
 *
 *   node scripts/staging.mjs check       validate .env.staging (names only, never values)
 *   node scripts/staging.mjs db:reset    create/empty the staging DB, migrate, synthetic seed + demo leads
 *   node scripts/staging.mjs db:migrate  apply new migrations, keep the data
 *   node scripts/staging.mjs db:seed     seed again (idempotent upserts)
 *   node scripts/staging.mjs build       production build of the web app for staging
 *   node scripts/staging.mjs start       run api + worker + web on 127.0.0.1 (web :3020) until stopped
 *   node scripts/staging.mjs tunnel      optional, separate: Datascribe's own Cloudflare tunnel (D-126)
 *   node scripts/staging.mjs stop        stop a running `start` and `tunnel`
 *
 * `--env-file <path>` picks another env file (default .env.staging). The tunnel runs exactly
 *   /opt/homebrew/bin/cloudflared tunnel --config infra/staging/cloudflared.yml run --token-file .env.tunnel-token
 * and the token is never read or printed here.
 */
import path from 'node:path';
import {
  ROOT,
  assertStaging,
  buildWeb,
  clearPid,
  devSeedPasswords,
  migrateDatabase,
  readEnvFile,
  resetDatabase,
  runTunnel,
  seedDatabase,
  seedPasswordProblem,
  stagingEnv,
  startStack,
  stopRunning,
  writePid,
} from './staging-lib.mjs';

const [command, ...rest] = process.argv.slice(2);
const flag = rest.indexOf('--env-file');
const envFile = flag >= 0 ? rest[flag + 1] : '.env.staging';
const DIST_DIR = '.next-staging';

async function main() {
  if (command === 'stop') {
    console.log(stopRunning('tunnel') ? 'Stopping the tunnel…' : 'The tunnel is not running.');
    console.log(stopRunning('staging') ? 'Stopping staging…' : 'Staging is not running.');
    return;
  }
  if (command === 'tunnel') {
    // no .env.staging needed: the tunnel only forwards to 127.0.0.1:3020
    process.exit(await runTunnel());
  }
  const env = stagingEnv(readEnvFile(envFile), { ENV_FILE: path.resolve(ROOT, envFile) });
  assertStaging(env);
  switch (command) {
    case 'check': {
      const seed = seedPasswordProblem(env.SEED_USER_PASSWORD, devSeedPasswords());
      if (seed) throw new Error(`Staging environment refused:\n  ${seed}`);
      console.log(`${envFile}: OK for staging (web :${env.WEB_PORT}, API :${env.API_PORT}).`);
      break;
    }
    case 'db:reset':
      resetDatabase(env);
      console.log('Staging database reset and seeded (synthetic data + demo leads).');
      break;
    case 'db:migrate':
      migrateDatabase(env);
      break;
    case 'db:seed':
      seedDatabase(env);
      break;
    case 'build':
      buildWeb(env, DIST_DIR);
      console.log(`Staging build ready in apps/web/${DIST_DIR}.`);
      break;
    case 'start': {
      const stack = await startStack(env, { distDir: DIST_DIR });
      writePid('staging');
      const stop = () => void stack.stop(0);
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      console.log(
        `Staging is up: web http://127.0.0.1:${env.WEB_PORT} (tunnel target), API 127.0.0.1:${env.API_PORT}. Ctrl-C or \`pnpm staging:stop\` to stop.`,
      );
      const code = await stack.finished;
      clearPid('staging');
      process.exit(code);
      break;
    }
    default:
      console.error(
        'Usage: node scripts/staging.mjs <check|db:reset|db:migrate|db:seed|build|start|tunnel|stop> [--env-file .env.staging]',
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
