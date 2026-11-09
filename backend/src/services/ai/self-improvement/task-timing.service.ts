import * as fs from 'fs';
import * as path from 'path';
import { TASK_TIMING_CONSTANTS } from '../../../constants.js';

/**
 * Task timing: how long an agent's OWN completed tasks actually took.
 *
 * Why: agents guessed ETAs ("about 1 hour") for work that historically takes
 * them ~20 minutes. The system records every completion automatically
 * (POST /task-pool/complete), echoes a one-line reflection back to the agent,
 * and puts a per-kind summary into the dispatch prompt and get-my-context so
 * the next ETA is based on the agent's own history instead of a guess.
 *
 * Not built on PredictionCalibrationService: predictions are yes/no
 * statements scored with a Brier score; durations need medians and an
 * estimate/actual ratio, so they get their own small store next to it.
 *
 * Storage: ~/.crewly/agents/{sessionName}/task-timings.json
 */

/** One completed task's timing. */
export interface TaskTimingRecord {
	/** Worker session that completed the task */
	agent: string;
	/** WorkItem id */
	workItemId: string;
	/** WorkItem title (truncated) */
	title: string;
	/** Task kind (agent-supplied or classified from the title) */
	kind: string;
	/** ETA the agent stated, in minutes, when it stated one */
	etaMinutes?: number;
	/** Claim (startedAt) to completion, in minutes */
	actualMinutes: number;
	/** ISO completion time */
	completedAt: string;
}

/** Stats for one task kind. */
export interface TaskKindStats {
	kind: string;
	/** Records counted (outliers over the work cap excluded) */
	n: number;
	medianMinutes: number;
	fastestMinutes: number;
	slowestMinutes: number;
}

/** An agent's timing summary across kinds. */
export interface TaskTimingSummary {
	/** Kinds with at least MIN_SAMPLES records, most frequent first */
	kinds: TaskKindStats[];
	/** Median of eta/actual over records with an ETA (null when fewer than MIN_SAMPLES) */
	etaBias: number | null;
}

/** Stored file shape. */
interface TaskTimingsData {
	records: TaskTimingRecord[];
}

/**
 * Keyword rules for {@link classifyTaskKind}, checked in order; first match
 * wins. Chinese keywords are kept because owners write titles in Chinese
 * (allowed exception: keyword lists matching user input).
 */
const KIND_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
	{ kind: 'review', pattern: /^(verify|review)\b|审核|验收/i },
	{ kind: 'research', pattern: /\b(research|investigat\w*|audit|analy[sz]\w*|compare|explore|survey)\b|调研|研究|分析/i },
	{ kind: 'revision', pattern: /\b(revis\w*|fix\w*|tweak\w*|adjust\w*|polish\w*|redo|rework\w*|iterat\w*|round \d+|v\d+)\b|修改|改|修|调整|重剪|第.版/i },
	{ kind: 'new-capability', pattern: /\b(capabilit\w*|skill|feature|support|pipeline|integrat\w*|automat\w*)\b|能力|功能|自动/i },
	{ kind: 'new-build', pattern: /\b(build|create|make|cut|new|draft|write|implement\w*|design)\b|做|剪|新|写/i },
];

/**
 * Classify a task by its title when the agent did not name the kind.
 * Kinds: review, research, revision, new-capability, new-build, other.
 *
 * @param title - WorkItem title
 * @returns The task kind
 */
export function classifyTaskKind(title: string): string {
	for (const rule of KIND_RULES) {
		if (rule.pattern.test(title)) return rule.kind;
	}
	return 'other';
}

/**
 * Normalize an agent-supplied kind ("New Build" -> "new-build").
 *
 * @param raw - Value from the request or WorkItem metadata
 * @returns A kebab-case kind, or undefined when unusable
 */
export function normalizeTaskKind(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const kind = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
	return kind.length > 0 && kind.length <= TASK_TIMING_CONSTANTS.KIND_MAX_CHARS ? kind : undefined;
}

/**
 * Parse an ETA in minutes; only positive, finite values up to the cap.
 *
 * @param raw - Value from the request or WorkItem metadata
 * @returns Minutes, or undefined when unusable
 */
export function parseEtaMinutes(raw: unknown): number | undefined {
	const n = typeof raw === 'string' ? Number(raw) : raw;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > TASK_TIMING_CONSTANTS.ETA_MAX_MINUTES) return undefined;
	return Math.round(n);
}

