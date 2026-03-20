import { ContextLoaderConfig } from './context-assembly.service.js';

/**
 * Scheduled messages context loader — loads agent's scheduled checks/messages state.
 *
 * This is a context module (dynamic data), registered with ContextAssemblyService
 * rather than PromptAssemblyService. It loads the current scheduled checks and
 * messages for the agent so they have awareness of pending/recurring tasks.
 *
 * Token budget: 0-500
 *
 * Sources: SchedulerService recurring/one-time checks.
 */

/**
 * Scheduled check data shape for the loader (minimal subset of ScheduledCheck).
 */
export interface ScheduledCheckInfo {
	/** Unique check ID */
	id: string;
	/** Target session name */
	targetSession: string;
	/** Message content */
	message: string;
	/** Next scheduled execution time (ISO string) */
	scheduledFor: string;
	/** Interval in minutes for recurring checks */
	intervalMinutes?: number;
	/** Whether this check repeats */
	isRecurring: boolean;
	/** Human-readable label */
	label?: string;
}

/**
 * Provider function type that retrieves scheduled checks for an agent.
 * This allows the loader to be decoupled from the SchedulerService directly.
 */
export type ScheduledChecksProvider = (agentId: string) => ScheduledCheckInfo[];

/**
 * Create a scheduled messages context loader function.
 *
 * The loader is created with a provider function that retrieves the current
 * scheduled checks. This allows dependency injection and easy testing.
 *
 * @param getChecks - Provider function that returns scheduled checks for an agent
 * @returns Context loader function compatible with ContextAssemblyService
 *
 * @example
 * ```typescript
 * const loader = createScheduledMessagesLoader((agentId) => {
 *   return schedulerService.getChecksForAgent(agentId);
 * });
 * contextAssembly.registerLoader('scheduled_messages', loader);
 * ```
 */
export function createScheduledMessagesLoader(
	getChecks: ScheduledChecksProvider
): (config: ContextLoaderConfig) => Promise<string> {
	return async (config: ContextLoaderConfig): Promise<string> => {
		const checks = getChecks(config.agentId);

		if (!checks || checks.length === 0) {
			return '';
		}

		const recurring = checks.filter((c) => c.isRecurring);
		const oneTime = checks.filter((c) => !c.isRecurring);

		const lines: string[] = ['## Scheduled Messages'];

		if (recurring.length > 0) {
			lines.push('');
			lines.push('### Recurring Checks');
			lines.push('| Label | Interval | Next Run | Message |');
			lines.push('|-------|----------|----------|---------|');
			for (const check of recurring) {
				const label = check.label || check.id;
				const interval = check.intervalMinutes ? `${check.intervalMinutes}m` : 'N/A';
				const nextRun = formatTime(check.scheduledFor);
				const message = truncateMessage(check.message);
				lines.push(`| ${label} | ${interval} | ${nextRun} | ${message} |`);
			}
		}

		if (oneTime.length > 0) {
			lines.push('');
			lines.push('### One-Time Checks');
			lines.push('| Label | Scheduled For | Message |');
			lines.push('|-------|---------------|---------|');
			for (const check of oneTime) {
				const label = check.label || check.id;
				const scheduledFor = formatTime(check.scheduledFor);
				const message = truncateMessage(check.message);
				lines.push(`| ${label} | ${scheduledFor} | ${message} |`);
			}
		}

		lines.push('');
		lines.push(`_Total: ${checks.length} scheduled (${recurring.length} recurring, ${oneTime.length} one-time)_`);

		return lines.join('\n');
	};
}

/**
 * Format an ISO timestamp to a short human-readable time.
 *
 * @param isoString - ISO 8601 timestamp
 * @returns Formatted time string (e.g., "14:30" or "Mar 19 14:30")
 */
function formatTime(isoString: string): string {
	try {
		const date = new Date(isoString);
		const now = new Date();
		const isToday =
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();

		if (isToday) {
			return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
		}
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
			' ' +
			date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
	} catch {
		return isoString;
	}
}

/**
 * Truncate a message for table display.
 *
 * @param message - Full message string
 * @param maxLength - Maximum length before truncation
 * @returns Truncated message
 */
function truncateMessage(message: string, maxLength: number = 60): string {
	if (!message) return '';
	const singleLine = message.replace(/\n/g, ' ').trim();
	if (singleLine.length <= maxLength) return singleLine;
	return singleLine.substring(0, maxLength - 3) + '...';
}
