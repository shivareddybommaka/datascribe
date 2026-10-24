import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const ci = read('.github/workflows/ci.yml');
const playwright = read('apps/web/playwright.config.ts');

/** The `e2e:` job block of ci.yml (top-level jobs are indented by two spaces). */
const e2eJob = ci.slice(ci.indexOf('\n  e2e:'));

describe('CI e2e job matches the local Playwright setup (D-113)', () => {
  it('runs the same command against its own *_e2e database on 5433', () => {
    expect(e2eJob).toContain('run: pnpm --filter @datascribe/web e2e');
    expect(e2eJob).toMatch(
      /E2E_DATABASE_URL: postgresql:\/\/datascribe:datascribe@localhost:5433\/datascribe_e2e\n/,
    );
    expect(e2eJob).toMatch(/POSTGRES_DB: datascribe_e2e\n/);
    expect(e2eJob).toContain('- 5433:5432');
  });

  it('has Redis, Mailpit (the SMTP/API ports the suite uses) and S3', () => {
    expect(e2eJob).toMatch(/redis:\n\s+image: redis:/);
    expect(e2eJob).toMatch(/mailpit:\n\s+image: axllent\/mailpit:/);
    expect(e2eJob).toContain('- 1025:1025');
    expect(e2eJob).toContain('- 8025:8025');
    expect(playwright).toContain("mailpit: 'http://localhost:8025'");
    expect(playwright).toContain("SMTP_PORT: '1025'");
    expect(e2eJob).toContain('chrislusf/seaweedfs');
  });

  it('uses the installed Chrome, never a browser download, and never port 3000', () => {
    expect(playwright).toContain("channel: 'chrome'");
    expect(e2eJob).toContain('google-chrome --version');
    expect(e2eJob).not.toMatch(/playwright install/);
    expect(ci).not.toMatch(/\b3000\b/);
    expect(playwright).not.toMatch(/\b3000\b/);
  });
});
