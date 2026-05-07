/**
 * Regression test — every SKILL.md in `config/skills/**` must parse cleanly.
 *
 * Audit Cycle 7 (F-CYCLE7-4) found 7 SKILL.md files missing the YAML frontmatter
 * delimiter, causing 120 `SkillCatalogService` load failures per day. The 7
 * skills were callable via Bash but undiscoverable through the catalog,
 * silently degrading any agent that lists by frontmatter.
 *
 * This regression scans the live `config/skills/**` tree and asserts:
 *   1. Every SKILL.md file is parseable by `parseSkillMd` (delimiters present).
 *   2. The frontmatter satisfies the catalog's minimum required field set
 *      (`name`, `description`, `category`) — see
 *      `skill-catalog.service.ts:loadSkillFromSkillMd` (lines ~610-636) for
 *      the consuming code.
 *
 * Acts as the lightweight CI lint the audit recommended: any future SKILL.md
 * added without frontmatter fails this test, surfacing the drift at PR time
 * rather than at runtime via `[SkillCatalogService] Failed to load skill`
 * log noise.
 *
 * Reference: .crewly/audit-reports/2026-05-07-audit-cycle7.md §2.4.
 *
 * @module utils/skill-md-files.regression.test
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { parseSkillMd } from './skill-md-parser.js';

/**
 * Glob `config/skills/**\/SKILL.md` from the repo root using `find`.
 *
 * Uses `find` instead of an npm glob lib to avoid adding a test-only
 * dependency. Jest runs this file under ts-jest CommonJS, so `__dirname`
 * is available; we walk up from `backend/src/utils` (3 levels) to repo root.
 */
function discoverSkillMdFiles(): string[] {
  // backend/src/utils -> repo root (walk up 3 levels)
  const repoRoot = path.resolve(__dirname, '../../..');
  const skillsRoot = path.join(repoRoot, 'config', 'skills');

  const out = execSync(`find "${skillsRoot}" -name SKILL.md -type f`, {
    encoding: 'utf-8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('SKILL.md frontmatter regression (F-CYCLE7-4)', () => {
  const REQUIRED_FIELDS = ['name', 'description', 'category'] as const;

  // Discover files at suite-load time so the suite-level describe carries
  // the file count in the test name and per-file `it` blocks isolate failures.
  const files = discoverSkillMdFiles();

  it('should discover at least one SKILL.md file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files)('%s', (filePath) => {
    let content: string;
    let parsed: ReturnType<typeof parseSkillMd> | null = null;
    let parseError: Error | null = null;

    beforeAll(() => {
      content = readFileSync(filePath, 'utf-8');
      try {
        parsed = parseSkillMd(content);
      } catch (e) {
        parseError = e instanceof Error ? e : new Error(String(e));
      }
    });

    it('parses without throwing (frontmatter delimiters present)', () => {
      expect(parseError).toBeNull();
      expect(parsed).not.toBeNull();
    });

    it('frontmatter satisfies catalog-required fields (name, description, category)', () => {
      // Skip if upstream parse already failed — that test will report the real signal.
      if (!parsed) return;
      const fm = parsed.frontmatter;
      const missing = REQUIRED_FIELDS.filter(
        (field) => !fm[field] || typeof fm[field] !== 'string'
      );
      expect(missing).toEqual([]);
    });
  });
});
