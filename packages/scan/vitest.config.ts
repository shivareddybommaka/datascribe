import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // verify.ts needs Postgres + S3; the API upload tests and the worker scan stage exercise it
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/verify.ts'],
      thresholds: { lines: 80 },
    },
  },
});
