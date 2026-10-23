import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests only; Playwright owns e2e/.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  test: {
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
