import * as fs from 'fs';
import * as path from 'path';

/**
 * Cross-role contract test for P1-Fix-6 Default Execution Loop.
 *
 * Eval criteria from `.crewly/specs/2026-05-03-agent-improvement-plan.md` §Fix 6
 * and Sam's task brief:
 *   1. `grep -L "Default Execution Loop" config/roles/*\/prompt.md` is empty.
 *      → Every discovered role prompt contains the H2 header.
 *   2. `grep -l "Ready for tasks" config/roles/*\/prompt.md` is empty.
 *      → No role prompt anywhere references the deprecated passive closer.
 *   3. The 8 numbered steps are verbatim per spec.
 *
 * This test discovers role prompts dynamically (no allowlist) so a new role
 * dropped under `config/roles/{role}/prompt.md` is covered automatically.
 * Adding a role without the loop fails the test.
 *
 * @see backend/src/services/ai/prompt-modules/default-execution-loop.module.ts
 * @see .crewly/specs/2026-05-03-agent-improvement-plan.md (Fix 6, lines 330-348)
 */
describe('Default Execution Loop — role prompt coverage (P1-Fix-6 eval criteria)', () => {
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

		it('contains "## Default Execution Loop" H2 header (eval criterion 1)', () => {
			expect(content).toMatch(/^## Default Execution Loop\s*$/m);
		});

		it('does NOT contain the deprecated "Ready for tasks" closer (eval criterion 2)', () => {
			expect(content).not.toContain('Ready for tasks');
		});

		it('contains the active anti-passive directive', () => {
			expect(content).toContain('When assigned a task, do not wait passively.');
		});

		it('contains the loop termination conditions', () => {
			expect(content).toContain('Loop until done, blocked, or explicitly reassigned:');
		});

		it('contains all 8 numbered steps verbatim (eval criterion 3)', () => {
			expect(content).toContain('1. Restate the expected outcome in one sentence.');
			expect(content).toContain('2. Identify the fastest safe path to produce a usable result.');
			expect(content).toContain('3. Execute immediately.');
			expect(content).toContain('4. Run cheapest meaningful validation.');
			expect(content).toContain('5. If validation fails, fix and retry.');
			expect(content).toContain('6. If blocked by missing goal/outcome/eval, escalate to your TL.');
			expect(content).toContain('7. If blocked by implementation detail, decide reasonably and continue.');
			expect(content).toContain(
				'8. Report only when you have a result, blocker, or decision exceeding your authority.',
			);
		});
	});

	describe('fleet-level invariants (criteria 1 & 2 over the full prompt set)', () => {
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

		it('produces zero hits for "Ready for tasks" across config/roles/ (criterion 2 strict)', () => {
			const offenders: string[] = [];
			for (const file of allFiles) {
				const content = fs.readFileSync(file, 'utf-8');
				const lines = content.split('\n');
				lines.forEach((line, i) => {
					if (line.includes('Ready for tasks')) {
						offenders.push(`${file}:${i + 1}: ${line.trim()}`);
					}
				});
			}
			expect(offenders).toEqual([]);
		});

		it('every prompt.md contains the loop header (criterion 1 — every prompt, not just 17)', () => {
			const promptFiles = allFiles.filter((f) => f.endsWith('/prompt.md'));
			const missing: string[] = [];
			for (const file of promptFiles) {
				const content = fs.readFileSync(file, 'utf-8');
				if (!/^## Default Execution Loop\s*$/m.test(content)) {
					missing.push(file);
				}
			}
			expect(missing).toEqual([]);
		});
	});
});
