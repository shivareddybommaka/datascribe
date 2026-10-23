/**
 * §2/§5.1: GA4/GTM only on marketing pages, never in /console or /portal. Walks the import graph of
 * every route file outside app/(marketing) (plus the root layout, which wraps everything) and fails
 * if any of them can reach the analytics code or a Google tag URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'app');
const ANALYTICS_FILES = [
  path.join(root, 'components/marketing/consent-analytics.tsx'),
  path.join(root, 'lib/analytics.ts'),
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(e.name) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // packages: none of them contain the analytics code
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local file reachable from `entry` through static or dynamic imports. */
function reachable(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = fs.readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const next = resolveImport(entry, m[1]!);
    if (next) reachable(next, seen);
  }
  return seen;
}

const marketingDir = path.join(appDir, '(marketing)');
const appRoutes = walk(appDir).filter(
  (f) => !f.startsWith(marketingDir + path.sep) && !/\.test\.tsx?$/.test(f),
);

describe('analytics boundary', () => {
  it('finds the console, portal and invite routes to check', () => {
    const rel = appRoutes.map((f) => path.relative(appDir, f));
    expect(rel).toContain('layout.tsx');
    expect(rel.some((f) => f.startsWith('console/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('portal/'))).toBe(true);
    expect(rel.some((f) => f.startsWith('invite/'))).toBe(true);
  });

  it.each(appRoutes.map((f) => [path.relative(appDir, f), f]))(
    '%s cannot reach GA4/GTM code',
    (_name, file) => {
      const files = reachable(file as string);
      for (const a of ANALYTICS_FILES) expect(files.has(a)).toBe(false);
      for (const f of files) {
        if (ANALYTICS_FILES.includes(f)) continue;
        expect(fs.readFileSync(f, 'utf8')).not.toMatch(/googletagmanager|gtag\(|dataLayer/);
      }
    },
  );

  it('the marketing layout is what renders the consent banner + tags', () => {
    const layout = path.join(marketingDir, 'layout.tsx');
    expect(reachable(layout).has(ANALYTICS_FILES[0]!)).toBe(true);
  });
});
