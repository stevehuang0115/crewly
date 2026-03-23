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
 * Extract date/time parts from a Date in a specific IANA timezone.
 *
 * Uses Intl.DateTimeFormat to convert the UTC instant into the target
 * timezone, then extracts numeric minute, hour, dayOfWeek, dayOfMonth,
 * and month fields.
 *
 * @param date - The Date object (represents a UTC instant)
 * @param tz - IANA timezone string (e.g. "America/New_York", "Asia/Shanghai")
 * @returns Object with minute, hour, dayOfWeek (0=Sun), dayOfMonth, month (1-12)
 */
export function getDatePartsInTimezone(
	date: Date,
	tz: string,
): { minute: number; hour: number; dayOfWeek: number; dayOfMonth: number; month: number } {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: 'numeric',
		minute: 'numeric',
		weekday: 'short',
		day: 'numeric',
		month: 'numeric',
		hour12: false,
	});
	const partsMap = new Map<string, string>();
	for (const p of formatter.formatToParts(date)) {
		partsMap.set(p.type, p.value);
	}

	const weekdayStr = partsMap.get('weekday') || '';
	const weekdayMap: Record<string, number> = {
		Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
	};

	return {
		minute: parseInt(partsMap.get('minute') || '0', 10),
		hour: parseInt(partsMap.get('hour') || '0', 10),
		dayOfWeek: weekdayMap[weekdayStr] ?? 0,
		dayOfMonth: parseInt(partsMap.get('day') || '1', 10),
		month: parseInt(partsMap.get('month') || '1', 10),
	};
}

/**
 * Parse a single cron field spec into a set of allowed values.
 * Supports: `*`, single number, ranges (`1-5`), lists (`1,3,5`),
 * and step values (`*\/5`, `10-30/5`).
 *
 * @param spec - The cron field string (e.g. "*", "5", "1-5", "1,3,5", "*\/10")
 * @param min - Minimum allowed value for this field (inclusive)
 * @param max - Maximum allowed value for this field (inclusive)
 * @returns Set of matching integer values, or null for wildcard (match any)
 */
export function parseCronField(spec: string, min: number, max: number): Set<number> | null {
	if (spec === '*') return null; // wildcard

	const result = new Set<number>();

	for (const part of spec.split(',')) {
		const stepMatch = part.match(/^(.+)\/(\d+)$/);
		if (stepMatch) {
			const [, rangePart, stepStr] = stepMatch;
			const step = parseInt(stepStr, 10);
			let start = min;
			let end = max;

			if (rangePart !== '*') {
				const dashIdx = rangePart.indexOf('-');
				if (dashIdx !== -1) {
					start = parseInt(rangePart.slice(0, dashIdx), 10);
					end = parseInt(rangePart.slice(dashIdx + 1), 10);
				} else {
					start = parseInt(rangePart, 10);
					end = max;
				}
			}

			for (let v = start; v <= end; v += step) {
				result.add(v);
			}
		} else if (part.includes('-')) {
			const [startStr, endStr] = part.split('-');
			const start = parseInt(startStr, 10);
			const end = parseInt(endStr, 10);
			for (let v = start; v <= end; v++) {
				result.add(v);
			}
		} else {
			result.add(parseInt(part, 10));
		}
	}

	return result;
}

/**
 * Parse a cron expression and calculate the next run time.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Each field supports: `*`, numbers, ranges (`1-5`), lists (`1,3,5`),
 * and step values (`*\/5`).
 *
 * All field matching is done in the specified timezone so that a cron like
 * "0 9 * * *" in Asia/Shanghai fires at 09:00 Shanghai time regardless of
 * the server's local timezone.
 *
 * @param cronExpression - Standard 5-field cron expression
 * @param timezone - IANA timezone (e.g. "UTC", "America/New_York")
 * @param after - Calculate next run after this date (defaults to now)
 * @returns ISO string of next run time (always UTC)
 */
export function getNextRunTime(cronExpression: string, timezone: string, after?: Date): string {
	const now = after || new Date();
	const parts = cronExpression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
	}

	const minuteSet = parseCronField(parts[0], 0, 59);
	const hourSet = parseCronField(parts[1], 0, 23);
	const domSet = parseCronField(parts[2], 1, 31);
	const monthSet = parseCronField(parts[3], 1, 12);
	const dowSet = parseCronField(parts[4], 0, 6);

	const candidate = new Date(now.getTime());
	// Advance by 1 minute minimum to avoid re-triggering
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	// Try up to 8 days of minutes (covers full week + buffer for day-of-week crons)
	for (let i = 0; i < 8 * 24 * 60; i++) {
		// Extract fields in the TARGET timezone, not server-local
		const tp = getDatePartsInTimezone(candidate, timezone);

		const minuteMatch = !minuteSet || minuteSet.has(tp.minute);
		const hourMatch = !hourSet || hourSet.has(tp.hour);
		const domMatch = !domSet || domSet.has(tp.dayOfMonth);
		const monthMatch = !monthSet || monthSet.has(tp.month);
		const dowMatch = !dowSet || dowSet.has(tp.dayOfWeek);

		if (minuteMatch && hourMatch && domMatch && monthMatch && dowMatch) {
			return candidate.toISOString();
		}

		candidate.setMinutes(candidate.getMinutes() + 1);
	}

	// Fallback: 24 hours from now
	return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Callback type for checking whether an agent is online.
 * Should return true if the agent is reachable and can receive tasks.
 *
 * @param sessionName - The agent's PTY session name
 * @param teamId - The team ID the agent belongs to
 * @returns True if the agent is online and ready
 */
