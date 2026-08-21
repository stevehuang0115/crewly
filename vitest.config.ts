/// <reference types="vitest" />
import { defineConfig, defaultExclude } from 'vitest/config';

import { ROOT_VITEST_EXCLUDE_PATTERNS } from './config/vitest-exclude.constants.js';

/**
 * Root-level vitest configuration.
 *
 * The repository root is not itself a vitest project — the real vitest suites
 * live in `frontend/` and `packages/chat-ui/`, each with its own config, and
 * the root test runner is jest (see `jest.config.js`). This file exists for a
 * narrower reason: without it, a bare `npx vitest` at the root falls back to
 * vitest's built-in defaults, which do not exclude `.claude/`. That directory
 * is agent scratch space containing full git worktree copies of this repo, so
 * the fallback collects thousands of stale duplicate test files from other
 * agents' in-flight branches.
 *
 * Scope is deliberately minimal: exclusions only. Nothing here changes which
 * real source roots are collected, and nothing here affects jest or the two
 * package-level vitest configs (vite resolves config from its own root, so a
 * run started inside `frontend/` never sees this file).
 *
 * @see config/vitest-exclude.constants.ts — the exclusion contract and its test.
 */
export default defineConfig({
  test: {
    /**
     * Vitest's `defaultExclude` is spread FIRST and must never be dropped:
     * assigning `test.exclude` replaces the built-in list outright, which
     * would silently re-enable collection of `node_modules` and `dist`.
     */
    exclude: [...defaultExclude, ...ROOT_VITEST_EXCLUDE_PATTERNS],
  },
});
