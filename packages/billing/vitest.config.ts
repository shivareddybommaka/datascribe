import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // service.ts needs Postgres; the API integration tests exercise it against the _test DB
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/service.ts'],
      thresholds: { lines: 80 },
    },
  },
});
