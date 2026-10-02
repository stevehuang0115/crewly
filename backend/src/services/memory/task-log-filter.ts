/**
 * Identifies task-completion summaries so they stay out of long-term memory.
 *
 * The complete-task and report-status skills used to save every finished
 * task's summary as a project `decision` (and, via report-status, as a
 * learning). In real projects these made up most of decisions.json and
 * pushed real decisions out of recall (#833). The summary already lives on
 * the WorkItem and in task-history.json, so memory writers drop it and the
 * startup migration archives the existing copies.
 *
 * @module services/memory/task-log-filter
 */

import { MEMORY_CONSTANTS } from '../../constants.js';

/**
 * Removes the wrappers other writers add around a stored summary, such as
 * `Decision made: ` (decision → learnings.md mirror) and
 * `[coerced from category=decision]` (agent-scope coercion).
 *
 * @param content - Stored memory text
 * @returns The text with any leading wrappers removed
 */
function stripWrappers(content: string): string {
	let text = content.trimStart();
	let changed = true;
	while (changed) {
		changed = false;
		for (const prefix of MEMORY_CONSTANTS.TASK_LOG.WRAPPER_PREFIXES) {
			const next = text.replace(prefix, '');
			if (next !== text) {
				text = next.trimStart();
				changed = true;
			}
		}
	}
	return text;
}

/**
 * Whether a memory text is a task-completion summary (a task log) rather
 * than a durable conclusion.
 *
 * @param content - Memory text about to be stored, or already stored
 * @returns true when the text is a task-completion summary
 *
 * @example
 * ```typescript
 * isTaskCompletionLog('[COMPLETED] Task completed by dev-1: shipped X'); // true
 * isTaskCompletionLog('Use pnpm, not npm, in this repo');               // false
 * ```
 */
export function isTaskCompletionLog(content: string | undefined | null): boolean {
	if (!content) return false;
	const text = stripWrappers(content);
	return MEMORY_CONSTANTS.TASK_LOG.CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}
