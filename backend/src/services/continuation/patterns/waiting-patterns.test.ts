/**
 * Tests for waiting pattern definitions.
 *
 * Verifies that each pattern category correctly matches expected
 * terminal output strings and does not false-positive on unrelated text.
 *
 * @module services/continuation/patterns/waiting-patterns.test
 */

import {
	INPUT_WAITING_PATTERNS,
	APPROVAL_WAITING_PATTERNS,
	OTHER_AGENT_WAITING_PATTERNS,
	QUESTION_PATTERNS,
	PLAN_MODE_PATTERNS,
	WAITING_PATTERNS,
} from './waiting-patterns.js';

/**
 * Helper: returns true if any pattern in the array matches the text.
 */
function matchesAny(patterns: RegExp[], text: string): boolean {
	return patterns.some((p) => p.test(text));
}

describe('waiting-patterns', () => {
	describe('INPUT_WAITING_PATTERNS', () => {
		it('should match "waiting for" phrases', () => {
			expect(matchesAny(INPUT_WAITING_PATTERNS, 'Waiting for your input')).toBe(true);
		});

		it('should match "please provide" phrases', () => {
			expect(matchesAny(INPUT_WAITING_PATTERNS, 'Please provide the file path')).toBe(true);
		});

		it('should match lines ending with question mark', () => {
			expect(matchesAny(INPUT_WAITING_PATTERNS, 'What should I do next?')).toBe(true);
		});

		it('should match "input required"', () => {
			expect(matchesAny(INPUT_WAITING_PATTERNS, 'Input required to continue')).toBe(true);
		});

		it('should NOT match normal output', () => {
			expect(matchesAny(INPUT_WAITING_PATTERNS, 'Building project...')).toBe(false);
		});
	});

	describe('APPROVAL_WAITING_PATTERNS', () => {
		it('should match "waiting for approval"', () => {
			expect(matchesAny(APPROVAL_WAITING_PATTERNS, 'Waiting for approval from lead')).toBe(true);
		});

		it('should match "please confirm"', () => {
			expect(matchesAny(APPROVAL_WAITING_PATTERNS, 'Please confirm to proceed')).toBe(true);
		});

		it('should match "pending review"', () => {
			expect(matchesAny(APPROVAL_WAITING_PATTERNS, 'PR is pending review')).toBe(true);
		});

		it('should NOT match unrelated text', () => {
			expect(matchesAny(APPROVAL_WAITING_PATTERNS, 'Tests passed successfully')).toBe(false);
		});
	});

	describe('OTHER_AGENT_WAITING_PATTERNS', () => {
		it('should match session name patterns', () => {
			expect(matchesAny(OTHER_AGENT_WAITING_PATTERNS, 'Waiting for team-dev to finish')).toBe(true);
		});

		it('should match "blocked by"', () => {
			expect(matchesAny(OTHER_AGENT_WAITING_PATTERNS, 'Blocked by upstream task')).toBe(true);
		});

		it('should NOT match normal progress', () => {
			expect(matchesAny(OTHER_AGENT_WAITING_PATTERNS, 'Compiling TypeScript')).toBe(false);
		});
	});

	describe('QUESTION_PATTERNS', () => {
		it('should match "should I"', () => {
			expect(matchesAny(QUESTION_PATTERNS, 'Should I refactor this?')).toBe(true);
		});

		it('should match "do you want"', () => {
			expect(matchesAny(QUESTION_PATTERNS, 'Do you want me to continue?')).toBe(true);
		});

		it('should NOT match statements', () => {
			expect(matchesAny(QUESTION_PATTERNS, 'I completed the task.')).toBe(false);
		});
	});

	describe('PLAN_MODE_PATTERNS', () => {
		it('should NOT match the idle footer "shift+tab to cycle" (#815)', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, '  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe(false);
			expect(matchesAny(PLAN_MODE_PATTERNS, '❯❯ bypass permissions on (shift+tab to cycle)')).toBe(false);
		});

		it('should match the plan-approval menu text', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, 'Claude has written up a plan and is ready to execute.')).toBe(true);
			expect(matchesAny(PLAN_MODE_PATTERNS, ' Ready to code?')).toBe(true);
		});

		it('should match "ExitPlanMode"', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, 'Use ExitPlanMode to leave')).toBe(true);
		});

		it('should match "Plan mode"', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, 'Plan mode is active')).toBe(true);
		});

		it('should be case-sensitive for ExitPlanMode and Plan mode', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, 'ExitPlanMode')).toBe(true);
			expect(matchesAny(PLAN_MODE_PATTERNS, 'Plan mode')).toBe(true);
			// These are specific UI strings; arbitrary case variations should not match
			expect(matchesAny(PLAN_MODE_PATTERNS, 'exitplanmode')).toBe(false);
			expect(matchesAny(PLAN_MODE_PATTERNS, 'PLAN MODE')).toBe(false);
		});

		it('should NOT match normal output', () => {
			expect(matchesAny(PLAN_MODE_PATTERNS, 'Running tests...')).toBe(false);
		});
	});

	describe('WAITING_PATTERNS export', () => {
		it('should export all pattern categories', () => {
			expect(WAITING_PATTERNS.input).toBe(INPUT_WAITING_PATTERNS);
			expect(WAITING_PATTERNS.approval).toBe(APPROVAL_WAITING_PATTERNS);
			expect(WAITING_PATTERNS.otherAgent).toBe(OTHER_AGENT_WAITING_PATTERNS);
			expect(WAITING_PATTERNS.question).toBe(QUESTION_PATTERNS);
			expect(WAITING_PATTERNS.planMode).toBe(PLAN_MODE_PATTERNS);
		});

		it('should have 5 categories', () => {
			expect(Object.keys(WAITING_PATTERNS)).toHaveLength(5);
		});
	});
});
