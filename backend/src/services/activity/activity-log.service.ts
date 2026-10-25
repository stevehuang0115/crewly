/**
 * Activity log (crewly#881): the append-only record of who did what and when.
 *
 * - One `<CREWLY_HOME>/activity-log/YYYY-MM.jsonl` file per month, one JSON
 *   entry per line. Nothing is ever rewritten or deleted here.
 * - Each entry names the actor (owner / agent / system, with its id and how it
 *   was recognised), the action (`team.member.updated`, `decision.resolved`,
 *   …), the target, and a before / after summary of the changed fields with
 *   secret-looking keys masked and long strings cut.
 * - Writes are chained on one promise and never awaited by callers; a failed
 *   write is logged, never thrown. Reads walk the monthly files newest first
 *   and stop once the limit is reached.
 *
 * Writers: team / member config handlers (`team.controller.ts`) and owner
 * decisions (`decision.service.ts`). Reader: `GET /api/activity`.
 *
 * `specs/2026-10-25-activity-log.md`
 *
 * @module services/activity/activity-log.service
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import { ACTIVITY_LOG_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCallerIdentity, type CallerIdentity, type IdentifiableRequest } from '../../middleware/caller-identity.middleware.js';

/** Who acted. */
export type ActivityActorType = 'owner' | 'agent' | 'system';

/** The actor of an entry. */
export interface ActivityActor {
	/** Owner, an agent, or Crewly itself (schedulers, deadlines, anonymous local calls) */
	type: ActivityActorType;
	/** The agent session, Slack user id, scheduler name, … when known */
	id?: string;
	/** How the actor was recognised (`owner-session`, `api-token`, `agent-badge`, `deadline`, …) */
	via?: string;
}

/** What an entry is about. */
export interface ActivityTarget {
	/** `team`, `member`, `decision`, … */
	type: string;
	id: string;
	/** Display name at the time of the action */
	name?: string;
}

/** One line of the log. */
export interface ActivityEntry {
	id: string;
	/** ISO timestamp */
	ts: string;
	actor: ActivityActor;
	/** Dotted, past tense: `team.member.updated`, `decision.resolved` */
	action: string;
	target: ActivityTarget;
	/** Changed fields before the action (masked, truncated) */
	before?: Record<string, unknown>;
	/** Changed fields after the action (masked, truncated) */
	after?: Record<string, unknown>;
	/** The Crewly Request this happened under, when known */
	requestId?: string;
	/** The WorkItem this happened under, when known */
	workItemId?: string;
	/** Short free text (an answer, a reason) */
	note?: string;
}

/** What a writer hands in; id and timestamp are filled here. */
export type ActivityEntryInput = Omit<ActivityEntry, 'id' | 'ts'> & { ts?: string };

/** Filters of a read. All optional; `action` and ids match exactly, `action` also by `prefix.` */
export interface ActivityQuery {
	actorType?: ActivityActorType;
	actorId?: string;
	/** Exact action, or a dotted prefix such as `team.` */
	action?: string;
	targetType?: string;
	targetId?: string;
	/** ISO timestamp (inclusive) */
	since?: string;
	/** ISO timestamp (inclusive) */
	until?: string;
	limit?: number;
}

/** File operations the log uses (injectable to simulate failures). */
export interface ActivityFsOps {
	mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
	appendFile(file: string, data: string): Promise<void>;
	readFile(file: string): Promise<string>;
	readdir(dir: string): Promise<string[]>;
}

const NODE_FS: ActivityFsOps = {
	mkdir: (dir, opts) => fsp.mkdir(dir, opts),
	appendFile: (file, data) => fsp.appendFile(file, data, 'utf8'),
	readFile: (file) => fsp.readFile(file, 'utf8'),
	readdir: (dir) => fsp.readdir(dir),
};

/** Construction options. */
export interface ActivityLogOptions {
	/** Log directory (default `<CREWLY_HOME>/activity-log`) */
	dir?: string;
	fs?: ActivityFsOps;
	now?: () => Date;
	logger?: ComponentLogger;
}

const ACTOR_TYPES: ReadonlySet<string> = new Set<ActivityActorType>(['owner', 'agent', 'system']);

/**
 * Whether a string names an actor type.
 *
 * @param value - Candidate
 * @returns True for owner / agent / system
 */
export function isActivityActorType(value: unknown): value is ActivityActorType {
	return typeof value === 'string' && ACTOR_TYPES.has(value);
}

/**
 * Mask secret-looking keys and cut long strings, recursively. Arrays and plain
 * objects are walked; anything else is kept as is.
 *
 * @param value - Any JSON-ish value
 * @returns The value safe to write
 */
export function maskForActivity(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > ACTIVITY_LOG_CONSTANTS.MAX_SUMMARY_CHARS ? `${value.slice(0, ACTIVITY_LOG_CONSTANTS.MAX_SUMMARY_CHARS)}…` : value;
	}
	if (Array.isArray(value)) return value.map(maskForActivity);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = ACTIVITY_LOG_CONSTANTS.SECRET_KEY_PATTERN.test(k) && v !== undefined && v !== null ? ACTIVITY_LOG_CONSTANTS.MASK : maskForActivity(v);
		}
		return out;
	}
	return value;
}

