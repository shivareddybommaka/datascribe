/**
 * Lighthouse on the public M3 pages (D-127): builds the web app into .next-lighthouse, starts it on
 * LIGHTHOUSE_PORT (3800), runs Lighthouse (mobile preset, performance + SEO) LIGHTHOUSE_RUNS times
 * per page with the installed Google Chrome (CHROME_PATH to pick another) and writes the median
 * scores into docs/LIGHTHOUSE.md between the lighthouse markers. Exits 1 if a page is below 90.
 *
 * CMS_URL defaults to `none` (bundled copy, same layout as the CMS pages). Pricing lists the plans
 * only when the API at API_URL is up; otherwise it shows the "unavailable" message.
 * LIGHTHOUSE_SKIP_BUILD=1 reuses the last build.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(webDir, '../..');
const docPath = path.join(rootDir, 'docs/LIGHTHOUSE.md');
const port = Number(process.env.LIGHTHOUSE_PORT ?? 3800);
const runs = Number(process.env.LIGHTHOUSE_RUNS ?? 3);
const distDir = '.next-lighthouse';
const pages = [
  '/',
  '/services',
  '/pricing',
  '/about',
  '/contact',
  '/ai-medical-summary',
  '/resources',
];
const TARGET = 90;
const bin = (name, dir = webDir) => path.join(dir, 'node_modules/.bin', name);

const env = {
  ...process.env,
  NEXT_DIST_DIR: distDir,
  NEXT_TELEMETRY_DISABLED: '1',
  CMS_URL: process.env.CMS_URL ?? 'none',
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: webDir, env, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited with ${code}`)),
    );
  });
}

/** next build rewrites next-env.d.ts and tsconfig.json with the dist dir; put them back */
async function build() {
  const kept = ['next-env.d.ts', 'tsconfig.json'].map((f) => [
    f,
    fs.readFileSync(path.join(webDir, f)),
  ]);
  try {
    await run(bin('next'), ['build']);
  } finally {
    for (const [f, data] of kept) fs.writeFileSync(path.join(webDir, f), data);
  }
}

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer within ${ms / 1000}s`);
}

async function audit(url, outFile) {
  await run(
    bin('lighthouse'),
    [
      url,
      '--only-categories=performance,seo',
      '--output=json',
      `--output-path=${outFile}`,
      '--chrome-flags=--headless=new',
      '--quiet',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  // audits that count towards the score (weight > 0); the unweighted insights are hints only
  const failed = (category) =>
    report.categories[category].auditRefs
      .filter((ref) => ref.weight > 0)
      .map((ref) => report.audits[ref.id])
      .filter((a) => a.score !== null && a.score < 0.9)
      .map((a) => a.id);
  return {
    performance: Math.round(report.categories.performance.score * 100),
    seo: Math.round(report.categories.seo.score * 100),
    lcp: report.audits['largest-contentful-paint'].numericValue,
    tbt: report.audits['total-blocking-time'].numericValue,
    cls: report.audits['cumulative-layout-shift'].numericValue,
    failing: [...new Set([...failed('performance'), ...failed('seo')])],
    lighthouse: report.lighthouseVersion,
  };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function writeDoc(rows, version) {
  const date = new Date().toISOString().slice(0, 10);
  const table = [
    `Measured ${date} with Lighthouse ${version}, mobile preset, median of ${runs} runs, \`next start\``,
    `on :${port} (CMS_URL=${env.CMS_URL}). Target ≥ ${TARGET}.`,
    '',
    '| Page | Performance | SEO | LCP (ms) | TBT (ms) | CLS | Weighted audits below 0.9 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.page}\` | ${r.performance} | ${r.seo} | ${Math.round(r.lcp)} | ${Math.round(r.tbt)} | ${r.cls.toFixed(3)} | ${r.failing.join(', ') || '—'} |`,
    ),
  ].join('\n');
  const block = `<!-- lighthouse:start -->\n${table}\n<!-- lighthouse:end -->`;
  const doc = fs.existsSync(docPath)
    ? fs.readFileSync(docPath, 'utf8')
    : '# Lighthouse\n\n<!-- lighthouse:start -->\n<!-- lighthouse:end -->\n';
  fs.writeFileSync(
    docPath,
    doc.replace(/<!-- lighthouse:start -->[\s\S]*<!-- lighthouse:end -->/, block),
  );
  return run(bin('prettier', rootDir), ['--write', '--log-level', 'warn', docPath]);
}

if (process.env.LIGHTHOUSE_SKIP_BUILD !== '1') await build();
const server = spawn(bin('next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], {
  cwd: webDir,
  env,
  stdio: ['ignore', 'ignore', 'inherit'],
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-lighthouse-'));
try {
  await waitFor(`http://127.0.0.1:${port}/`);
  const rows = [];
  let version = '';
  for (const page of pages) {
    const results = [];
    for (let i = 0; i < runs; i++)
      results.push(await audit(`http://127.0.0.1:${port}${page}`, path.join(tmp, 'report.json')));
    version = results[0].lighthouse;
    const byPerf = [...results].sort((a, b) => a.performance - b.performance);
    const mid = byPerf[Math.floor(byPerf.length / 2)];
    rows.push({ page, ...mid, seo: median(results.map((r) => r.seo)) });
    console.log(`${page}: performance ${mid.performance}, SEO ${rows.at(-1).seo}`);
  }
  await writeDoc(rows, version);
  const low = rows.filter((r) => r.performance < TARGET || r.seo < TARGET);
  if (low.length) {
    console.error(`Below ${TARGET}: ${low.map((r) => r.page).join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
