import { defineConfig } from 'vitest/config';

/**
 * crewly-agent vitest config. Defaults, plus a setup file that gives every
 * test file its own temp home so no test writes into the real ~/.crewly
 * (session logs, cloud config). See vitest.setup.ts.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
});
