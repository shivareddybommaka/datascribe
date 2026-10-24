/**
 * Local staging (D-124): build and run the production-built api, worker and web on this Mac for
 * Shiva's Cloudflare tunnel (https://datascribe.stayspot.app → http://localhost:3020).
 * Used by scripts/staging.mjs (CLI) and scripts/staging-smoke.mjs. No dependencies beyond Node.
 *
 * Values from the env file are never printed; problems name the variable only.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const ROOT = path.resolve(import.meta.dirname, '..');
const WEB_DIR = path.join(ROOT, 'apps/web');
const API_DIR = path.join(ROOT, 'apps/api');
const WORKER_DIR = path.join(ROOT, 'apps/worker');
const DB_DIR = path.join(ROOT, 'packages/db');
const bin = (dir, name) => path.join(dir, 'node_modules/.bin', name);

/** Ports that must never serve staging: StaySpot's CRM (3000, public), Shiva's dev preview (3010), the CRM's Postgres (5432). */
const FORBIDDEN_PORTS = new Set([3000, 3010, 5432]);
export const STAGING_WEB_PORT = 3020;

export function readEnvFile(file) {
  const full = path.resolve(ROOT, file);
  if (!fs.existsSync(full)) throw new Error(`${file} not found (copy .env.staging.example)`);
  return parseEnv(fs.readFileSync(full, 'utf8'));
}

/**
 * The environment every staging process gets: the env file's values plus the fixed staging
 * settings, on top of a minimal shell environment (so nothing from dev's .env or the caller's
 * shell, like analytics IDs, leaks in).
 */
export function stagingEnv(values, extra = {}) {
  const shell = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ']) {
    if (process.env[key]) shell[key] = process.env[key];
  }
  return {
    ...shell,
    ...values,
    NODE_ENV: 'production',
    DEPLOY_ENV: 'staging',
    // only the tunnel (through the web app) reaches staging from outside this Mac
    API_HOST: '127.0.0.1',
    NEXT_TELEMETRY_DISABLED: '1',
    ...extra,
  };
}

const portOf = (url, fallback) => {
  try {
    const u = new URL(url);
    return Number(u.port || fallback);
  } catch {
    return NaN;
  }
};

/** Problems the script can see before starting anything (the API and worker check the rest). */
export function stagingProblems(env, { smoke = false } = {}) {
  const problems = [];
  const webPort = Number(env.WEB_PORT);
  const apiPort = Number(env.API_PORT);
  if (!Number.isInteger(webPort) || FORBIDDEN_PORTS.has(webPort)) {
    problems.push('WEB_PORT: must be a port other than 3000, 3010 and 5432');
  } else if (!smoke && webPort !== STAGING_WEB_PORT) {
    problems.push(`WEB_PORT: staging's web app runs on ${STAGING_WEB_PORT} (the tunnel's target)`);
  }
  if (!Number.isInteger(apiPort) || FORBIDDEN_PORTS.has(apiPort) || apiPort === webPort) {
    problems.push('API_PORT: must be its own port, not 3000, 3010 or 5432');
  }
  if (portOf(env.API_URL, 80) !== apiPort) problems.push('API_URL: must point at API_PORT');
  for (const key of ['DATABASE_URL', 'CMS_DATABASE_URL']) {
    if (!env[key] && key === 'CMS_DATABASE_URL') continue;
    let db;
    try {
      db = new URL(env[key]);
    } catch {
      problems.push(`${key}: must be a postgresql:// URL`);
      continue;
    }
    if ((db.port || '5432') === '5432') problems.push(`${key}: never port 5432 (use 5433)`);
    if (!db.pathname.includes('staging'))
      problems.push(`${key}: database name must contain "staging"`);
  }
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'PHI_ENCRYPTION_KEY']) {
    if (!env[key]) problems.push(`${key}: required`);
  }
  if (!smoke && env.STAGING_ALLOW_HTTP_FOR_SMOKE) {
    problems.push('STAGING_ALLOW_HTTP_FOR_SMOKE: only the smoke test sets it');
  }
  return problems;
}

export function assertStaging(env, opts) {
  const problems = stagingProblems(env, opts);
  if (problems.length) throw new Error(`Staging environment refused:\n  ${problems.join('\n  ')}`);
}

function run(cmd, args, { cwd, env, quiet = false, input }) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    input,
    stdio: [
      input === undefined ? 'inherit' : 'pipe',
      quiet ? 'pipe' : 'inherit',
      quiet ? 'pipe' : 'inherit',
    ],
  });
  if (res.status !== 0) {
    const tail = quiet ? `\n${String(res.stderr ?? '').slice(-2000)}` : '';
    const err = new Error(
      `${path.basename(cmd)} ${args[0] ?? ''} failed (exit ${res.status})${tail}`,
    );
    err.stderr = String(res.stderr ?? '');
    throw err;
  }
}

const sql = (env, url, statement) =>
  run(bin(DB_DIR, 'prisma'), ['db', 'execute', '--url', url, '--stdin'], {
    cwd: DB_DIR,
    env,
    quiet: true,
    input: statement,
  });