export type AgentStatusCallback = (sessionName: string, teamId: string) => Promise<boolean>;

/**
 * Callback type for auto-starting an offline agent.
 *
 * @param sessionName - The agent's PTY session name
 * @param teamId - The team ID the agent belongs to
 * @returns True if the agent was successfully started
 */
export type AgentStartCallback = (sessionName: string, teamId: string) => Promise<boolean>;

/**
 * Service for managing cron tasks.
 *
 * Lifecycle:
 * 1. Get singleton via `getInstance()`
 * 2. Wire callbacks: `setExecutionCallback()`, `setAgentStatusCallback()`, `setAgentStartCallback()`
 * 3. Call `start()` to begin the evaluation loop
 * 4. On startup, call `recalculateAllNextRunTimes()` to self-heal stale values
 */
export class CronTaskService {
	private static instance: CronTaskService | null = null;
	private logger: ComponentLogger;
	private storeFile: string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private executionCallback: ((task: CronTask) => Promise<void>) | null = null;
	private agentStatusCallback: AgentStatusCallback | null = null;
	private agentStartCallback: AgentStartCallback | null = null;

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
	 * Set the callback for checking agent online status.
	 * Called before executing a task to verify the target agent is reachable.
	 * Should treat both 'active' and 'started' states as online.
	 *
	 * @param callback - Async function returning true if agent is online
	 */
	setAgentStatusCallback(callback: AgentStatusCallback): void {
		this.agentStatusCallback = callback;
	}

	/**
	 * Set the callback for auto-starting an offline agent.
	 * Called when a cron task fires but the target agent is offline.
	 *
	 * @param callback - Async function that starts an agent, returns true on success
	 */
	setAgentStartCallback(callback: AgentStartCallback): void {
		this.agentStartCallback = callback;
	}

	/**
	 * Start the cron task evaluation loop.
	 * Checks every minute for tasks whose nextRunAt has passed.
	 */
	start(): void {
		if (this.timer) return;

		this.logger.info('Starting cron task service', { intervalMs: CRON_CHECK_INTERVAL_MS });

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
	 * Recalculate nextRunAt for all enabled tasks using the stored timezone.
	 * This self-heals stale values from older versions that computed nextRunAt
	 * in the server's local timezone instead of the task's specified timezone.
	 *
	 * Should be called once on backend startup, before start().
	 *
	 * @returns Number of tasks whose nextRunAt was updated
	 */
	async recalculateAllNextRunTimes(): Promise<number> {
		const store = await this.loadStore();
		let updated = 0;

		for (const task of store.tasks) {
			if (!task.enabled) continue;

			const after = task.lastRunAt ? new Date(task.lastRunAt) : undefined;
			const recalculated = getNextRunTime(task.cronExpression, task.timezone, after);

			if (recalculated !== task.nextRunAt) {
				this.logger.info('Self-healed stale nextRunAt', {
					id: task.id,
					old: task.nextRunAt,
					new: recalculated,
					timezone: task.timezone,
				});
				task.nextRunAt = recalculated;
				updated++;
			}
		}

		if (updated > 0) {
			await this.saveStore(store);
			this.logger.info('Recalculated nextRunAt for stale tasks', { count: updated });
		}

		return updated;
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
	 * If an agentStatusCallback is set, checks whether the target agent is online
	 * before execution. If the agent is offline and an agentStartCallback is set,
	 * attempts to auto-start the agent before executing.
	 */
	async evaluateTasks(): Promise<void> {
		const store = await this.loadStore();
		const now = new Date();
		let updated = false;

		for (const task of store.tasks) {
			if (!task.enabled || !task.nextRunAt) continue;

			const nextRun = new Date(task.nextRunAt);
			if (nextRun > now) continue;

			// Task is due — check agent status before executing
			let agentOnline = true;
			if (this.agentStatusCallback) {
				try {
					agentOnline = await this.agentStatusCallback(task.targetAgent, task.targetTeamId);
				} catch (error) {
					this.logger.warn('Agent status check failed, assuming offline', {
						id: task.id,
						target: task.targetAgent,
						error: error instanceof Error ? error.message : String(error),
					});
					agentOnline = false;
				}
			}

			// Auto-start offline agent if callback is available
			if (!agentOnline && this.agentStartCallback) {
				this.logger.info('Agent offline for cron task, attempting auto-start', {
					id: task.id,
					target: task.targetAgent,
				});
				try {
					const started = await this.agentStartCallback(task.targetAgent, task.targetTeamId);
					if (started) {
						agentOnline = true;
						this.logger.info('Agent auto-started successfully', {
							id: task.id,
							target: task.targetAgent,
						});
					}
				} catch (error) {
					this.logger.error('Agent auto-start failed', {
						id: task.id,
						target: task.targetAgent,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			if (!agentOnline) {
				this.logger.warn('Skipping cron task — agent offline and auto-start unavailable', {
					id: task.id,
					target: task.targetAgent,
				});
				// Still advance nextRunAt to prevent re-evaluating the same missed slot
				task.nextRunAt = getNextRunTime(task.cronExpression, task.timezone, now);
				updated = true;
				continue;
			}

			this.logger.info('Cron task due, executing', {
				id: task.id,
				target: task.targetAgent,
				nextRunAt: task.nextRunAt,
			});

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

			// Update run times regardless of execution success
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
