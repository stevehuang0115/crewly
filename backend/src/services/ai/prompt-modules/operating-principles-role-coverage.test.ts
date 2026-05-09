/**
 * Coverage test for Fix 13 (P2) — Crewly Operating Principles header
 * across all role prompts under `config/roles/{role}/prompt.md`.
 *
 * Spec: `.crewly/specs/2026-05-03-agent-improvement-plan.md` lines 466-481
 * (Fix 13 — Crewly Operating Principles header).
 *
 * Mirrors the static-coverage pattern established by PR #481
 * (`decision-rights-role-coverage.test.ts`) — fast file-content scan,
 * no runtime prompt assembly required.
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

/** The 6 principle bullets that must appear verbatim in every role prompt. */
const REQUIRED_PRINCIPLES = [
  '1. Outcome over activity.',
  '2. Decide unless the goal is unclear.',
  '3. Delegate by default if you are a TL.',
  '4. Execute immediately if you are a worker.',
  '5. Verify before claiming done.',
  '6. Escalate through the hierarchy.',
];

/** Collect all role directories that ship a prompt.md (excludes _common). */
function listRolePromptPaths(): Array<{ role: string; path: string }> {
  const entries = readdirSync(ROLES_DIR);
  const out: Array<{ role: string; path: string }> = [];
  for (const name of entries) {
    if (name.startsWith('_')) continue;
    const rolePath = join(ROLES_DIR, name);
    if (!statSync(rolePath).isDirectory()) continue;
    const promptPath = join(rolePath, 'prompt.md');
    try {
      statSync(promptPath);
      out.push({ role: name, path: promptPath });
    } catch {
      // No prompt.md in this role dir — skip silently
    }
  }
  return out;
}

describe('Fix 13 — Crewly Operating Principles role coverage', () => {
  const rolePrompts = listRolePromptPaths();

  it('finds at least 17 role prompts under config/roles/', () => {
    // Sanity check — if this fails, the test setup is wrong, not Fix 13
    expect(rolePrompts.length).toBeGreaterThanOrEqual(17);
  });

  describe.each(rolePrompts)('role: $role', ({ path }) => {
    const content = readFileSync(path, 'utf-8');

    it('contains the "## Crewly Operating Principles" section header', () => {
      expect(content).toContain('## Crewly Operating Principles');
    });

    it.each(REQUIRED_PRINCIPLES)('contains principle: %s', (principle) => {
      expect(content).toContain(principle);
    });

    it('places principles header BEFORE the role identity (top of file)', () => {
      const principlesIdx = content.indexOf('## Crewly Operating Principles');
      // Identity sections come in many forms across roles. The marker list
      // covers all 20 prompts in the current corpus:
      //   - "Hey! I need your help with"  → 16 prompts (developer, backend,
      //       frontend, fullstack, generalist, qa, qa-engineer, ops, sales,
      //       support, product-manager, researcher, designer, ux-designer,
      //       architect, tpm)
      //   - "## Your Role"                → team-leader (`## Your Role: Team Leader`)
      //   - "## Role focus"               → content-strategist (`## Role focus: Content Strategist`)
      //   - "# Crewly Orchestrator"       → orchestrator (top-level title)
      //   - "# Crewly Auditor"            → auditor (top-level title)
      // `## Identity` / `## Primary Identity` kept as defensive fallbacks for
      // any future role that adopts the standardized identity heading.
      const identityMarkers = [
        'Hey! I need your help with',
        '## Your Role',
        '## Role focus',
        '## Identity',
        '## Primary Identity',
        '# Crewly Orchestrator',
        '# Crewly Auditor',
      ];
      const identityIdx = identityMarkers
        .map((m) => content.indexOf(m))
        .filter((i) => i !== -1)
        .reduce((min, i) => (min === -1 || i < min ? i : min), -1);
      // After expanding the marker list to cover every role's identity
      // heading variant, every prompt matches at least one marker.
      // The assertion is now strict for all 20 roles (no silent skip).
      expect(identityIdx).toBeGreaterThan(-1);
      expect(principlesIdx).toBeLessThan(identityIdx);
    });
  });
});
