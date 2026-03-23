/**
 * Cron Task Service
 *
 * Manages user-defined recurring tasks that run on cron schedules.
 * Unlike scheduled messages (agent-created/cancellable), cron tasks
 * can only be cancelled by user or orchestrator.
 *
 * Storage: ~/.crewly/cron-tasks.json
 *
 * @module services/workflow/cron-task.service
 */

import * as os from 'os';
import * as path from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import type {
	CronTask,
	CronTaskStore,
	CreateCronTaskRequest,
	UpdateCronTaskRequest,
} from '../../types/cron-task.types.js';

/**
 * Check interval for cron task evaluation (60 seconds).
 */
const CRON_CHECK_INTERVAL_MS = 60_000;

/**
 * Get the components (hour, minute, day, etc.) of a UTC Date in a given IANA timezone.
 * Uses Intl.DateTimeFormat for zero-dependency timezone support.
 *
 * @param date - A Date object (interpreted as UTC instant)
 * @param timezone - IANA timezone string (e.g. 'Asia/Shanghai')
 * @returns Object with zoned hour, minute, dayOfWeek, dayOfMonth, month
 */
function getZonedComponents(date: Date, timezone: string): {
	hour: number; minute: number; dayOfWeek: number; dayOfMonth: number; month: number;
} {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric', minute: 'numeric',
		day: 'numeric', month: 'numeric', weekday: 'short',
		hour12: false,
	});
	const partsMap: Record<string, string> = {};
	for (const part of fmt.formatToParts(date)) {
		partsMap[part.type] = part.value;
	}
	const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
	return {
		hour: parseInt(partsMap['hour'], 10) % 24, // Intl returns 24 for midnight in some locales
		minute: parseInt(partsMap['minute'], 10),
		dayOfWeek: weekdayMap[partsMap['weekday']] ?? 0,
		dayOfMonth: parseInt(partsMap['day'], 10),
		month: parseInt(partsMap['month'], 10),
	};
}

/**
 * Parse a cron day-of-week field that may contain ranges (e.g. "1-5").
 *
 * @param spec - Cron day-of-week field
 * @returns Set of matching day numbers, or null for wildcard
 */
function parseDowSpec(spec: string): Set<number> | null {
	if (spec === '*') return null;
	const values = new Set<number>();
	for (const part of spec.split(',')) {
		if (part.includes('-')) {
			const [start, end] = part.split('-').map(Number);
			for (let d = start; d <= end; d++) values.add(d);
		} else {
			values.add(parseInt(part, 10));
		}
	}
	return values;
}

/**
 * Parse a cron expression and calculate the next run time.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 *
 * All time matching is performed in the given timezone (#268), ensuring cron
 * expressions like "45 8 * * 1-5" with timezone "Asia/Shanghai" fire at
 * 08:45 CST, not 08:45 UTC.
 *
 * @param cronExpression - Standard 5-field cron expression
 * @param timezone - IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York')
 * @param after - Calculate next run after this date (defaults to now)
 * @returns ISO string of next run time (UTC)
 */
export function getNextRunTime(cronExpression: string, timezone: string, after?: Date): string {
	const now = after || new Date();
	const parts = cronExpression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
	}

	const [minuteSpec, hourSpec] = parts;

	const minute = minuteSpec === '*' ? -1 : parseInt(minuteSpec, 10);
	const hour = hourSpec === '*' ? -1 : parseInt(hourSpec, 10);
	const dowSet = parseDowSpec(parts[4]);

	const candidate = new Date(now.getTime());
	// Advance by 1 minute minimum to avoid re-triggering
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	// Try up to 48 hours of minutes
	for (let i = 0; i < 48 * 60; i++) {
		// #268: Use timezone-aware components instead of UTC getHours()/getMinutes()
		const zoned = getZonedComponents(candidate, timezone);

		const minuteMatch = minute === -1 || zoned.minute === minute;
		const hourMatch = hour === -1 || zoned.hour === hour;
		const domMatch = parts[2] === '*' || parseInt(parts[2], 10) === zoned.dayOfMonth;
		const monthMatch = parts[3] === '*' || parseInt(parts[3], 10) === zoned.month;
		const dowMatch = dowSet === null || dowSet.has(zoned.dayOfWeek);

		if (minuteMatch && hourMatch && domMatch && monthMatch && dowMatch) {
			return candidate.toISOString();
		}

		candidate.setMinutes(candidate.getMinutes() + 1);
	}

	// Fallback: 24 hours from now
	return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Service for managing cron tasks.
 */
