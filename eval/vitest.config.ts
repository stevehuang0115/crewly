import { defineConfig } from 'vitest/config';

/**
 * Local vitest config so vitest stops at eval/ instead of walking up to the
 * repo root's vitest.config.ts (which needs the root node_modules).
 * Only the runner's own tests run; the fixture projects' tests belong to the agents.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
