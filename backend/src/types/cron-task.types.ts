/**
 * Cron Task types — user-defined recurring tasks that agents cannot cancel.
 *
 * Part of the three-layer scheduling model:
 * 1. Scheduled Messages — agent-created, agent-cancellable
 * 2. Cron Tasks — user-created, only user/orchestrator can cancel
 * 3. Heartbeat — reserved for always-on roles (orchestrator/auditor)
 */

/**
 * A cron task definition stored in ~/.crewly/teams/{teamId}/cron-tasks.json.
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
	/**
	 * ISO timestamp of the most recent fire-slot that was skipped because
	 * the target agent was offline AND auto-start could not bring it back
	 * online within the wait window. Distinct from `lastRunAt: null`
	 * which means "never ran" — `lastSkippedAt` set + `lastRunAt: null`
	 * means "tried but couldn't deliver." Issue #305.
	 */
	lastSkippedAt?: string | null;
	/**
	 * Human-readable reason the last fire-slot was skipped. One of:
	 *   - `agent_offline_no_callback` — auto-start wasn't configured
	 *   - `agent_offline_start_failed` — callback threw or returned false
	 *   - `agent_offline_not_ready` — callback succeeded but agent
	 *     didn't come online within the wait window
	 *   - `agent_offline_retries_exhausted` — transient retries (#611) ran
	 *     out; equivalent terminal-skip for the consumer
	 * Issue #305 / #611.
	 */
	lastSkipReason?: string;
	/**
	 * Transient-skip retry counter (#611, 2026-05-28). Incremented every
	 * time `agent_offline_not_ready` / `agent_offline_start_failed` would
	 * have produced a permanent skip; reset to 0 on any successful run.
	 * The cron-eval loop reads this to decide whether to push `nextRunAt`
	 * out by a short backoff (retry) vs. permanently skip the slot.
	 *
	 * Why a stored counter and not an in-memory one: cron eval can fire
	 * on a fresh process (restart) and we still want the retry budget to
	 * survive — otherwise a transient OS spike that happens to coincide
	 * with a backend bounce would defeat the retry mechanism entirely.
	 */
	transientSkipAttempts?: number;
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