/**
 * The fields that differ between two shallow records, as a before / after
 * pair (masked). Equal fields are left out so an entry shows only the change;
 * a key absent on one side appears as `undefined` → left out of that side.
 *
 * @param before - Record before the change (null when created)
 * @param after - Record after the change (null when deleted)
 * @returns Masked before / after summaries, each undefined when empty
 */
export function summarizeChange(
	before: Record<string, unknown> | null | undefined,
	after: Record<string, unknown> | null | undefined,
): { before?: Record<string, unknown>; after?: Record<string, unknown> } {
	const b: Record<string, unknown> = {};
	const a: Record<string, unknown> = {};
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	for (const k of keys) {
		const bv = before?.[k];
		const av = after?.[k];
		if (JSON.stringify(bv) === JSON.stringify(av)) continue;
		if (bv !== undefined) b[k] = bv;
		if (av !== undefined) a[k] = av;
	}
	return {
		...(Object.keys(b).length ? { before: maskForActivity(b) as Record<string, unknown> } : {}),
		...(Object.keys(a).length ? { after: maskForActivity(a) as Record<string, unknown> } : {}),
	};
}

/**
 * The actor behind a caller identity: owner credentials (dashboard session,
 * API token, phone / portal relay, cloud) are the owner; an agent is itself;
 * schedulers and anonymous local calls are the system.
 *
 * @param identity - What the caller-identity middleware decided
 * @returns The actor
 */
export function actorFromCaller(identity: CallerIdentity): ActivityActor {
	switch (identity.kind) {
		case 'owner':
		case 'relay-owner':
		case 'cloud':
			return { type: 'owner', via: identity.via };
		case 'agent':
			return { type: 'agent', ...(identity.session ? { id: identity.session } : {}), via: identity.via };
		case 'scheduler':
			return { type: 'system', id: identity.sender ?? 'scheduler', via: identity.via };
		default:
			return { type: 'system', id: 'anonymous', via: identity.via };
	}
}

/**
 * The actor of an HTTP request.
 *
 * @param req - Request
 * @returns The actor
 */
export function actorFromRequest(req: IdentifiableRequest): ActivityActor {
	return actorFromCaller(getCallerIdentity(req));
}

/**
 * The append-only activity log.
 */
export class ActivityLogService {
	private readonly dir: string;
	private readonly fs: ActivityFsOps;
	private readonly now: () => Date;
	private readonly logger: ComponentLogger;
	private chain: Promise<void> = Promise.resolve();
	private dirReady = false;
	private seq = 0;

	/**
	 * @param options - Directory, file ops, clock, logger (all optional)
	 */
	constructor(options: ActivityLogOptions = {}) {
		this.dir = options.dir ?? path.join(getCrewlyHomePath(), ACTIVITY_LOG_CONSTANTS.DIR);
		this.fs = options.fs ?? NODE_FS;
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger ?? LoggerService.getInstance().createComponentLogger('ActivityLog');
	}

