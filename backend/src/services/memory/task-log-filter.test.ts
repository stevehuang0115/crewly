import { isTaskCompletionLog } from './task-log-filter.js';

describe('isTaskCompletionLog (#833)', () => {
	it.each([
		['complete-task / report-status decision', '[COMPLETED] Task completed by dev-1: Fixed login bug'],
		['older complete-task pattern', 'Task completed by dev-1: Fixed login bug'],
		['report-status learning', 'Task completed: Fixed the modular prompt'],
		['decision mirrored into learnings.md', 'Decision made: [COMPLETED] Task completed by ella - [COMPLETED] Task completed by ella: briefing (Rationale: )'],
		['agent-scope coercion', '[coerced from category=decision]\n[COMPLETED] Task completed by sam: triage'],
		['leading whitespace', '   [COMPLETED] Task completed by dev-1: x'],
	])('flags %s', (_label, text) => {
		expect(isTaskCompletionLog(text)).toBe(true);
	});

	it.each([
		['a real decision', 'Use pnpm, not npm, in this repo'],
		['a failure learning', 'Task failed: Build broke on a missing type'],
		['a blocked learning', 'Task blocked: Waiting on the staging API key'],
		['a decision that mentions completion mid-text', 'We ship only after Task completed by QA: see #12'],
		['a real decision behind a wrapper', 'Decision made: Adopt WorkItems - replaces tasks/ (Rationale: one pool)'],
		['empty', ''],
	])('keeps %s', (_label, text) => {
		expect(isTaskCompletionLog(text)).toBe(false);
	});

	it('treats null and undefined as not a task log', () => {
		expect(isTaskCompletionLog(undefined)).toBe(false);
		expect(isTaskCompletionLog(null)).toBe(false);
	});
});
