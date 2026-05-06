import * as fs from 'fs';
import * as path from 'path';

/**
 * Cross-role contract test for P0-4 Decision Rights + Escalation Chain.
 *
 * Eval criterion 1: ALL role prompts under `config/roles/` contain
 * `## Decision Rights` AND `## Escalation Chain` headers.
 * Eval criterion 5: Test asserts each role prompt contains the headers.
 *
 * This test discovers role prompts dynamically (no allowlist) so a new role
 * dropped under `config/roles/{role}/prompt.md` is covered automatically.
 * Adding a role without the authority block fails the test.
 *
 * Net-zero invariant: the spec-prohibited soft hints (`ask if unsure`,
 * `escalate when needed`, `when in doubt`) MUST NOT appear under
 * `config/roles/`. The DecisionRightsModule + per-role authority block are
 * the canonical statement; vague hints around them re-introduce the bug.
 *
 * @see backend/src/services/ai/prompt-modules/decision-rights.module.ts
 * @see .crewly/specs/2026-05-03-agent-improvement-p0-execution.md (Fix P0-4)
 */
describe('Decision Rights — role prompt coverage (P0-4 eval criteria)', () => {
	// Walk up from this test file (backend/src/services/ai/prompt-modules/)
	// to project root, then into config/roles/.
	const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
	const ROLES_DIR = path.join(PROJECT_ROOT, 'config', 'roles');

	/**
	 * Discover all role prompt files under config/roles/{role}/prompt.md.
	 *
	 * @returns Array of {role, absolutePath} for every prompt.md found
	 */
	function discoverRolePrompts(): Array<{ role: string; absolutePath: string }> {
		if (!fs.existsSync(ROLES_DIR)) {
			throw new Error(`config/roles/ not found at ${ROLES_DIR}`);
		}
		const entries = fs.readdirSync(ROLES_DIR, { withFileTypes: true });
		const result: Array<{ role: string; absolutePath: string }> = [];
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const promptPath = path.join(ROLES_DIR, e.name, 'prompt.md');
			if (fs.existsSync(promptPath)) {
				result.push({ role: e.name, absolutePath: promptPath });
			}
		}
		return result.sort((a, b) => a.role.localeCompare(b.role));
	}

	const rolePrompts = discoverRolePrompts();

	it('should discover at least one role prompt', () => {
		// Sanity: if the test infrastructure breaks and finds zero role
		// prompts the per-role assertions below would silently no-op.
		expect(rolePrompts.length).toBeGreaterThan(0);
	});

	describe.each(rolePrompts)('role: $role', ({ absolutePath }) => {
		const content = fs.readFileSync(absolutePath, 'utf-8');

		it('contains "## Decision Rights" H2 header', () => {
			expect(content).toMatch(/^## Decision Rights\b/m);
		});

		it('contains "## Escalation Chain" H2 header', () => {
			expect(content).toMatch(/^## Escalation Chain\b/m);
		});

		it('encodes the four-link chain Worker → Team Lead → Orchestrator → Owner', () => {
			expect(content).toContain('**Worker → Team Lead → Orchestrator → Owner**');
		});

		it('forbids worker-to-owner direct escalation', () => {
			expect(content).toMatch(/Workers do \*\*not\*\* escalate directly to the owner/);
		});

		it('emits exactly five "Decide autonomously when" bullets', () => {
			const m = content.match(/\*\*Decide autonomously when:\*\*\n([\s\S]*?)\n\n\*\*Escalate when:\*\*/);
			expect(m).not.toBeNull();
			const bullets = (m![1].match(/^- /gm) || []).length;
			expect(bullets).toBe(5);
		});

		it('emits exactly five "Escalate when" bullets', () => {
			const m = content.match(/\*\*Escalate when:\*\*\n([\s\S]*?)\n\n## Escalation Chain/);
			expect(m).not.toBeNull();
			const bullets = (m![1].match(/^- /gm) || []).length;
			expect(bullets).toBe(5);
		});
	});

	describe('net-zero spec invariant (criterion 4)', () => {
		/**
		 * Recursively collect every file under config/roles/.
		 *
		 * @param dir - Directory to walk
		 * @returns Flat list of absolute file paths
		 */
		function walk(dir: string): string[] {
			const out: string[] = [];
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) out.push(...walk(full));
				else out.push(full);
			}
			return out;
		}

		const allFiles = walk(ROLES_DIR);
		// Spec verbatim: `grep -rn "ask if unsure|escalate when needed|when in doubt" config/roles/`
		// must return 0 hits.
		const PROHIBITED = /\b(ask if unsure|escalate when needed|when in doubt)\b/i;

		it('produces zero hits for spec-prohibited soft hints (case-insensitive)', () => {
			const offenders: string[] = [];
			for (const file of allFiles) {
				const content = fs.readFileSync(file, 'utf-8');
				const lines = content.split('\n');
				lines.forEach((line, i) => {
					if (PROHIBITED.test(line)) {
						offenders.push(`${file}:${i + 1}: ${line.trim()}`);
					}
				});
			}
			expect(offenders).toEqual([]);
		});
	});
});
