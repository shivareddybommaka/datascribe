/**
 * Load test (§12 M10, docs/LOAD-TEST.md). Runs against an API that is already running locally; it
 * starts nothing itself. Prints timings, throughput and status counts only, never response bodies.
 *
 *   pnpm load
 *
 * Env (read from the root .env): API_PORT, APP_URL, SEED_USER_PASSWORD, RATE_LIMIT_AUTH,
 * RATE_LIMIT_PUBLIC, RATE_LIMIT_ACCOUNT. Optional: LOAD_API_URL, LOAD_EMAIL, LOAD_PASSWORD,
 * LOAD_DURATION (seconds per run, default 10), LOAD_CONNECTIONS (default "1,10,50").
 */
import { randomBytes } from 'node:crypto';
import autocannon from 'autocannon';
import {
  assertLocalTarget,
  parseLevels,
  percentile,
  summarise,
  tableRows,
  type Summary,
} from './stats.js';

const env = process.env;
const base = assertLocalTarget(env.LOAD_API_URL ?? `http://localhost:${env.API_PORT ?? '4000'}`);
const api = `${base.origin}/api/v1`;
const appUrl = env.APP_URL ?? 'http://localhost:3010';
const email = env.LOAD_EMAIL ?? 'client.admin@acme.example';
const password = env.LOAD_PASSWORD ?? env.SEED_USER_PASSWORD;
const durationS = Number(env.LOAD_DURATION ?? 10);
const levels = parseLevels(env.LOAD_CONNECTIONS, [1, 10, 50]);
const limits = {
  auth: Number(env.RATE_LIMIT_AUTH ?? 30),
  public: Number(env.RATE_LIMIT_PUBLIC ?? 10),
  account: Number(env.RATE_LIMIT_ACCOUNT ?? 10),
};

/** The report goes to stdout (it is the script's output, not a log line). */
const out = (line: string) => process.stdout.write(`${line}\n`);

function fail(message: string): never {
  console.error(`load: ${message}`);
  process.exit(1);
}

/** The refresh cookie from a response (rotated on every refresh). */
function refreshCookieOf(res: Response): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(';')[0]!;
    if (pair.startsWith('ds_refresh=') && pair.length > 'ds_refresh='.length) return pair;
  }
  return undefined;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const res = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - started;
  return { res, ms };
}

async function signIn() {
  if (!password) fail('set SEED_USER_PASSWORD (or LOAD_PASSWORD) for the seeded user');
  const { res } = await post('/auth/login', { email, password });
  if (res.status !== 200) fail(`sign-in failed with HTTP ${res.status}`);
  const body = (await res.json()) as { accessToken?: string; mfaRequired?: boolean };
  if (!body.accessToken) fail('the load user needs MFA; use a client user without MFA');
  const cookie = refreshCookieOf(res);
  if (!cookie) fail('no refresh cookie on sign-in');
  return { accessToken: body.accessToken, cookie };
}

async function firstCaseId(accessToken: string): Promise<string> {
  const res = await fetch(`${api}/cases?limit=1`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200) fail(`case list failed with HTTP ${res.status}`);
  const body = (await res.json()) as { items: { id: string }[] };
  if (!body.items[0]) fail('the load user sees no cases; run pnpm db:seed first');
  return body.items[0].id;
}

async function measure(
  label: string,
  path: string,
  connections: number,
  headers: Record<string, string>,
): Promise<Summary> {
  const latenciesMs: number[] = [];
  const statuses: Record<string, number> = {};
  const instance = autocannon({
    url: `${api}${path}`,
    connections,
    duration: durationS,
    headers,
    timeout: 10,
  });
  instance.on('response', (_client, statusCode, _bytes, ms) => {
    latenciesMs.push(ms);
    statuses[statusCode] = (statuses[statusCode] ?? 0) + 1;
  });
  const result = await instance;
  return summarise({
    label,
    connections,
    durationS,
    latenciesMs,
    statuses,
    errors: result.errors + result.timeouts,
  });
}

