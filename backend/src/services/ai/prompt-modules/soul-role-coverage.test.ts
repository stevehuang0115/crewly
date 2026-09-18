/**
 * Coverage test — every shipped role has a role-default soul.
 *
 * `SoulModule` (soul.module.ts) injects `config/roles/{role}/soul.md` into
 * the agent prompt when it exists and otherwise falls back to a generic
 * one-liner. A role without a soul therefore silently loses its personality,
 * judgment calls and owner-facing communication stance. This scan asserts
 * that every `config/roles/{role}/prompt.md` (except `_common`) has a
 * sibling `soul.md` carrying the shared section structure, so a new role
 * cannot ship without one.
 *
 * Mirrors the static-coverage pattern of
 * `operating-principles-role-coverage.test.ts` — fast file-content scan,
 * no runtime prompt assembly, no fs mocking.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Resolve to the repo root from this test file's location.
 *
 * Test file lives under `backend/src/services/ai/prompt-modules/`,
 * five `..` segments up from this file = repo root.
 */
const REPO_ROOT = resolve(__dirname, '../../../../..');
const ROLES_DIR = join(REPO_ROOT, 'config', 'roles');

/** Title line every role-default soul must start with. */
const SOUL_TITLE_PREFIX = '# Soul: ';

/**
 * Section headings every role-default soul must carry. Matched as a prefix
 * so a heading may carry a qualifier (e.g. the orchestrator's
 * `## Communication Style — Two Registers …`).
 */
const REQUIRED_SECTION_HEADINGS = [
  '## Core Values',
  '## Communication Style',
  '## Tone Calibration',
  '## Working Style',
];

/**
 * Identity block: the compact template uses `## Name & Inspiration`; a soul
 * with a fuller behavioural stance (orchestrator) opens with `## Identity`.
 * At least one must be present.
 */
const IDENTITY_HEADINGS = ['## Name & Inspiration', '## Identity'];

/**
 * Phrase every soul must carry in its Communication Style section: the owner
 * is a Chinese-speaking small-business operator, prompts and souls are
 * English, and the soul must not let the agent assume otherwise.
 */
const OWNER_LANGUAGE_PHRASE = "the owner's language";

/** Collect all role directories that ship a prompt.md (excludes _common). */
function listRoleDirs(): Array<{ role: string; dir: string }> {
  const entries = readdirSync(ROLES_DIR);
  const out: Array<{ role: string; dir: string }> = [];
  for (const name of entries) {
    if (name.startsWith('_')) continue;
    const rolePath = join(ROLES_DIR, name);
    if (!statSync(rolePath).isDirectory()) continue;
    try {
      statSync(join(rolePath, 'prompt.md'));
      out.push({ role: name, dir: rolePath });
    } catch {
      // No prompt.md in this role dir — not a shipped role, skip silently
    }
  }
  return out;
}

/**
 * Extract the `## `-level headings of a markdown document.
 *
 * @param content - Markdown source
 * @returns Heading lines (trimmed), in document order
 */
function listSectionHeadings(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('## '));
}

describe('Role soul coverage — every role prompt has a sibling soul.md', () => {
  const roleDirs = listRoleDirs();

  it('finds at least 17 role prompts under config/roles/', () => {
    // Sanity check — if this fails, the test setup is wrong, not the souls
    expect(roleDirs.length).toBeGreaterThanOrEqual(17);
  });

  describe.each(roleDirs)('role: $role', ({ dir }) => {
    const soulPath = join(dir, 'soul.md');

    it('ships a non-empty soul.md next to prompt.md', () => {
      expect(() => statSync(soulPath)).not.toThrow();
      expect(readFileSync(soulPath, 'utf-8').trim().length).toBeGreaterThan(0);
    });

    const content = readFileSync(soulPath, 'utf-8');
    const headings = listSectionHeadings(content);

    it('opens with a "# Soul: <Role>" title', () => {
      expect(content.trimStart().startsWith(SOUL_TITLE_PREFIX)).toBe(true);
    });

    it('carries an identity block (Name & Inspiration or Identity)', () => {
      const found = headings.some((h) => IDENTITY_HEADINGS.some((id) => h.startsWith(id)));
      expect(found).toBe(true);
    });

    it.each(REQUIRED_SECTION_HEADINGS)('carries section: %s', (required) => {
      const found = headings.some((h) => h.startsWith(required));
      expect(found).toBe(true);
    });

    it('does not assume the owner speaks English (mentions the owner\'s language)', () => {
      expect(content).toContain(OWNER_LANGUAGE_PHRASE);
    });
  });
});