/**
 * Create the staging database if missing, empty it (drop and re-create the public schema, as the
 * test setup does), apply the migrations and seed it with synthetic data.
 */
export function resetDatabase(env) {
  const url = new URL(env.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]*staging[a-z0-9_]*$/.test(name) || (url.port || '5432') === '5432') {
    throw new Error('DATABASE_URL: refusing to reset (name must contain "staging", port 5433)');
  }
  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';
  try {
    sql(env, admin.toString(), `CREATE DATABASE "${name}";`);
  } catch (err) {
    if (!/already exists/.test(err.stderr ?? '')) throw err;
  }
  sql(env, env.DATABASE_URL, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  migrateDatabase(env);
  seedDatabase(env);
}

/** Apply new migrations to an existing staging database (keeps its data). */
export function migrateDatabase(env) {
  run(bin(DB_DIR, 'prisma'), ['migrate', 'deploy'], { cwd: DB_DIR, env });
}

export const STAGING_SEED_PASSWORD_MIN = 20;

/** The dev SEED_USER_PASSWORD values on this Mac: this checkout's .env and the main checkout's. */
export function devSeedPasswords() {
  const files = new Set([path.join(ROOT, '.env')]);
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (common.status === 0) files.add(path.join(path.dirname(common.stdout.trim()), '.env'));
  const values = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const value = parseEnv(fs.readFileSync(file, 'utf8')).SEED_USER_PASSWORD;
    if (value) values.push(value);
  }
  return values;
}

/**
 * Staging is on the open internet (D-125): its seeded accounts get their own password, long and
 * never dev's. Returns the problem (variable name only) or null.
 */
export function seedPasswordProblem(password, devPasswords) {
  if (!password || password.length < STAGING_SEED_PASSWORD_MIN) {
    return `SEED_USER_PASSWORD: staging needs its own, ${STAGING_SEED_PASSWORD_MIN}+ characters`;
  }
  if (devPasswords.includes(password)) {
    return "SEED_USER_PASSWORD: must not reuse dev's SEED_USER_PASSWORD (.env)";
  }
  return null;
}

/** Synthetic seed (users, orgs, plans, three synthetic cases) plus the demo leads. */
export function seedDatabase(env) {
  const problem = seedPasswordProblem(env.SEED_USER_PASSWORD, devSeedPasswords());
  if (problem) throw new Error(problem);
  // the seed scripts refuse NODE_ENV=production; the staging-only database name was checked above
  const seedEnv = { ...env, NODE_ENV: 'development', DEPLOY_ENV: '' };
  run(bin(DB_DIR, 'tsx'), ['prisma/seed.ts'], { cwd: DB_DIR, env: seedEnv });
  run(bin(DB_DIR, 'tsx'), ['prisma/seed-demo.ts'], { cwd: DB_DIR, env: seedEnv });
}

const STAMP = 'STAGING_BUILD.json';

/** Production build of the web app for staging, in its own dist dir, stamped. */
export function buildWeb(env, distDir) {
  run(bin(DB_DIR, 'prisma'), ['generate'], { cwd: DB_DIR, env, quiet: true });
  const buildEnv = { ...env, NEXT_DIST_DIR: distDir };
  // `next build` adds its dist dir to tsconfig.json / next-env.d.ts; keep the committed files
  const keep = ['tsconfig.json', 'next-env.d.ts'].map((f) => path.join(WEB_DIR, f));
  const saved = keep.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  try {
    run(bin(WEB_DIR, 'next'), ['build'], { cwd: WEB_DIR, env: buildEnv });
  } finally {
    keep.forEach((f, i) => saved[i] && fs.writeFileSync(f, saved[i]));
  }
  fs.writeFileSync(
    path.join(WEB_DIR, distDir, STAMP),
    `${JSON.stringify({ deployEnv: 'staging', appUrl: env.APP_URL, builtAt: new Date().toISOString() })}\n`,
  );
}

function checkStamp(env, distDir) {
  const file = path.join(WEB_DIR, distDir, STAMP);
  if (!fs.existsSync(file)) {
    throw new Error(`No staging build in apps/web/${distDir}: run the staging build first`);
  }
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (stamp.deployEnv !== 'staging' || stamp.appUrl !== env.APP_URL) {
    throw new Error('The staging build was made for another APP_URL: build again');
  }
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

export async function waitFor(url, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not come up in ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function prefixed(stream, label, out) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) out.write(`[${label}] ${line}\n`);
  });
}

/**
 * Start api, worker and web (production build) and supervise them: if one exits, all stop.
 * Resolves once the API health check and the web app answer; `stop()` ends them all.
 */
