/**
 * Tests for the Karpathy-lite learning format validator.
 *
 * Covers all four rules + strict-mode escalation per ARCHIVIST-V2.f1
 * (`.crewly/tasks/autonomy_v1/follow-up/archivist-v2-record-learning-preflight.md`).
 *
 * @module services/memory/learning-format.validator.test
 */

import {
	validateLearningFormat,
	formatValidationMessage,
	LearningValidationIssue,
} from './learning-format.validator.js';

/** Pull the issue with a given rule id from a result list (errors+warnings). */
function findIssue(
	issues: LearningValidationIssue[],
	rule: 1 | 2 | 3 | 4
): LearningValidationIssue | undefined {
	return issues.find((i) => i.rule === rule);
}

describe('validateLearningFormat', () => {
	describe('rule 1 — entity opener (always hard)', () => {
		it('rejects text without a [[Entity]] opener', () => {
			const result = validateLearningFormat('Fast PR pattern: rebase early.');
			expect(result.pass).toBe(false);
			expect(findIssue(result.errors, 1)).toBeDefined();
			expect(findIssue(result.errors, 1)?.ruleName).toBe('entity_opener');
		});

		it('rejects empty text', () => {
			const result = validateLearningFormat('');
			expect(result.pass).toBe(false);
			expect(findIssue(result.errors, 1)).toBeDefined();
		});

		it('rejects whitespace-only text', () => {
			const result = validateLearningFormat('   \n\t  ');
			expect(result.pass).toBe(false);
			expect(findIssue(result.errors, 1)).toBeDefined();
		});

		it('rejects single-bracket prefix (e.g. "[category] foo")', () => {
			// Single-bracket prefix is the auto-learning category format and is
			// NOT the [[Entity]] convention. Validator must reject.
			const result = validateLearningFormat('[pattern] Worker dev-001 finished task X.');
			expect(result.pass).toBe(false);
			expect(findIssue(result.errors, 1)).toBeDefined();
		});

		it('accepts well-formed [[Entity]] opener', () => {
			const result = validateLearningFormat(
				'[[Fts5IndexService]] FTS5 rank is negative; invert. Ref: PR #320'
			);
			expect(result.pass).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('rule 1 stays hard even when strict is false (spec contract)', () => {
			const result = validateLearningFormat('No entity here.', { strict: false });
			expect(findIssue(result.errors, 1)).toBeDefined();
		});

		it('rule 1 includes a [[Entity]] suggestion that begins with [[', () => {
			const result = validateLearningFormat('FastPathHandler always wins.');
			const issue = findIssue(result.errors, 1);
			expect(issue?.suggestion).toBeDefined();
			expect(issue?.suggestion?.startsWith('[[')).toBe(true);
		});

		it('rule 1 suggestion picks a capitalized anchor when available', () => {
			const result = validateLearningFormat('FastPathHandler always wins.');
			const issue = findIssue(result.errors, 1);
			expect(issue?.suggestion).toContain('[[FastPathHandler]]');
		});
	});

	describe('rule 2 — sentence count (1..3)', () => {
		it('warns (soft) on >3 sentences in default mode', () => {
			const text = '[[X]] One. Two. Three. Four. Ref: PR #1';
			const result = validateLearningFormat(text);
			expect(result.pass).toBe(true);
			expect(findIssue(result.warnings, 2)).toBeDefined();
		});

		it('escalates to error in strict mode', () => {
			const text = '[[X]] One. Two. Three. Four. Ref: PR #1';
			const result = validateLearningFormat(text, { strict: true });
			expect(result.pass).toBe(false);
			expect(findIssue(result.errors, 2)).toBeDefined();
		});

		it('accepts exactly 3 sentences (PR ref embedded inline)', () => {
			const text = '[[X]] First insight (PR #1). Second context. Third caveat.';
			const result = validateLearningFormat(text, { strict: true });
			expect(result.pass).toBe(true);
		});

		it('accepts 1 sentence with terminal period', () => {
			const text = '[[X]] One sentence. PR #1';
			const result = validateLearningFormat(text, { strict: true });
			// Rule 2 warning should NOT fire; rule 3 satisfied via "PR #1".
			expect(findIssue(result.warnings, 2)).toBeUndefined();
			expect(findIssue(result.errors, 2)).toBeUndefined();
		});
	});

	describe('rule 3 — linked or sourced', () => {
		it('warns when no link/source present', () => {
			const text = '[[X]] Just a single sentence.';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 3)).toBeDefined();
			expect(result.pass).toBe(true);
		});

		it('escalates to error in strict mode', () => {
			const text = '[[X]] Just a single sentence.';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeDefined();
			expect(result.pass).toBe(false);
		});

		it('accepts a second [[Entity]] link', () => {
			const text = '[[X]] joins to [[Y]] at the boundary.';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('accepts PR # citation', () => {
			const text = '[[X]] Insight body. Ref: PR #320';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('accepts Task # citation', () => {
			const text = '[[X]] Insight body. Task #abc-123';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('accepts Issue # citation', () => {
			const text = '[[X]] Insight body. Issue #42';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('accepts See: citation', () => {
			const text = '[[X]] Insight body. See: backend/src/foo.ts';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('accepts bare #NNN citation', () => {
			const text = '[[X]] Insight body, fixed in #123.';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 3)).toBeUndefined();
		});

		it('does not double-count the leading [[Entity]] as link', () => {
			// Leading entity stripped before scanning — so a learning with ONLY the
			// opener and no other link/source should still warn.
			const text = '[[OnlyEntity]] body but no second link.';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 3)).toBeDefined();
		});
	});

	describe('rule 4 — no log-style', () => {
		it('warns on "I fixed..." opener', () => {
			const text = '[[Bug]] I fixed the FTS5 ranking. PR #320';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 4)).toBeDefined();
			expect(result.pass).toBe(true);
		});

		it('warns on "We added..." opener', () => {
			const text = '[[Feature]] We added a new module. PR #1';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 4)).toBeDefined();
		});

		it('warns on "I\'ve" contraction', () => {
			const text = "[[Bug]] I've discovered a leak. PR #1";
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 4)).toBeDefined();
		});

		it('escalates to error in strict mode', () => {
			const text = '[[Bug]] I fixed it. PR #1';
			const result = validateLearningFormat(text, { strict: true });
			expect(findIssue(result.errors, 4)).toBeDefined();
		});

		it('does not flag entity-first learnings', () => {
			const text = '[[Fts5IndexService]] Inverts negative rank. PR #320';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 4)).toBeUndefined();
		});

		it('does not false-positive on "Issue" or "Insight"', () => {
			const text = '[[Bug]] Issue manifests under load. PR #1';
			const result = validateLearningFormat(text);
			expect(findIssue(result.warnings, 4)).toBeUndefined();
		});
	});

	describe('strict-mode contract', () => {
		it('passes a fully conformant learning in strict mode', () => {
			const text =
				'[[Fts5IndexService]] FTS5 rank is negative; invert for score consistency. Ref: PR #320';
			const result = validateLearningFormat(text, { strict: true });
			expect(result.pass).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});

		it('reports multiple errors when multiple rules fail in strict', () => {
			const text = 'I fixed the bug in 4 sentences. Two. Three. Four. Five.';
			const result = validateLearningFormat(text, { strict: true });
			// Rule 1 (no opener) + Rule 2 (>3 sentences) + Rule 3 (no link) +
			// Rule 4 (log-style "I ...") should all fire.
			expect(findIssue(result.errors, 1)).toBeDefined();
			expect(findIssue(result.errors, 2)).toBeDefined();
			expect(findIssue(result.errors, 3)).toBeDefined();
			expect(findIssue(result.errors, 4)).toBeDefined();
			expect(result.pass).toBe(false);
		});

		it('default mode separates rule 1 (error) from rule 2..4 (warnings)', () => {
			const text = 'I fixed the bug in 4 sentences. Two. Three. Four. Five.';
			const result = validateLearningFormat(text);
			expect(findIssue(result.errors, 1)).toBeDefined();
			expect(findIssue(result.warnings, 2)).toBeDefined();
			expect(findIssue(result.warnings, 3)).toBeDefined();
			expect(findIssue(result.warnings, 4)).toBeDefined();
			expect(result.errors).toHaveLength(1);
		});
	});

	describe('issue metadata', () => {
		it('every issue carries skillRef pointing to SKILL.md', () => {
			const text = 'I fixed it.';
			const result = validateLearningFormat(text, { strict: true });
			for (const issue of [...result.errors, ...result.warnings]) {
				expect(issue.skillRef).toContain('SKILL.md');
			}
		});

		it('every issue has a stable ruleName', () => {
			const text = 'I fixed it.';
			const result = validateLearningFormat(text, { strict: true });
			const names = [...result.errors, ...result.warnings].map((i) => i.ruleName);
			expect(names).toEqual(
				expect.arrayContaining([
					'entity_opener',
					'linked_or_sourced',
					'no_log_style',
				])
			);
		});
	});
});

describe('formatValidationMessage', () => {
	it('produces a multi-line message with rule, snippet, fix, and SKILL ref', () => {
		const text = 'I fixed the bug today and learned something.';
		const result = validateLearningFormat(text);
		const issue = result.errors[0]!;
		const formatted = formatValidationMessage(issue, text);
		expect(formatted).toContain('rule 1');
		expect(formatted).toContain('entity_opener');
		expect(formatted).toContain('Got:');
		expect(formatted).toContain('Fix:');
		expect(formatted).toContain('SKILL.md');
	});

	it('truncates very long snippets with an ellipsis', () => {
		const text = '[[X]] ' + 'a'.repeat(200) + '. PR #1';
		const result = validateLearningFormat(text, { strict: true });
		// Construct a synthetic issue to format the long text.
		const issue: LearningValidationIssue = {
			rule: 2,
			ruleName: 'sentence_count',
			message: 'synthetic',
			skillRef: 'config/skills/agent/core/record-learning/SKILL.md',
		};
		const formatted = formatValidationMessage(issue, text);
		expect(formatted).toContain('…');
		expect(result.pass).toBe(true); // ensure base text is otherwise OK
	});
});