	/**
	 * Append one entry. Returns at once; the write is chained after earlier
	 * writes and a failure is logged, never thrown.
	 *
	 * @param input - The entry without id / timestamp
	 * @returns The entry as it will be written
	 */
	record(input: ActivityEntryInput): ActivityEntry {
		const ts = input.ts ?? this.now().toISOString();
		const entry: ActivityEntry = {
			id: `${Date.parse(ts).toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			ts,
			actor: input.actor,
			action: input.action,
			target: input.target,
			...(input.before ? { before: maskForActivity(input.before) as Record<string, unknown> } : {}),
			...(input.after ? { after: maskForActivity(input.after) as Record<string, unknown> } : {}),
			...(input.requestId ? { requestId: input.requestId } : {}),
			...(input.workItemId ? { workItemId: input.workItemId } : {}),
			...(input.note ? { note: (maskForActivity(input.note) as string) } : {}),
		};
		const file = this.fileFor(ts);
		this.chain = this.chain
			.then(async () => {
				if (!this.dirReady) {
					await this.fs.mkdir(this.dir, { recursive: true });
					this.dirReady = true;
				}
				await this.fs.appendFile(file, `${JSON.stringify(entry)}\n`);
			})
			.catch((err) => {
				this.dirReady = false;
				this.logger.warn('Activity log write failed', { action: entry.action, error: err instanceof Error ? err.message : String(err) });
			});
		return entry;
	}

	/**
	 * Wait for every write handed in so far.
	 *
	 * @returns When the chain is idle
	 */
	flush(): Promise<void> {
		return this.chain;
	}

	/**
	 * Read entries newest first.
	 *
	 * @param query - Filters and limit
	 * @returns Matching entries, newest first, at most `limit`
	 */
	async list(query: ActivityQuery = {}): Promise<ActivityEntry[]> {
		await this.flush();
		const limit = Math.max(1, Math.min(ACTIVITY_LOG_CONSTANTS.MAX_LIMIT, Math.floor(query.limit ?? ACTIVITY_LOG_CONSTANTS.DEFAULT_LIMIT)));
		const files = await this.monthlyFiles(query);
		const out: ActivityEntry[] = [];
		for (const file of files) {
			let raw: string;
			try {
				raw = await this.fs.readFile(path.join(this.dir, file));
			} catch {
				continue;
			}
			const lines = raw.split('\n');
			for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
				const entry = parseLine(lines[i]);
				if (entry && matches(entry, query)) out.push(entry);
			}
			if (out.length >= limit) break;
		}
		return out;
	}

	/**
	 * The monthly files worth opening for a query, newest first, bounded by
	 * MAX_FILES_PER_READ and by the query's time window.
	 *
	 * @param query - Filters (since / until narrow the months)
	 * @returns File names
	 */
	private async monthlyFiles(query: ActivityQuery): Promise<string[]> {
		let names: string[];
		try {
			names = await this.fs.readdir(this.dir);
		} catch {
			return [];
		}
		const sinceMonth = query.since ? monthOf(query.since) : null;
		const untilMonth = query.until ? monthOf(query.until) : null;
		return names
			.filter((n) => n.endsWith(ACTIVITY_LOG_CONSTANTS.FILE_EXT))
			.map((n) => n.slice(0, -ACTIVITY_LOG_CONSTANTS.FILE_EXT.length))
			.filter((m) => /^\d{4}-\d{2}$/.test(m))
			.filter((m) => (!sinceMonth || m >= sinceMonth) && (!untilMonth || m <= untilMonth))
			.sort()
			.reverse()
			.slice(0, ACTIVITY_LOG_CONSTANTS.MAX_FILES_PER_READ)
			.map((m) => `${m}${ACTIVITY_LOG_CONSTANTS.FILE_EXT}`);
	}

	/**
	 * The file an entry at a timestamp belongs to.
	 *
	 * @param ts - ISO timestamp
	 * @returns Absolute path
	 */
	private fileFor(ts: string): string {
		return path.join(this.dir, `${monthOf(ts) ?? 'unknown'}${ACTIVITY_LOG_CONSTANTS.FILE_EXT}`);
	}
}

/**
 * `YYYY-MM` of an ISO timestamp (UTC), or null when unparsable.
 *
 * @param ts - ISO timestamp
 * @returns The month key
 */
function monthOf(ts: string): string | null {
	const ms = Date.parse(ts);
	if (Number.isNaN(ms)) return null;
	return new Date(ms).toISOString().slice(0, 7);
}

/**
 * Parse one log line; a blank or damaged line is skipped.
 *
 * @param line - Raw line
 * @returns The entry or null
 */
function parseLine(line: string): ActivityEntry | null {
	if (!line.trim()) return null;
	try {
		const v = JSON.parse(line) as Partial<ActivityEntry>;
		return typeof v.id === 'string' && typeof v.ts === 'string' && typeof v.action === 'string' && v.actor && v.target ? (v as ActivityEntry) : null;
	} catch {
		return null;
	}
}

/**
 * Whether an entry passes a query's filters. Times compare as instants, so
 * `…T00:00:00Z` and `…T00:00:00.000Z` are the same moment.
 *
 * @param e - Entry
 * @param q - Query
 * @returns True when it matches
 */
function matches(e: ActivityEntry, q: ActivityQuery): boolean {
	if (q.actorType && e.actor.type !== q.actorType) return false;
	if (q.actorId && e.actor.id !== q.actorId) return false;
	if (q.action && e.action !== q.action && !(q.action.endsWith('.') && e.action.startsWith(q.action))) return false;
	if (q.targetType && e.target.type !== q.targetType) return false;
	if (q.targetId && e.target.id !== q.targetId) return false;
	const ms = Date.parse(e.ts);
	if (q.since && ms < Date.parse(q.since)) return false;
	if (q.until && ms > Date.parse(q.until)) return false;
	return true;
}

let instance: ActivityLogService | null = null;

/**
 * The process-wide activity log.
 *
 * @returns The log (created on first use)
 */
export function getActivityLog(): ActivityLogService {
	if (!instance) instance = new ActivityLogService();
	return instance;
}

/**
 * Replace the process-wide log (tests).
 *
 * @param log - Log, or null to rebuild the default lazily
 */
export function setActivityLogForTesting(log: ActivityLogService | null): void {
	instance = log;
}

/**
 * Append to the process-wide log without ever throwing. The one call writers
 * make.
 *
 * @param input - The entry
 */
export function recordActivity(input: ActivityEntryInput): void {
	try {
		getActivityLog().record(input);
	} catch {
		// A broken log never breaks the action it describes.
	}
}
