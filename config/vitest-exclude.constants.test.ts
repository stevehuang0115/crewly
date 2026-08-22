import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  AGENT_SCRATCH_EXCLUDE_PATTERN,
  ROOT_VITEST_EXCLUDE_PATTERNS,
} from './vitest-exclude.constants.js';

/**
 * Regression guard for the root-level vitest exclusion contract.
 *
 * Background: `.claude/` is agent scratch space holding full git worktree
 * copies of this repository. Vitest's built-in `defaultExclude` does not
 * cover it, so a root-level run without this exclusion collects thousands of
 * stale duplicate test files from other agents' branches.
 *
 * These tests fail if the pattern is changed, or if `vitest.config.ts` stops
 * applying it — which is the failure mode that actually matters, since a
 * correct constant that nothing consumes fixes nothing.
 */
describe('root vitest exclusion contract', () => {
  /** Source text of the root vitest config, read once for the wiring assertions. */
  const configPath = resolve(__dirname, '..', 'vitest.config.ts');
  const configSource = readFileSync(configPath, 'utf8');

  describe('exclusion patterns', () => {
    it('excludes the .claude agent scratch directory at any depth', () => {
      expect(AGENT_SCRATCH_EXCLUDE_PATTERN).toBe('**/.claude/**');
    });

    it('includes the agent-scratch pattern in the root exclude list', () => {
      expect(ROOT_VITEST_EXCLUDE_PATTERNS).toContain(
        AGENT_SCRATCH_EXCLUDE_PATTERN
      );
    });

    it('leads each pattern with a globstar so nested checkouts cannot re-enter collection', () => {
      for (const pattern of ROOT_VITEST_EXCLUDE_PATTERNS) {
        expect(pattern.startsWith('**/')).toBe(true);
      }
    });
  });

  describe('vitest.config.ts wiring', () => {
    it('imports the shared exclusion constants rather than inlining the glob', () => {
      expect(configSource).toContain('ROOT_VITEST_EXCLUDE_PATTERNS');
      expect(configSource).toMatch(
        /from\s+['"]\.\/config\/vitest-exclude\.constants\.js['"]/
      );
    });

    it('spreads the exclusion patterns into test.exclude', () => {
      expect(configSource).toMatch(/exclude:\s*\[[^\]]*\.\.\.ROOT_VITEST_EXCLUDE_PATTERNS/s);
    });

    it("spreads vitest's defaultExclude so node_modules and dist stay excluded", () => {
      // Assigning test.exclude REPLACES vitest's built-in list. Dropping this
      // spread would silently re-enable collection of node_modules and dist —
      // a far worse regression than the one this config exists to fix.
      expect(configSource).toMatch(/exclude:\s*\[\s*\.\.\.defaultExclude/s);
      expect(configSource).toMatch(
        /import\s*\{[^}]*\bdefaultExclude\b[^}]*\}\s*from\s+['"]vitest\/config['"]/s
      );
    });
  });
});