export async function startStack(env, { distDir, name = 'staging' }) {
  checkStamp(env, distDir);
  for (const port of [Number(env.WEB_PORT), Number(env.API_PORT)]) {
    if (!(await portFree(port))) throw new Error(`Port ${port} is already in use`);
  }
  const procs = [
    { label: 'api', cmd: bin(API_DIR, 'tsx'), args: ['src/server.ts'], cwd: API_DIR },
    { label: 'worker', cmd: bin(WORKER_DIR, 'tsx'), args: ['src/index.ts'], cwd: WORKER_DIR },
    {
      label: 'web',
      cmd: bin(WEB_DIR, 'next'),
      args: ['start', '--port', String(env.WEB_PORT), '--hostname', '127.0.0.1'],
      cwd: WEB_DIR,
      env: { NEXT_DIST_DIR: distDir },
    },
  ];
  let stopping = false;
  const children = procs.map((p) => {
    const child = spawn(p.cmd, p.args, {
      cwd: p.cwd,
      env: { ...env, ...p.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prefixed(child.stdout, p.label, process.stdout);
    prefixed(child.stderr, p.label, process.stderr);
    child.on('exit', (code, signal) => {
      if (stopping) return;
      process.stderr.write(`[${name}] ${p.label} exited (${signal ?? code}); stopping staging\n`);
      void stop(1);
    });
    return child;
  });

  const exited = (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => child.once('exit', r));
  let done;
  const finished = new Promise((r) => (done = r));
  async function stop(code = 0) {
    if (stopping) return finished;
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    const timer = setTimeout(() => children.forEach((c) => c.kill('SIGKILL')), 15_000);
    await Promise.all(children.map(exited));
    clearTimeout(timer);
    done(code);
    return finished;
  }

  try {
    await waitFor(`http://127.0.0.1:${env.API_PORT}/api/v1/health`);
    await waitFor(`http://127.0.0.1:${env.WEB_PORT}/robots.txt`);
  } catch (err) {
    await stop(1);
    throw err;
  }
  return { stop, finished };
}

/**
 * Datascribe's own staging tunnel (D-126), exactly:
 *   /opt/homebrew/bin/cloudflared tunnel --config infra/staging/cloudflared.yml run --token-file .env.tunnel-token
 * from the repo root. --config always: without it cloudflared reads ~/.cloudflared/config.yml
 * (StaySpot's tunnel). The token file is git-ignored and written by Shiva; this code never reads
 * or prints it, only checks that it exists, is non-empty and ignored by git.
 */
export const CLOUDFLARED = '/opt/homebrew/bin/cloudflared';
export const TUNNEL_CONFIG = 'infra/staging/cloudflared.yml';
export const TUNNEL_TOKEN_FILE = '.env.tunnel-token';
export const TUNNEL_ARGS = [
  'tunnel',
  '--config',
  TUNNEL_CONFIG,
  'run',
  '--token-file',
  TUNNEL_TOKEN_FILE,
];

/** cloudflared's env: the shell basics only. A TUNNEL_TOKEN / TUNNEL_* variable would override
 * --token-file or the config, so none is passed on. */
export function tunnelEnv(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function tunnelProblems(root = ROOT) {
  const problems = [];
  if (!fs.existsSync(CLOUDFLARED)) problems.push(`${CLOUDFLARED} not found`);
  if (!fs.existsSync(path.join(root, TUNNEL_CONFIG))) problems.push(`${TUNNEL_CONFIG} missing`);
  const token = path.join(root, TUNNEL_TOKEN_FILE);
  if (!fs.existsSync(token) || fs.statSync(token).size === 0) {
    problems.push(`${TUNNEL_TOKEN_FILE}: missing or empty (Shiva writes the tunnel token there)`);
  } else {
    const ignored = spawnSync('git', ['check-ignore', '-q', TUNNEL_TOKEN_FILE], { cwd: root });
    if (ignored.status !== 0) problems.push(`${TUNNEL_TOKEN_FILE}: must be git-ignored`);
  }
  return problems;
}

/** Run the tunnel in the foreground until stopped. Resolves with cloudflared's exit code. */
export async function runTunnel({ webPort = STAGING_WEB_PORT } = {}) {
  const problems = tunnelProblems();
  if (problems.length) throw new Error(`Tunnel not started:\n  ${problems.join('\n  ')}`);
  const mode = fs.statSync(path.join(ROOT, TUNNEL_TOKEN_FILE)).mode & 0o077;
  if (mode) {
    process.stderr.write(`[tunnel] ${TUNNEL_TOKEN_FILE} is readable by others: chmod 600 it\n`);
  }
  if (await portFree(webPort)) {
    process.stderr.write(
      `[tunnel] nothing on :${webPort} yet; start staging (pnpm staging:start)\n`,
    );
  }
  const child = spawn(CLOUDFLARED, TUNNEL_ARGS, {
    cwd: ROOT,
    env: tunnelEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  writePid('tunnel');
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const code = await new Promise((resolve) => child.once('exit', (c) => resolve(c ?? 0)));
  clearPid('tunnel');
  return code;
}

const pidFile = (name) => path.join(ROOT, '.data/staging', `${name}.pid`);

export function writePid(name) {
  fs.mkdirSync(path.dirname(pidFile(name)), { recursive: true });
  fs.writeFileSync(pidFile(name), `${process.pid}\n`);
}

export function clearPid(name) {
  fs.rmSync(pidFile(name), { force: true });
}

/** Ask a running `staging start` (by its pid file) to stop. */
export function stopRunning(name = 'staging') {
  const file = pidFile(name);
  if (!fs.existsSync(file)) return false;
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    clearPid(name);
    return false;
  }
}