/** Sequential requests until the limiter answers; returns status counts and the 429's policy. */
async function probe(
  label: string,
  attempts: number,
  send: (i: number) => Promise<{ res: Response; ms: number }>,
) {
  const statuses: Record<string, number> = {};
  const okMs: number[] = [];
  let first429: number | undefined;
  let policy: string | undefined;
  for (let i = 0; i < attempts; i++) {
    const { res, ms } = await send(i);
    await res.arrayBuffer(); // drain, not printed
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    if (res.status === 429) {
      first429 ??= i + 1;
      policy ??= res.headers.get('ratelimit-policy') ?? undefined;
    } else okMs.push(ms);
  }
  const counts = Object.entries(statuses)
    .map(([code, n]) => `${code}×${n}`)
    .join(' ');
  out(
    `| ${label} | ${attempts} | ${counts} | ${first429 ?? '-'} | ${policy ?? '-'} | ` +
      `${percentile(okMs, 50).toFixed(1)} | ${percentile(okMs, 95).toFixed(1)} |`,
  );
  return { statuses, first429 };
}

async function main() {
  out(`load: target ${base.origin}, ${durationS}s per run, connections ${levels.join(',')}`);
  const health = await fetch(`${api}/health`).catch(() => undefined);
  if (health?.status !== 200) fail('API not reachable; start it first (see docs/LOAD-TEST.md)');

  const session = await signIn();
  const caseId = await firstCaseId(session.accessToken);
  const bearer = { authorization: `Bearer ${session.accessToken}` };
  const routes: [string, string, Record<string, string>][] = [
    ['GET /health', '/health', {}],
    ['GET /auth/me', '/auth/me', bearer],
    ['GET /cases', '/cases', bearer],
    ['GET /cases/:id', `/cases/${caseId}`, bearer],
    ['GET /cases/:id/documents', `/cases/${caseId}/documents`, bearer],
  ];

  const rows: Summary[] = [];
  for (const [label, path, headers] of routes) {
    for (const connections of levels) {
      rows.push(await measure(label, path, connections, headers));
    }
  }
  out('\nThroughput (authenticated with one Bearer token)\n');
  for (const line of tableRows(rows)) out(line);

  // Rate-limited routes, one request at a time. The sign-in above used one `auth` slot.
  out('\nRate limits (sequential; expect 429 once each limit is used up)\n');
  out('| probe | requests | statuses | first 429 at | RateLimit-Policy | p50 ms | p95 ms |');
  out('| --- | ---: | --- | ---: | --- | ---: | ---: |');
  const nobody = `load-${randomBytes(6).toString('hex')}@example.test`;
  const account = await probe('login, one unknown account', limits.account + 2, () =>
    post('/auth/login', { email: nobody, password: 'not-the-password' }),
  );
  let cookie = session.cookie;
  const refresh = await probe('refresh (token rotated each time)', limits.auth + 2, async () => {
    const r = await post('/auth/refresh', {}, { cookie, 'x-datascribe-csrf': '1', origin: appUrl });
    cookie = refreshCookieOf(r.res) ?? cookie;
    return r;
  });
  const forgot = await probe('forgot, new unknown address each time', limits.public + 2, () =>
    post('/auth/forgot', { email: `load-${randomBytes(6).toString('hex')}@example.test` }),
  );
  await post('/auth/logout', {}, { cookie, 'x-datascribe-csrf': '1', origin: appUrl });

  const bad = rows.filter((r) => r.non2xx > 0 || r.errors > 0);
  const limited = [account, refresh, forgot].every((p) => p.first429 !== undefined);
  out(
    `\nload: ${bad.length} throughput run(s) with non-2xx or errors; rate limits ` +
      `${limited ? 'all answered 429' : 'did NOT all answer 429'}`,
  );
  if (bad.length > 0 || !limited) process.exitCode = 1;
}

main().catch((err: unknown) =>
  fail(err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected error'),
);