/**
 * Format minutes for a prompt line: "18 min", "60 min" or "2.6 h".
 *
 * @param minutes - Duration
 * @returns Short human string
 */
export function formatMinutes(minutes: number): string {
	return minutes < TASK_TIMING_CONSTANTS.HOURS_FROM_MINUTES ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** True when a record counts as work (spans over the cap are waits). */
function isWork(record: TaskTimingRecord): boolean {
	return record.actualMinutes <= TASK_TIMING_CONSTANTS.WORK_CAP_MINUTES;
}

/**
 * Summarize records by kind. Only kinds with at least MIN_SAMPLES records
 * are reported; spans over the 24 h work cap are excluded.
 *
 * @param records - An agent's timing records
 * @returns Per-kind stats and the ETA bias
 */
export function summarizeTimings(records: ReadonlyArray<TaskTimingRecord>): TaskTimingSummary {
	const work = records.filter(isWork);
	const byKind = new Map<string, number[]>();
	for (const r of work) {
		const list = byKind.get(r.kind) ?? [];
		list.push(r.actualMinutes);
		byKind.set(r.kind, list);
	}
	const kinds: TaskKindStats[] = [...byKind.entries()]
		.filter(([, mins]) => mins.length >= TASK_TIMING_CONSTANTS.MIN_SAMPLES)
		.map(([kind, mins]) => ({
			kind,
			n: mins.length,
			medianMinutes: median(mins),
			fastestMinutes: Math.min(...mins),
			slowestMinutes: Math.max(...mins),
		}))
		.sort((a, b) => b.n - a.n);
	const ratios = work
		.filter((r) => r.etaMinutes !== undefined)
		.map((r) => (r.etaMinutes as number) / Math.max(1, r.actualMinutes));
	const etaBias = ratios.length >= TASK_TIMING_CONSTANTS.MIN_SAMPLES ? median(ratios) : null;
	return { kinds, etaBias };
}

/**
 * The block shown at dispatch and in get-my-context.
 *
 * @param summary - From {@link summarizeTimings}
 * @returns Prompt text, or null when there is no usable history
 */
export function formatTimingBlock(summary: TaskTimingSummary): string | null {
	if (summary.kinds.length === 0) return null;
	const kinds = summary.kinds
		.map((k) => `${k.kind} median ${formatMinutes(k.medianMinutes)} (${formatMinutes(k.fastestMinutes)}–${formatMinutes(k.slowestMinutes)}, n=${k.n})`)
		.join('; ');
	let bias = '';
	if (summary.etaBias !== null) {
		const b = summary.etaBias;
		bias = b > TASK_TIMING_CONSTANTS.BIAS_TOLERANCE || b < 1 / TASK_TIMING_CONSTANTS.BIAS_TOLERANCE
			? ` Your ETAs run ${b.toFixed(1)}x actual.`
			: ' Your ETAs are about right.';
	}
	return (
		`Your own task times: ${kinds}.${bias} ` +
		'When you give an ETA, name the task kind and base it on your own median for that kind; ' +
		'give a longer one only with a stated reason (new footage, a long render, waiting on the owner). ' +
		'Record it with report-progress {"etaMinutes":N,"taskKind":"<kind>"}.'
	);
}

/**
 * The one- or two-line reflection returned by complete-task.
 *
 * @param record - The record just stored
 * @param summary - The agent's summary including that record
 * @returns Reflection text
 */
export function formatReflection(record: TaskTimingRecord, summary: TaskTimingSummary): string {
	const took = formatMinutes(record.actualMinutes);
	if (!isWork(record)) {
		return `This was a '${record.kind}'; it took ${took} from claim to completion. Over 24 h counts as waiting, not work, so it is left out of your medians.`;
	}
	const tookPart = record.etaMinutes !== undefined
		? ` You estimated ${formatMinutes(record.etaMinutes)}; it took ${took}.`
		: ` It took ${took}.`;
	const stats = summary.kinds.find((k) => k.kind === record.kind);
	const med = stats ? ` Your median for '${record.kind}' is ${formatMinutes(stats.medianMinutes)} (n=${stats.n}).` : '';
	let line = `This was a '${record.kind}'.${tookPart}${med}`;
	if (record.etaMinutes !== undefined) {
		const ratio = record.etaMinutes / Math.max(1, record.actualMinutes);
		if (ratio > TASK_TIMING_CONSTANTS.GAP_RATIO || ratio < 1 / TASK_TIMING_CONSTANTS.GAP_RATIO) {
			line += ` Your estimate was off by ${(ratio >= 1 ? ratio : 1 / ratio).toFixed(1)}x; if you see why, record it with record-learning.`;
		}
	}
	return line;
}

/**
 * Per-agent store of task timings.
 */
export class TaskTimingService {
	/**
	 * @param homeDir - Base directory holding `.crewly/` (defaults to $HOME; tests pass a temp dir)
	 */
	constructor(private readonly homeDir: string = process.env.HOME || process.env.USERPROFILE || '/tmp') {}

	private getFilePath(sessionName: string): string {
		return path.join(this.homeDir, '.crewly', 'agents', sessionName, TASK_TIMING_CONSTANTS.FILE_NAME);
	}

	/**
	 * Read an agent's records.
	 *
	 * @param sessionName - Agent session name
	 * @returns Records, oldest first (empty when none)
	 */
	getRecords(sessionName: string): TaskTimingRecord[] {
		try {
			const data = JSON.parse(fs.readFileSync(this.getFilePath(sessionName), 'utf-8')) as TaskTimingsData;
			return Array.isArray(data.records) ? data.records : [];
		} catch {
			return [];
		}
	}

	/**
	 * Store a record (a repeat completion of the same WorkItem replaces the
	 * earlier one) and keep at most MAX_RECORDS.
	 *
	 * @param record - The timing record
	 * @returns The agent's records after the write
	 */
	record(record: TaskTimingRecord): TaskTimingRecord[] {
		const records = this.getRecords(record.agent).filter((r) => r.workItemId !== record.workItemId);
		records.push(record);
		const kept = records.slice(-TASK_TIMING_CONSTANTS.MAX_RECORDS);
		const filePath = this.getFilePath(record.agent);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({ records: kept }, null, 2), 'utf-8');
		return kept;
	}

	/**
	 * The prompt block for an agent, or null when it has no usable history.
	 *
	 * @param sessionName - Agent session name
	 * @returns Prompt text or null
	 */
	getTimingBlock(sessionName: string): string | null {
		return formatTimingBlock(summarizeTimings(this.getRecords(sessionName)));
	}

	/**
	 * Record a completed WorkItem and return the reflection line.
	 *
	 * @param input - The completed item and who completed it
	 * @returns The reflection, or null when the item has no claim time
	 */
	recordCompletion(input: {
		agent: string;
		workItem: { id: string; title: string; startedAt?: string; metadata?: Record<string, unknown> };
		taskKind?: unknown;
		completedAt?: Date;
	}): string | null {
		const { agent, workItem } = input;
		const started = workItem.startedAt ? Date.parse(workItem.startedAt) : NaN;
		const completedAt = input.completedAt ?? new Date();
		if (!Number.isFinite(started)) return null;
		const actualMinutes = Math.max(1, Math.round((completedAt.getTime() - started) / 60000));
		const kind =
			normalizeTaskKind(input.taskKind) ??
			normalizeTaskKind(workItem.metadata?.[TASK_TIMING_CONSTANTS.KIND_METADATA_KEY]) ??
			classifyTaskKind(workItem.title);
		const etaMinutes = parseEtaMinutes(workItem.metadata?.[TASK_TIMING_CONSTANTS.ETA_METADATA_KEY]);
		const record: TaskTimingRecord = {
			agent,
			workItemId: workItem.id,
			title: workItem.title.slice(0, TASK_TIMING_CONSTANTS.TITLE_MAX_CHARS),
			kind,
			...(etaMinutes !== undefined ? { etaMinutes } : {}),
			actualMinutes,
			completedAt: completedAt.toISOString(),
		};
		const records = this.record(record);
		return formatReflection(record, summarizeTimings(records));
	}
}

let sharedInstance: TaskTimingService | null = null;

/**
 * The process-wide store (rooted at $HOME).
 *
 * @returns The shared TaskTimingService
 */
export function getTaskTimingService(): TaskTimingService {
	if (!sharedInstance) sharedInstance = new TaskTimingService();
	return sharedInstance;
}
