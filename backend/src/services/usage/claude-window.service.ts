/**
 * What a Claude subscription has spent inside its rolling windows.
 *
 * The usage ledger answers "what did Crewly's agents cost". It deliberately
 * never attributes the owner's own Claude Code sessions to anyone, so they
 * stay out of it (usage-backfill.service) — yet they draw on the same
 * subscription. When the 5-hour window runs out mid-sprint, the ledger shows
 * nothing unusual, because most of the window went to a session Crewly never
 * started.
 *
 * This module reads the same transcripts for the opposite question: every
 * Claude Code turn on this machine, whoever ran it, bucketed into the windows
 * Anthropic actually bills.
 *
 * **It reports tokens spent, not quota left.** Anthropic publishes no
 * endpoint for the remaining allowance of a Pro/Max plan, and Claude Code
 * records the real window state (`quotaLimits`: utilisation, reset time) only
 * on a request it *rejected*. So the report carries two different kinds of
 * fact, and does not blur them:
 *
 * - `windows[].tokens` — measured, from the transcripts, always available;
 * - `lastLimit` — the vendor's own figure, from the last rejection, which may
 *   be hours old or absent entirely.
 *
 * Together they calibrate each other: a rejection says "this window was full",
 * and the tokens measured in the window that ended there are roughly what the
 * plan holds ({@link estimateWindowCapacity}).
 *
 * Reading is backwards. Transcripts are append-only and chronological, so the
 * reader starts at the end of each file and stops at the first turn older than
 * the window — a 5-hour report touches a few hundred kilobytes of a 676 MB
 * week.
 *
 * @module services/usage/claude-window.service
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { CLAUDE_WINDOW_CONSTANTS as C, type ClaudeWindowId } from '../../constants.js';
import { getClaudeDataDir } from '../harness/claude-config.utils.js';
import { parseTranscriptTurns, type AssistantTurn } from '../monitoring/claude-transcript-sync.service.js';

/** Tokens spent inside one rolling window. */
export interface ClaudeWindowUsage {
	id: ClaudeWindowId;
	label: string;
	/** Start of the window (now − its length) */
	startedAt: string;
	/** Model round-trips counted */
	turns: number;
	/** Fresh input tokens */
	input: number;
	/** Input served from the prompt cache (cheap, but still billed) */
	cachedInput: number;
	/** Tokens written into the prompt cache */
	cacheWrite: number;
	output: number;
	/**
	 * True when a transcript hit the byte cap before this window was fully
	 * covered: the figures below are a floor, not a total.
	 */
	partial: boolean;
	/**
	 * The single number to show. Cache *reads* are excluded: they dominate the
	 * raw count (>99% of tokens on a busy day) while costing a fraction, so a
	 * total that includes them tracks how long a conversation is, not how much
	 * of the plan is gone.
	 */
	billable: number;
}

/** The window state Anthropic itself reported, the last time it refused a request. */
export interface ClaudeLimitEvent {
	/** When the refusal was written to the transcript */
	at: string;
	/** Window that was exhausted, as Anthropic names it (e.g. `five_hour`) */
	rateLimitType: string | null;
	/** When that window reopens */
	resetsAt: string | null;
	/** Per-window utilisation Anthropic reported, 0–1, when present */
	utilization: Partial<Record<string, number>>;
	/** Whether the plan's overage was available at that moment */
	overageStatus: string | null;
}

/** Everything the report knows. */
export interface ClaudeWindowReport {
	measuredAt: string;
	windows: ClaudeWindowUsage[];
	lastLimit: ClaudeLimitEvent | null;
	/** Transcripts opened */
	filesScanned: number;
	/** True when any transcript hit {@link C.MAX_TAIL_BYTES_PER_FILE} */
	truncated: boolean;
	/**
	 * Tokens the 5-hour window held when it was last refused, when both facts
	 * are available — the closest thing to a plan size this data allows.
	 */
	estimatedFiveHourCapacity: number | null;
}

/** Injected for tests. */
export interface ClaudeWindowDeps {
	/** Root of Claude Code's data directory (default: resolved from the environment) */
	dataDir?: string;
	now?: () => Date;
	/**
	 * Windows to measure. The reader walks back as far as the longest one, so
	 * asking for the 7-day window costs orders of magnitude more I/O than the
	 * 5-hour one — hence the default.
	 */
	windows?: readonly ClaudeWindowId[];
}

/**
 * Windows measured when the caller names none.
 *
 * The 5-hour window is the one that stops work, and it is cheap to read; the
 * 7-day window means walking back through a week of transcripts, so it is
 * asked for explicitly.
 */
