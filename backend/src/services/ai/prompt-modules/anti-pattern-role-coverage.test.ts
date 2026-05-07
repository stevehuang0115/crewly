import * as fs from 'fs';
import * as path from 'path';

/**
 * Cross-role contract test for P1 Fix 8 Lazy Behavior Anti-Patterns.
 *
 * Eval criterion 1: ALL role prompts under `config/roles/` contain
 * `## Lazy Behavior Anti-Patterns` header.
 * Eval criterion 5: Test asserts each role prompt contains the seven
 * anti-pattern bullets verbatim.
 *
 * This test discovers role prompts dynamically (no allowlist) so a new role
 * dropped under `config/roles/{role}/prompt.md` is covered automatically.
 * Adding a role without the anti-patterns block fails the test.
 *
 * Net-zero invariant: the deleted vague platitude lines ("Be professional
 * and customer-focused", "Be patient, empathetic, and solution-oriented",
 * "Focus on user experience and accessibility", "Focus on user value and
 * business impact", "Be thorough and detail-oriented...") MUST stay
 * deleted. Reintroducing them re-introduces the unenforceable-platitude
 * bug that the seven anti-patterns replaced.
 *
 * @see backend/src/services/ai/prompt-modules/lazy-anti-patterns.module.ts
 * @see .crewly/specs/2026-05-03-agent-improvement-plan.md (Fix 8, lines 386-401)
 */
describe('Lazy Behavior Anti-Patterns — role prompt coverage (P1 Fix 8 eval criteria)', () => {
	// Walk up from this test file (backend/src/services/ai/prompt-modules/)
	// to project root, then into config/roles/.
	const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
	const ROLES_DIR = path.join(PROJECT_ROOT, 'config', 'roles');

	/**
	 * The seven verbatim anti-pattern bullets from spec lines 386-401.
	 * Each entry is the full bullet line content (including leading `- `).
	 */
	const SEVEN_ANTI_PATTERNS: ReadonlyArray<string> = [
		'- Ask the human for an implementation detail you could decide yourself.',
		'- Report a plan without executing when execution is possible.',
		'- Schedule follow-up instead of continuing work in-session.',
		'- Mark blocked without trying at least one reasonable path.',
		'- Stop after partial progress without assigning next action.',
		'- Delegate without checking completion.',
		'- Produce status updates but no artifact, code, decision, or verified result.',
	];

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

		it('contains "## Lazy Behavior Anti-Patterns" H2 header', () => {
			expect(content).toMatch(/^## Lazy Behavior Anti-Patterns\b/m);
		});

		it('contains the "You are failing the task if you:" lead-in', () => {
			expect(content).toContain('You are failing the task if you:');
		});

		it('emits exactly seven anti-pattern bullets in the section', () => {
			// Capture bullets between the lead-in and the next H2 (or EOF).
			const m = content.match(
				/You are failing the task if you:\n([\s\S]*?)(?=\n## |\n---\n|$)/,
			);
			expect(m).not.toBeNull();
			const bullets = (m![1].match(/^- /gm) || []).length;
			expect(bullets).toBe(7);
		});

		it.each(SEVEN_ANTI_PATTERNS)('contains anti-pattern verbatim: %s', (bullet) => {
			expect(content).toContain(bullet);
		});
	});

	describe('net-zero spec invariant (criterion 3 — vague platitudes stay deleted)', () => {
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

		// Vague-platitude phrases removed in this PR. Reintroducing them
		// re-introduces unenforceable guidance — the kind of soft language
		// the seven anti-patterns are explicitly built to replace.
		const PROHIBITED_PHRASES: ReadonlyArray<RegExp> = [
			/Be professional and customer-focused/,
			/Be patient, empathetic, and solution-oriented/,
			/Focus on user experience and accessibility/,
			/Consider accessibility and inclusive design/,
			/Focus on user value and business impact/,
			/Be thorough and detail-oriented in test cases and bug reports/,
			/Be thorough and detail-oriented in documentation/,
		];

		it.each(PROHIBITED_PHRASES.map((p) => [p.source]))(
			'no role file reintroduces the vague phrase: %s',
			(pattern) => {
				const re = new RegExp(pattern);
				const offenders: string[] = [];
				for (const file of allFiles) {
					const content = fs.readFileSync(file, 'utf-8');
					const lines = content.split('\n');
					lines.forEach((line, i) => {
						if (re.test(line)) {
							offenders.push(`${file}:${i + 1}: ${line.trim()}`);
						}
					});
				}
				expect(offenders).toEqual([]);
			},
		);
	});
});
