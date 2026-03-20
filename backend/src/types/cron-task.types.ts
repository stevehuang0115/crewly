/**
 * Cron Task types — user-defined recurring tasks that agents cannot cancel.
 *
 * Part of the three-layer scheduling model:
 * 1. Scheduled Messages — agent-created, agent-cancellable
 * 2. Cron Tasks — user-created, only user/orchestrator can cancel
 * 3. Heartbeat — reserved for always-on roles (orchestrator/auditor)
 */

/**
 * A cron task definition stored in ~/.crewly/cron-tasks.json.
 */
export interface CronTask {
	/** Unique identifier (cron-xxxx) */
	id: string;
	/** Standard cron expression (e.g. "0 9 * * *" = daily at 9am) */
	cronExpression: string;
	/** IANA timezone for cron evaluation (e.g. "Asia/Shanghai") */
	timezone: string;
	/** Target agent session name to receive the task */
	targetAgent: string;
	/** Team ID the target agent belongs to */
	targetTeamId: string;
	/** Task description to send to the agent */
	taskDescription: string;
	/** Who created this cron task */
	createdBy: 'user' | 'orchestrator';
	/** ISO timestamp when created */
	createdAt: string;
	/** Whether this cron task is active */
	enabled: boolean;
	/** ISO timestamp of last execution (null if never run) */
	lastRunAt: string | null;
	/** ISO timestamp of next scheduled run */
	nextRunAt: string | null;
}

/**
 * Storage format for cron-tasks.json.
 */
export interface CronTaskStore {
	tasks: CronTask[];
}

/**
 * Request body for creating a cron task.
 */
export interface CreateCronTaskRequest {
	cronExpression: string;
	timezone?: string;
	targetAgent: string;
	targetTeamId: string;
	taskDescription: string;
	createdBy?: 'user' | 'orchestrator';
}

/**
 * Request body for updating a cron task.
 * Agents can update taskDescription and cronExpression but not delete.
 */
export interface UpdateCronTaskRequest {
	cronExpression?: string;
	timezone?: string;
	taskDescription?: string;
	enabled?: boolean;
}