export const DEFAULT_WINDOWS: readonly ClaudeWindowId[] = ['five_hour'];

/** Billable unit of one turn (see {@link ClaudeWindowUsage.billable}). */
export function turnBillableTokens(turn: AssistantTurn): number {
	return turn.input + turn.output + turn.cacheWrite;
}

/**
 * Pull the window state out of one transcript line.
 *
 * Claude Code writes it in two shapes: a flat `quotaLimits` object, and —
 * when the refusal came back inside a tool result — a JSON string holding a
 * `windows` map with a utilisation per window. Both are read; neither is
 * required.
 *
 * @param line - One line of transcript JSONL
 * @returns The event, or null when the line is not a refusal
 *
 * @example
 * ```ts
 * parseLimitLine('{"timestamp":"2026-10-11T19:00:00Z","quotaLimits":{"rateLimitType":"five_hour","resetsAt":1791745200}}');
 * // → { rateLimitType: 'five_hour', resetsAt: '2026-10-11T19:40:00.000Z', … }
 * ```
 */
export function parseLimitLine(line: string): ClaudeLimitEvent | null {
	// `windows` is matched unquoted on purpose: in the shape that carries the
	// utilisation the JSON is escaped inside a string, so the quotes around the
	// key are backslashed and a quoted test never fires.
	if (!line.includes('quotaLimits') && !line.includes('rate_limit_info') && !line.includes('windows')) return null;

	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}

	const quota = (entry.quotaLimits ?? (entry.apiErrorParams as Record<string, unknown> | undefined)?.rate_limit_info) as
		| Record<string, unknown>
		| undefined;

	const utilization: Record<string, number> = {};
	for (const [id, window] of Object.entries(findWindowsMap(line))) {
		if (typeof window.utilization === 'number') utilization[id] = window.utilization;
	}

	if (!quota && Object.keys(utilization).length === 0) return null;

	return {
		at: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
		rateLimitType: typeof quota?.rateLimitType === 'string' ? quota.rateLimitType : null,
		resetsAt: epochToIso(quota?.resetsAt),
		utilization,
		overageStatus: typeof quota?.overageStatus === 'string' ? quota.overageStatus : null,
	};
}

/** A window entry inside the nested `windows` map. */
interface RawWindow {
	utilization?: number;
	resets_at?: number;
}

/**
 * Find the `windows` map wherever Claude Code buried it.
 *
 * The refusal that carries utilisation arrives as an error *message*, so the
 * JSON is escaped inside a string field rather than part of the entry's own
 * object graph. Walking the parsed object would miss it; a scan of the raw
 * line finds it in both shapes.
 *
 * @param line - Raw transcript line
 * @returns Window id → figures, empty when the line carries none
 */
export function findWindowsMap(line: string): Record<string, RawWindow> {
	const match = line.match(/\\?"windows\\?"\s*:\s*(\{.*?\}\s*\})/);
	if (!match) return {};
	try {
		const parsed = JSON.parse(match[1].replace(/\\"/g, '"')) as Record<string, RawWindow>;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Seconds since the epoch → ISO, when the value is a usable number.
 *
 * @param value - Candidate
 * @returns ISO timestamp, or null
 */
function epochToIso(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return new Date(value * 1000).toISOString();
}

/**
 * Every transcript worth opening, newest first.
 *
 * @param dataDir - Claude Code's data directory
 * @param now - Current time
 * @returns Absolute paths, newest modification first
 */
export async function listRecentTranscripts(dataDir: string, now: Date): Promise<string[]> {
	const root = path.join(dataDir, 'projects');
	let entries: string[];
	try {
		entries = await walkJsonl(root);
	} catch {
		return [];
	}

	const cutoff = now.getTime() - C.MAX_FILE_AGE_HOURS * 60 * 60 * 1000;
	const withTimes: { file: string; mtime: number }[] = [];
	for (const file of entries) {
		try {
			const stat = await fs.stat(file);
			if (stat.mtimeMs >= cutoff) withTimes.push({ file, mtime: stat.mtimeMs });
		} catch {
			// a transcript deleted between listing and stat is simply not counted
		}
	}
	return withTimes.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file);
}

/**
 * Collect `*.jsonl` under a directory tree.
 *
 * @param dir - Root
 * @returns Absolute file paths
 */
async function walkJsonl(dir: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walkJsonl(full).catch(() => [])));
		else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
	}
	return found;
}