export class CronTaskService {
	private static instance: CronTaskService | null = null;
	private logger: ComponentLogger;
	private storeFile: string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private executionCallback: ((task: CronTask) => Promise<void>) | null = null;
	private agentStatusCallback: ((sessionName: string) => Promise<boolean>) | null = null;
	private agentStartCallback: ((sessionName: string, teamId: string) => Promise<boolean>) | null = null;

	constructor(crewlyHome?: string) {
		this.logger = LoggerService.getInstance().createComponentLogger('CronTaskService');
		const home = crewlyHome || path.join(os.homedir(), '.crewly');
		this.storeFile = path.join(home, 'cron-tasks.json');
	}

	/**
	 * Get singleton instance.
	 */
	static getInstance(): CronTaskService {
		if (!CronTaskService.instance) {
			CronTaskService.instance = new CronTaskService();
		}
		return CronTaskService.instance;
	}

	/**
	 * Reset singleton (for testing).
	 */
	static resetInstance(): void {
		if (CronTaskService.instance) {
			CronTaskService.instance.stop();
		}
		CronTaskService.instance = null;
	}

	/**
	 * Set the callback invoked when a cron task is due for execution.
	 * The callback receives the task and should delegate it to the target agent.
	 *
	 * @param callback - Async function that executes a cron task
	 */
	setExecutionCallback(callback: (task: CronTask) => Promise<void>): void {
		this.executionCallback = callback;
	}

	/**
	 * Set the callback to check whether a target agent is online.
	 *
	 * @param callback - Returns true if the agent is online/active
	 */
	setAgentStatusCallback(callback: (sessionName: string) => Promise<boolean>): void {
		this.agentStatusCallback = callback;
	}

	/**
	 * Set the callback to auto-start an offline agent before dispatching a cron task.
	 *
	 * @param callback - Attempts to start the agent, returns true on success
	 */
	setAgentStartCallback(callback: (sessionName: string, teamId: string) => Promise<boolean>): void {
		this.agentStartCallback = callback;
	}

	/**
	 * Recalculate nextRunAt for all enabled tasks using their stored timezone.
	 *
	 * On backend startup, existing tasks may have stale nextRunAt values computed
	 * with a different server timezone (e.g. 12h off for Asia/Shanghai vs EDT).
	 * This self-heal step ensures every task's nextRunAt is correct for its timezone.
	 *
	 * @returns Number of tasks whose nextRunAt was updated
	 */
	async recalculateAllNextRunTimes(): Promise<number> {
		const store = await this.loadStore();
		let updated = 0;
		const now = new Date();

		for (const task of store.tasks) {
			if (!task.enabled) continue;

			const correctedNextRun = getNextRunTime(task.cronExpression, task.timezone, now);
			if (task.nextRunAt !== correctedNextRun) {
				this.logger.info('Recalculated nextRunAt for cron task', {
					id: task.id,
					oldNextRunAt: task.nextRunAt,
					newNextRunAt: correctedNextRun,
					timezone: task.timezone,
				});
				task.nextRunAt = correctedNextRun;
				updated++;
			}
		}

		if (updated > 0) {
			await this.saveStore(store);
			this.logger.info('Recalculated nextRunAt for cron tasks on startup', { count: updated });
		}

		return updated;
	}

