import { defineConfig } from '@playwright/test';

/**
 * Staging smoke test (D-124): run by `pnpm staging:smoke` (scripts/staging-smoke.mjs), which builds
 * and starts the production-built staging stack on 3901 / 4901 first and stops it afterwards.
 * Not part of `pnpm e2e`.
 */
export default defineConfig({
  testDir: './smoke',
  testMatch: '**/*.smoke.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:3901',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
});