/** What one transcript contributed. */
export interface TranscriptSlice {
	turns: AssistantTurn[];
	limit: ClaudeLimitEvent | null;
	/** The read stopped on the byte cap rather than on an old turn */
	truncated: boolean;
	/**
	 * Timestamp of the earliest line this read reached. With `truncated`, it
	 * is how far back the file is covered — anything before it is unread, so a
	 * window starting earlier cannot be reported as a total.
	 */
	oldestCovered: string | null;
}

/**
 * Read one transcript backwards, stopping once it is older than `since`.
 *
 * @param file - Transcript path
 * @param since - Oldest moment of interest
 * @param seen - Message ids already counted across files
 * @returns Turns inside the window (file order) and the newest refusal seen
 *
 * @throws Never — an unreadable transcript yields an empty slice
 */
export async function readTranscriptTail(file: string, since: Date, seen: Set<string>): Promise<TranscriptSlice> {
	let handle;
	try {
		handle = await fs.open(file, 'r');
	} catch {
		return { turns: [], limit: null, truncated: false, oldestCovered: null };
	}

	try {
		const { size } = await handle.stat();
		let position = size;
		let carry = '';
		let read = 0;
		let truncated = false;
		const lines: string[] = [];

		while (position > 0) {
			if (read >= C.MAX_TAIL_BYTES_PER_FILE) {
				truncated = true;
				break;
			}
			const length = Math.min(C.TAIL_CHUNK_BYTES, position);
			position -= length;
			read += length;

			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, position);
			const chunk = buffer.toString('utf-8') + carry;

			const parts = chunk.split('\n');
			// The first part may be half a line: the rest of it sits in the
			// chunk before this one, so it waits there until that chunk is read.
			carry = position > 0 ? (parts.shift() ?? '') : '';

			let reachedOldTurn = false;
			for (let i = parts.length - 1; i >= 0; i--) {
				const line = parts[i];
				if (!line.trim()) continue;
				lines.unshift(line);
				if (isOlderThan(line, since)) {
					reachedOldTurn = true;
					break;
				}
			}
			if (reachedOldTurn) break;
		}

		const text = lines.join('\n');
		const turns = parseTranscriptTurns(text, seen).filter((turn) => new Date(turn.timestamp).getTime() >= since.getTime());

		let limit: ClaudeLimitEvent | null = null;
		for (let i = lines.length - 1; i >= 0 && !limit; i--) limit = parseLimitLine(lines[i]);

		return { turns, limit, truncated, oldestCovered: firstTimestamp(lines) };
	} catch {
		return { turns: [], limit: null, truncated: false, oldestCovered: null };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Timestamp of the first line that carries one.
 *
 * @param lines - Lines in file order
 * @returns ISO timestamp, or null when no line is dated
 */
function firstTimestamp(lines: string[]): string | null {
	for (const line of lines) {
		const match = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
		if (match) return match[1];
	}
	return null;
}

/**
 * Whether a transcript line is dated before `since`.
 *
 * @param line - Raw JSONL line
 * @param since - Boundary
 * @returns True when the line carries an older timestamp
 */
function isOlderThan(line: string, since: Date): boolean {
	const match = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
	if (!match) return false;
	const at = new Date(match[1]).getTime();
	return Number.isFinite(at) && at < since.getTime();
}

/**
 * The most recent refusal on this machine, from a short tail of each transcript.
 *
 * Separate from the window measurement because the two want different spans:
 * the windows are a few hours, while "when did I last run out" is usually
 * older than that. Reading {@link C.LIMIT_SCAN_TAIL_BYTES} from each recent
 * transcript costs a few megabytes rather than a week of them.
 *
 * @param files - Transcripts, newest first
 * @returns The newest refusal found, or null
 */
export async function findLastLimit(files: readonly string[]): Promise<ClaudeLimitEvent | null> {
	let newest: ClaudeLimitEvent | null = null;

	for (const file of files) {
		let handle;
		try {
			handle = await fs.open(file, 'r');
		} catch {
			continue;
		}
		try {
			const { size } = await handle.stat();
			const length = Math.min(C.LIMIT_SCAN_TAIL_BYTES, size);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			const lines = buffer.toString('utf-8').split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				const event = parseLimitLine(lines[i]);
				if (event && (!newest || new Date(event.at) > new Date(newest.at))) {
					newest = event;
					break;
				}
			}
		} catch {
			// an unreadable transcript simply contributes nothing
		} finally {
			await handle.close().catch(() => undefined);
		}
	}

	return newest;
}