	/**
	 * Start the cron task evaluation loop.
	 * Checks every minute for tasks whose nextRunAt has passed.
	 *
	 * On startup, recalculates nextRunAt for all tasks to self-heal stale
	 * timezone-dependent values (#286).
	 */
	start(): void {
		if (this.timer) return;

		this.logger.info('Starting cron task service', { intervalMs: CRON_CHECK_INTERVAL_MS });

		// #286: Self-heal stale nextRunAt values on startup
		this.recalculateAllNextRunTimes().catch((error) => {
			this.logger.warn('Failed to recalculate cron task nextRunAt on startup', {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		this.timer = setInterval(async () => {
			try {
				await this.evaluateTasks();
			} catch (error) {
				this.logger.error('Cron task evaluation error', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}, CRON_CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the cron task evaluation loop.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			this.logger.info('Stopped cron task service');
		}
	}

	/**
	 * Whether the service is running.
	 */
	isRunning(): boolean {
		return this.timer !== null;
	}

	/**
	 * Create a new cron task.
	 *
	 * @param request - Cron task creation parameters
	 * @returns The created cron task
	 */
	async create(request: CreateCronTaskRequest): Promise<CronTask> {
		const timezone = request.timezone || 'UTC';
		const nextRunAt = getNextRunTime(request.cronExpression, timezone);

		const task: CronTask = {
			id: `cron-${uuidv4().slice(0, 8)}`,
			cronExpression: request.cronExpression,
			timezone,
			targetAgent: request.targetAgent,
			targetTeamId: request.targetTeamId,
			taskDescription: request.taskDescription,
			createdBy: request.createdBy || 'user',
			createdAt: new Date().toISOString(),
			enabled: true,
			lastRunAt: null,
			nextRunAt,
		};

		const store = await this.loadStore();
		store.tasks.push(task);
		await this.saveStore(store);

		this.logger.info('Cron task created', { id: task.id, cron: task.cronExpression, target: task.targetAgent });
		return task;
	}

	/**
	 * List all cron tasks, optionally filtered.
	 *
	 * @param filter - Optional filter criteria
	 * @returns Array of matching cron tasks
	 */
	async list(filter?: { targetAgent?: string; enabled?: boolean }): Promise<CronTask[]> {
		const store = await this.loadStore();
		let tasks = store.tasks;

		if (filter?.targetAgent) {
			tasks = tasks.filter(t => t.targetAgent === filter.targetAgent);
		}
		if (filter?.enabled !== undefined) {
			tasks = tasks.filter(t => t.enabled === filter.enabled);
		}

		return tasks;
	}

	/**
	 * Get a single cron task by ID.
	 *
	 * @param id - Cron task ID
	 * @returns The cron task or null
	 */
	async get(id: string): Promise<CronTask | null> {
		const store = await this.loadStore();
		return store.tasks.find(t => t.id === id) || null;
	}

	/**
	 * Update a cron task. Agents can update description/expression/enabled
	 * but cannot delete.
	 *
	 * @param id - Cron task ID
	 * @param updates - Fields to update
	 * @returns Updated task or null if not found
	 */
	async update(id: string, updates: UpdateCronTaskRequest): Promise<CronTask | null> {
		const store = await this.loadStore();
		const task = store.tasks.find(t => t.id === id);
		if (!task) return null;

		if (updates.cronExpression !== undefined) {
			task.cronExpression = updates.cronExpression;
			task.nextRunAt = getNextRunTime(updates.cronExpression, task.timezone);
		}
		if (updates.timezone !== undefined) {
			task.timezone = updates.timezone;
			task.nextRunAt = getNextRunTime(task.cronExpression, task.timezone);
		}
		if (updates.taskDescription !== undefined) {
			task.taskDescription = updates.taskDescription;
		}
		if (updates.enabled !== undefined) {
			task.enabled = updates.enabled;
		}

		await this.saveStore(store);
		this.logger.info('Cron task updated', { id, updates: Object.keys(updates) });
		return task;
	}

	/**
	 * Delete a cron task. Only user/orchestrator should call this.
	 *
	 * @param id - Cron task ID
	 * @returns true if deleted, false if not found
	 */
	async delete(id: string): Promise<boolean> {
		const store = await this.loadStore();
		const index = store.tasks.findIndex(t => t.id === id);
		if (index === -1) return false;

		store.tasks.splice(index, 1);
		await this.saveStore(store);
		this.logger.info('Cron task deleted', { id });
		return true;
	}

	/**
	 * Evaluate all enabled tasks and execute those whose nextRunAt has passed.
	 *
	 * #268: Before dispatching, checks whether the target agent is online.
	 * If offline and an agentStartCallback is configured, attempts to auto-start
	 * the agent. If still offline, skips the task and logs a warning instead of
	 * silently dropping it.
	 */
	async evaluateTasks(): Promise<void> {
		const store = await this.loadStore();
		const now = new Date();
		let updated = false;

		for (const task of store.tasks) {
			if (!task.enabled || !task.nextRunAt) continue;

			const nextRun = new Date(task.nextRunAt);
			if (nextRun > now) continue;

			// Task is due — check agent status before dispatching (#268)
			this.logger.info('Cron task due', {
				id: task.id,
				target: task.targetAgent,
				nextRunAt: task.nextRunAt,
			});

			// #268: Check if target agent is online
			let agentOnline = true;
			if (this.agentStatusCallback) {
				try {
					agentOnline = await this.agentStatusCallback(task.targetAgent);
				} catch (error) {
					this.logger.warn('Agent status check failed, assuming online', {
						id: task.id,
						target: task.targetAgent,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// #268: Auto-start offline agent
			if (!agentOnline && this.agentStartCallback) {
				this.logger.info('Auto-starting offline agent for cron task', {
					id: task.id,
					target: task.targetAgent,
					teamId: task.targetTeamId,
				});
				try {
					const started = await this.agentStartCallback(task.targetAgent, task.targetTeamId);
					if (started) {
						agentOnline = true;
					} else {
						this.logger.warn('Failed to auto-start agent for cron task', {
							id: task.id,
							target: task.targetAgent,
						});
					}
				} catch (error) {
					this.logger.warn('Agent auto-start threw error', {
						id: task.id,
						target: task.targetAgent,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			if (!agentOnline) {
				this.logger.warn('Cron task skipped: target agent offline and could not be started', {
					id: task.id,
					target: task.targetAgent,
				});
				// Don't update lastRunAt — task was not actually executed
				// Advance nextRunAt so the same task isn't retried every minute
				task.nextRunAt = getNextRunTime(task.cronExpression, task.timezone, now);
				updated = true;
				continue;
			}

			// Execute the task
			try {
				if (this.executionCallback) {
					await this.executionCallback(task);
				}
			} catch (error) {
				this.logger.error('Cron task execution failed', {
					id: task.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}

			// Update run times
			task.lastRunAt = now.toISOString();
			task.nextRunAt = getNextRunTime(task.cronExpression, task.timezone, now);
			updated = true;
		}

		if (updated) {
			await this.saveStore(store);
		}
	}

	/**
	 * Load the cron task store from disk.
	 */
	private async loadStore(): Promise<CronTaskStore> {
		try {
			const data = await readFile(this.storeFile, 'utf-8');
			return JSON.parse(data) as CronTaskStore;
		} catch {
			return { tasks: [] };
		}
	}

	/**
	 * Save the cron task store to disk.
	 */
	private async saveStore(store: CronTaskStore): Promise<void> {
		const dir = path.dirname(this.storeFile);
		await mkdir(dir, { recursive: true });
		await writeFile(this.storeFile, JSON.stringify(store, null, 2), 'utf-8');
	}
}
