/**
 * Cron Task Service
 *
 * Manages user-defined recurring tasks that run on cron schedules.
 * Unlike scheduled messages (agent-created/cancellable), cron tasks
 * can only be cancelled by user or orchestrator.
 *
 * Storage: Per-team at ~/.crewly/teams/{teamId}/cron-tasks.json
 * Migration: Global ~/.crewly/cron-tasks.json is auto-migrated on first startup.
 *
 * @module services/workflow/cron-task.service
 */

import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, readdir, rename } from 'fs/promises';
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

/** Name of the per-team cron task file */
const CRON_TASKS_FILENAME = 'cron-tasks.json';

/** Suffix appended to the global file after successful migration */
const MIGRATED_SUFFIX = '.migrated';

/** Team ID value used for orchestrator-level cron tasks (not team-scoped) */
const ORCHESTRATOR_TEAM_ID = 'orchestrator';

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
 * Service for managing cron tasks with per-team scoped storage.
 *
 * Storage layout:
 *   ~/.crewly/teams/{teamId}/cron-tasks.json
 *
 * On first startup, migrates the legacy global file
 * (~/.crewly/cron-tasks.json) by grouping tasks by targetTeamId
 * and writing per-team files. The global file is renamed to
 * cron-tasks.json.migrated to prevent re-migration.
 *
 * Lifecycle:
 * 1. Get singleton via `getInstance()`
 * 2. Wire callbacks: `setExecutionCallback()`, `setAgentStatusCallback()`, `setAgentStartCallback()`
 * 3. Call `migrateGlobalToTeamScoped()` to auto-migrate legacy storage
 * 4. Call `start()` to begin the evaluation loop
 * 5. On startup, call `recalculateAllNextRunTimes()` to self-heal stale values
 */
export class CronTaskService {
	private static instance: CronTaskService | null = null;
	private logger: ComponentLogger;
	/** Root crewly home directory (e.g. ~/.crewly) */
	private crewlyHome: string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private executionCallback: ((task: CronTask) => Promise<void>) | null = null;
	private agentStatusCallback: AgentStatusCallback | null = null;
	private agentStartCallback: AgentStartCallback | null = null;

