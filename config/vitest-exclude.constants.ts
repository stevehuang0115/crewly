/**
 * Test-collection exclusion patterns for root-level vitest runs.
 *
 * The repository root has no vitest project of its own — the real vitest
 * suites live in `frontend/` and `packages/chat-ui/`, each with their own
 * config. A bare `npx vitest` at the root therefore falls back to vitest's
 * built-in defaults, whose exclude list covers only `node_modules`, `dist`,
 * `cypress` and a handful of dotfolders (`.idea`, `.git`, `.cache`,
 * `.output`, `.temp`).
 *
 * `.claude/` is NOT in that list. It is agent scratch space and holds full
 * git worktree copies of this repository, so a root-level run collects
 * thousands of stale duplicate test files — files that belong to other
 * agents' in-flight branches and are frequently written in jest syntax.
 * Collecting them produces a wall of import errors that has nothing to do
 * with the working tree under review.
 *
 * These patterns are kept here, rather than inline in `vitest.config.ts`,
 * so the exclusion is a named, testable contract: `vitest-exclude.constants.test.ts`
 * fails if the pattern is changed or the config stops applying it.
 *
 * @see vitest.config.ts — the sole consumer, which spreads these on top of
 *      vitest's `defaultExclude` (never replacing it).
 */

/**
 * Glob matching everything inside the `.claude/` agent scratch directory, at
 * any depth. Covers `.claude/worktrees/<branch>/**` (full repo copies) and
 * `.claude/agents/**`.
 *
 * Deliberately matches `**\/.claude/**` rather than `.claude/**` so that a
 * nested checkout cannot smuggle the directory back into collection.
 */
export const AGENT_SCRATCH_EXCLUDE_PATTERN = '**/.claude/**';

/**
 * Exclusion globs applied to root-level vitest runs, on top of vitest's own
 * `defaultExclude`.
 *
 * IMPORTANT: consumers must SPREAD vitest's `defaultExclude` alongside these.
 * Assigning `test.exclude` replaces the built-in list outright, which would
 * silently re-enable collection of `node_modules` and `dist`.
 *
 * @example
 * ```typescript
 * import { defineConfig, defaultExclude } from 'vitest/config';
 * import { ROOT_VITEST_EXCLUDE_PATTERNS } from './config/vitest-exclude.constants.js';
 *
 * export default defineConfig({
 *   test: { exclude: [...defaultExclude, ...ROOT_VITEST_EXCLUDE_PATTERNS] },
 * });
 * ```
 */
export const ROOT_VITEST_EXCLUDE_PATTERNS: readonly string[] = [
  AGENT_SCRATCH_EXCLUDE_PATTERN,
];