/**
 * Tokens the 5-hour window was holding when Anthropic last refused a request.
 *
 * Only meaningful when the refusal is recent enough that its window overlaps
 * the one just measured; otherwise the measurement describes a different
 * window and the two must not be divided into each other.
 *
 * @param windows - Measured windows
 * @param limit - Last refusal
 * @returns Estimated capacity in billable tokens, or null when it cannot be told
 *
 * @example
 * ```ts
 * estimateWindowCapacity([{ id: 'five_hour', billable: 120_000, … }], { utilization: { '5h': 0.99 }, … }); // 121_212
 * ```
 */
export function estimateWindowCapacity(windows: ClaudeWindowUsage[], limit: ClaudeLimitEvent | null): number | null {
	if (!limit) return null;
	const fiveHour = windows.find((window) => window.id === 'five_hour');
	if (!fiveHour || fiveHour.billable <= 0) return null;

	const used = limit.utilization['5h'] ?? limit.utilization.five_hour;
	if (typeof used !== 'number' || used <= 0) return null;

	// The refusal has to fall inside the window that was just measured, or the
	// tokens counted belong to a different one.
	if (new Date(limit.at).getTime() < new Date(fiveHour.startedAt).getTime()) return null;

	return Math.round(fiveHour.billable / used);
}

/**
 * Measure every rolling window of the Claude subscription on this machine.
 *
 * @param deps - Data directory and clock (tests inject both)
 * @returns Tokens per window, the last refusal Anthropic sent, and how much was read
 *
 * @example
 * ```ts
 * const report = await buildClaudeWindowReport();
 * report.windows[0].billable; // tokens spent in the last 5 hours
 * ```
 */
export async function buildClaudeWindowReport(deps: ClaudeWindowDeps = {}): Promise<ClaudeWindowReport> {
	const now = deps.now?.() ?? new Date();
	const dataDir = deps.dataDir ?? getClaudeDataDir();
	const wanted = deps.windows ?? DEFAULT_WINDOWS;
	const definitions = C.WINDOWS.filter((window) => wanted.includes(window.id));

	const longest = Math.max(...definitions.map((window) => window.hours));
	const since = new Date(now.getTime() - longest * 60 * 60 * 1000);

	const files = await listRecentTranscripts(dataDir, now);
	const seen = new Set<string>();
	const turns: AssistantTurn[] = [];
	let lastLimit: ClaudeLimitEvent | null = null;
	let truncated = false;
	// The newest point a truncated read stopped at: everything before it is
	// unread in at least one transcript.
	let unreadBefore: number | null = null;

	for (const file of files) {
		const slice = await readTranscriptTail(file, since, seen);
		turns.push(...slice.turns);
		if (slice.truncated) {
			truncated = true;
			const covered = slice.oldestCovered ? new Date(slice.oldestCovered).getTime() : now.getTime();
			unreadBefore = unreadBefore === null ? covered : Math.max(unreadBefore, covered);
		}
		if (slice.limit && (!lastLimit || new Date(slice.limit.at) > new Date(lastLimit.at))) lastLimit = slice.limit;
	}

	// A refusal older than every measured window still answers "when did I
	// last run out", so it is looked for separately.
	const tailLimit = await findLastLimit(files);
	if (tailLimit && (!lastLimit || new Date(tailLimit.at) > new Date(lastLimit.at))) lastLimit = tailLimit;

	const windows = definitions.map((definition) => {
		const startedAt = new Date(now.getTime() - definition.hours * 60 * 60 * 1000);
		const inWindow = turns.filter((turn) => new Date(turn.timestamp).getTime() >= startedAt.getTime());
		return {
			id: definition.id,
			label: definition.label,
			startedAt: startedAt.toISOString(),
			partial: unreadBefore !== null && unreadBefore > startedAt.getTime(),
			turns: inWindow.length,
			input: sum(inWindow, (turn) => turn.input),
			cachedInput: sum(inWindow, (turn) => turn.cacheRead),
			cacheWrite: sum(inWindow, (turn) => turn.cacheWrite),
			output: sum(inWindow, (turn) => turn.output),
			billable: sum(inWindow, turnBillableTokens),
		};
	});

	return {
		measuredAt: now.toISOString(),
		windows,
		lastLimit,
		filesScanned: files.length,
		truncated,
		estimatedFiveHourCapacity: estimateWindowCapacity(windows, lastLimit),
	};
}

/**
 * Sum a field over turns.
 *
 * @param turns - Turns
 * @param pick - Field accessor
 * @returns Total
 */
function sum(turns: AssistantTurn[], pick: (turn: AssistantTurn) => number): number {
	return turns.reduce((total, turn) => total + pick(turn), 0);
}