	constructor(crewlyHome?: string) {
		this.logger = LoggerService.getInstance().createComponentLogger('CronTaskService');
		this.crewlyHome = crewlyHome || path.join(os.homedir(), '.crewly');
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
	 * Get the store file path for a specific team.
	 *
	 * @param teamId - Team ID
	 * @returns Absolute path to the team's cron-tasks.json
	 */
	getStoreFile(teamId: string): string {
		return path.join(this.crewlyHome, 'teams', teamId, CRON_TASKS_FILENAME);
	}

	/**
	 * Get the legacy global store file path.
	 *
	 * @returns Absolute path to the global cron-tasks.json
	 */
	private getGlobalStoreFile(): string {
		return path.join(this.crewlyHome, CRON_TASKS_FILENAME);
	}

	/**
	 * Migrate legacy global cron-tasks.json to per-team files.
	 *
	 * Orchestrator-targeted tasks (targetTeamId === 'orchestrator') are kept
	 * in the global file since they don't belong to any specific team.
	 * All other tasks are grouped by targetTeamId and written to per-team files.
	 *
	 * After migration, the global file is rewritten to contain only orchestrator
	 * tasks, and a .migrated marker is created to prevent re-running.
	 *
	 * Idempotent: skips if the .migrated marker already exists or no global file exists.
	 *
	 * @returns Number of tasks migrated to per-team files (excludes orchestrator tasks kept in global)
	 */
	async migrateGlobalToTeamScoped(): Promise<number> {
		const globalFile = this.getGlobalStoreFile();
		const migratedFile = globalFile + MIGRATED_SUFFIX;

		// Skip if already migrated or no global file exists
		if (existsSync(migratedFile) || !existsSync(globalFile)) {
			return 0;
		}

		let globalStore: CronTaskStore;
		try {
			const data = await readFile(globalFile, 'utf-8');
			globalStore = JSON.parse(data) as CronTaskStore;
		} catch {
			// Cannot read/parse global file — nothing to migrate
			return 0;
		}

		if (globalStore.tasks.length === 0) {
			// Empty store — write marker and skip
			await writeFile(migratedFile, '', 'utf-8');
			return 0;
		}

		// Partition: orchestrator tasks stay global, everything else goes per-team
		const orchestratorTasks: CronTask[] = [];
		const teamGroups = new Map<string, CronTask[]>();

		for (const task of globalStore.tasks) {
			if (task.targetTeamId === ORCHESTRATOR_TEAM_ID) {
				orchestratorTasks.push(task);
			} else {
				const teamId = task.targetTeamId;
				if (!teamGroups.has(teamId)) {
					teamGroups.set(teamId, []);
				}
				teamGroups.get(teamId)!.push(task);
			}
		}

		// Write team-scoped tasks to per-team files
		let migratedCount = 0;
		for (const [teamId, tasks] of teamGroups) {
			const teamStore = await this.loadTeamStore(teamId);
			// Merge: add migrated tasks that don't already exist
			const existingIds = new Set(teamStore.tasks.map(t => t.id));
			for (const task of tasks) {
				if (!existingIds.has(task.id)) {
					teamStore.tasks.push(task);
					migratedCount++;
				}
			}
			await this.saveTeamStore(teamId, teamStore);
		}

		// Rewrite global file with only orchestrator tasks
		await this.saveGlobalStore({ tasks: orchestratorTasks });

		// Write migration marker to prevent re-running
		await writeFile(migratedFile, new Date().toISOString(), 'utf-8');

		this.logger.info('Migrated global cron-tasks.json to per-team storage', {
			migratedCount,
			orchestratorKept: orchestratorTasks.length,
			teamCount: teamGroups.size,
		});

		return migratedCount;
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
		const allTasks = await this.loadAllTasks();
		const now = new Date();
		let updated = 0;

		// Group tasks back by team for saving
		const dirtyTeams = new Set<string>();

		for (const task of allTasks) {
			if (!task.enabled) continue;

			// If task has never run AND its nextRunAt is in the past, this is a missed first run.
			if (!task.lastRunAt && task.nextRunAt && new Date(task.nextRunAt) <= now) {
				this.logger.info('Missed first run detected — keeping stale nextRunAt for immediate execution', {
					id: task.id,
					nextRunAt: task.nextRunAt,
					timezone: task.timezone,
				});
				continue;
			}

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
				dirtyTeams.add(task.targetTeamId);
			}
		}

		// Save only modified team stores
		if (dirtyTeams.size > 0) {
			for (const teamId of dirtyTeams) {
				const teamTasks = allTasks.filter(t => t.targetTeamId === teamId);
				await this.saveTeamStore(teamId, { tasks: teamTasks });
			}
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

		// Orchestrator tasks go to global store; team tasks go to per-team store
		if (task.targetTeamId === ORCHESTRATOR_TEAM_ID) {
			const store = await this.loadGlobalStore();
			store.tasks.push(task);
			await this.saveGlobalStore(store);
		} else {
			const store = await this.loadTeamStore(task.targetTeamId);
			store.tasks.push(task);
			await this.saveTeamStore(task.targetTeamId, store);
		}

		this.logger.info('Cron task created', { id: task.id, cron: task.cronExpression, target: task.targetAgent, teamId: task.targetTeamId });
		return task;
	}

	/**
	 * List all cron tasks across all teams, optionally filtered.
	 *
	 * @param filter - Optional filter criteria
	 * @returns Array of matching cron tasks
	 */
	async list(filter?: { targetAgent?: string; enabled?: boolean }): Promise<CronTask[]> {
		let tasks = await this.loadAllTasks();

		if (filter?.targetAgent) {
			tasks = tasks.filter(t => t.targetAgent === filter.targetAgent);
		}
		if (filter?.enabled !== undefined) {
			tasks = tasks.filter(t => t.enabled === filter.enabled);
		}

		return tasks;
	}

	/**
	 * List cron tasks for a specific team.
	 *
	 * @param teamId - Team ID to filter by
	 * @param filter - Optional additional filter criteria
	 * @returns Array of matching cron tasks for the team
	 */
	async getByTeam(teamId: string, filter?: { targetAgent?: string; enabled?: boolean }): Promise<CronTask[]> {
		const store = await this.loadTeamStore(teamId);
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
	 * Get a single cron task by ID. Searches across all teams.
	 *
	 * @param id - Cron task ID
	 * @returns The cron task or null
	 */
	async get(id: string): Promise<CronTask | null> {
		const allTasks = await this.loadAllTasks();
		return allTasks.find(t => t.id === id) || null;
	}

	/**
	 * Update a cron task. Searches across all teams to find the task.
	 *
	 * @param id - Cron task ID
	 * @param updates - Fields to update
	 * @returns Updated task or null if not found
	 */
	async update(id: string, updates: UpdateCronTaskRequest): Promise<CronTask | null> {
		// Helper to apply updates to a task
		const applyUpdates = (task: CronTask): void => {
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
		};

		// Search global store first (orchestrator tasks)
		const globalStore = await this.loadGlobalStore();
		const globalTask = globalStore.tasks.find(t => t.id === id);
		if (globalTask) {
			applyUpdates(globalTask);
			await this.saveGlobalStore(globalStore);
			this.logger.info('Cron task updated', { id, location: 'global', updates: Object.keys(updates) });
			return globalTask;
		}

		// Search per-team stores
		const teamIds = await this.getTeamIds();
		for (const teamId of teamIds) {
			const store = await this.loadTeamStore(teamId);
			const task = store.tasks.find(t => t.id === id);
			if (!task) continue;

			applyUpdates(task);
			await this.saveTeamStore(teamId, store);
			this.logger.info('Cron task updated', { id, teamId, updates: Object.keys(updates) });
			return task;
		}

		return null;
	}

	/**
	 * Delete a cron task. Searches across all teams to find and remove it.
	 *
	 * @param id - Cron task ID
	 * @returns true if deleted, false if not found
	 */
	async delete(id: string): Promise<boolean> {
		// Search global store first (orchestrator tasks)
		const globalStore = await this.loadGlobalStore();
		const globalIndex = globalStore.tasks.findIndex(t => t.id === id);
		if (globalIndex !== -1) {
			globalStore.tasks.splice(globalIndex, 1);
			await this.saveGlobalStore(globalStore);
			this.logger.info('Cron task deleted', { id, location: 'global' });
			return true;
		}

		// Search per-team stores
		const teamIds = await this.getTeamIds();
		for (const teamId of teamIds) {
			const store = await this.loadTeamStore(teamId);
			const index = store.tasks.findIndex(t => t.id === id);
			if (index === -1) continue;

			store.tasks.splice(index, 1);
			await this.saveTeamStore(teamId, store);
			this.logger.info('Cron task deleted', { id, teamId });
			return true;
		}

		return false;
	}

	/**
	 * Evaluate all enabled tasks and execute those whose nextRunAt has passed.
	 * If an agentStatusCallback is set, checks whether the target agent is online
	 * before execution. If the agent is offline and an agentStartCallback is set,
	 * attempts to auto-start the agent before executing.
	 */
	async evaluateTasks(): Promise<void> {
		const now = new Date();

		// Evaluate global orchestrator tasks
		const globalStore = await this.loadGlobalStore();
		let globalUpdated = false;
		for (const task of globalStore.tasks) {
			const result = await this.evaluateSingleTask(task, now);
			if (result) globalUpdated = true;
		}
		if (globalUpdated) {
			await this.saveGlobalStore(globalStore);
		}

		// Evaluate per-team tasks
		const teamIds = await this.getTeamIds();

		for (const teamId of teamIds) {
			const store = await this.loadTeamStore(teamId);
			let updated = false;

			for (const task of store.tasks) {
				const result = await this.evaluateSingleTask(task, now);
				if (result) updated = true;
			}

			if (updated) {
				await this.saveTeamStore(teamId, store);
			}
		}
	}

	/**
	 * Evaluate a single cron task: check if due, verify agent status, execute.
	 * Mutates the task in-place (lastRunAt, nextRunAt).
	 *
	 * @param task - The cron task to evaluate
	 * @param now - Current time for comparison
	 * @returns true if the task was modified (needs saving)
	 */
	private async evaluateSingleTask(task: CronTask, now: Date): Promise<boolean> {
		if (!task.enabled || !task.nextRunAt) return false;

		const nextRun = new Date(task.nextRunAt);
		if (nextRun > now) return false;

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
			return true;
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
		return true;
	}

	// ============ Storage Methods ============

	/**
	 * Load cron task store for a specific team.
	 *
	 * @param teamId - Team ID
	 * @returns Team's cron task store (empty if file doesn't exist)
	 */
	private async loadTeamStore(teamId: string): Promise<CronTaskStore> {
		try {
			const filePath = this.getStoreFile(teamId);
			const data = await readFile(filePath, 'utf-8');
			return JSON.parse(data) as CronTaskStore;
		} catch {
			return { tasks: [] };
		}
	}

	/**
	 * Save cron task store for a specific team.
	 *
	 * @param teamId - Team ID
	 * @param store - Store data to persist
	 */
	private async saveTeamStore(teamId: string, store: CronTaskStore): Promise<void> {
		const filePath = this.getStoreFile(teamId);
		const dir = path.dirname(filePath);
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
	}

	/**
	 * Load the global cron task store (orchestrator tasks only).
	 *
	 * @returns Global store (empty if file doesn't exist)
	 */
	private async loadGlobalStore(): Promise<CronTaskStore> {
		try {
			const data = await readFile(this.getGlobalStoreFile(), 'utf-8');
			return JSON.parse(data) as CronTaskStore;
		} catch {
			return { tasks: [] };
		}
	}

	/**
	 * Save the global cron task store (orchestrator tasks only).
	 *
	 * @param store - Store data to persist
	 */
	private async saveGlobalStore(store: CronTaskStore): Promise<void> {
		const filePath = this.getGlobalStoreFile();
		const dir = path.dirname(filePath);
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
	}

	/**
	 * Load all tasks from all team stores plus the global store,
	 * aggregated into a single array.
	 *
	 * @returns All cron tasks across all teams and the global orchestrator store
	 */
	private async loadAllTasks(): Promise<CronTask[]> {
		const teamIds = await this.getTeamIds();
		const allTasks: CronTask[] = [];

		// Load orchestrator tasks from global store
		const globalStore = await this.loadGlobalStore();
		allTasks.push(...globalStore.tasks);

		// Load per-team tasks
		for (const teamId of teamIds) {
			const store = await this.loadTeamStore(teamId);
			allTasks.push(...store.tasks);
		}

		return allTasks;
	}

	/**
	 * Discover all team IDs that have cron task files.
	 *
	 * Scans ~/.crewly/teams/ for directories containing cron-tasks.json.
	 *
	 * @returns Array of team IDs
	 */
	private async getTeamIds(): Promise<string[]> {
		const teamsDir = path.join(this.crewlyHome, 'teams');
		try {
			const entries = await readdir(teamsDir, { withFileTypes: true });
			const teamIds: string[] = [];

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const cronFile = path.join(teamsDir, entry.name, CRON_TASKS_FILENAME);
				if (existsSync(cronFile)) {
					teamIds.push(entry.name);
				}
			}

			return teamIds;
		} catch {
			// teams directory doesn't exist yet
			return [];
		}
	}
}
