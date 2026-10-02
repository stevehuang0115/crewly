/**
 * Claude Transcript Sync Service
 *
 * Keeps the Usage dashboard honest for `claude-code` agents by reading the
 * exact per-turn `usage` block that Claude Code writes into its own session
 * transcript, and feeding it into {@link TokenUsageService}.
 *
 * This replaces a boot-time sync that never recorded anything. That version
 * had four defects, each of which this module exists to avoid:
 *
 * 1. It derived the transcript directory from `CREWLY_HOME`, but agents run
 *    with their project as the working directory, so it always read an empty
 *    or absent folder. We take each session's real `cwd` from
 *    {@link SessionStatePersistence} instead.
 * 2. It ran once at startup, so nothing an agent did afterwards was counted.
 *    We poll on an interval and read only the bytes appended since last time.
 * 3. It keyed records on the Claude conversation UUID and re-added the whole
 *    running total on every call, so a restart double-counted the entire
 *    history. We key on the Crewly session name and keep a byte cursor plus a
 *    recent-message-id set so a turn is counted exactly once.
 * 4. Its price table stopped at an older model generation, so current models
 *    silently fell through to the sonnet default. Pricing now lives in
 *    {@link module:services/monitoring/model-pricing} and reports whether a
 *    rate was an exact match.
 *
 * A session that runs on another of the owner's Claude Code accounts
 * (issue #942, `claude-code@<name>`) writes its transcripts under that
 * account's config dir, not `~/.claude`. Both are searched, the account's
 * first, so its turns count toward its daily token cap. When a session moves
 * to another transcript (an account switch, a new conversation), the unread
 * tail of the one it leaves is counted first and its offset is remembered,
 * so returning to it later never counts a turn twice.
 *
 * As a side effect the sync knows each agent's true context size — the sum of
 * fresh, cached and cache-written input on its most recent turn — which is the
 * only reliable source for it, since Claude Code's TUI context readout is not
 * capturable from PTY scrollback. That number is handed to an observer so the
 * context-window monitor can act on real figures.
 *
 * @module services/monitoring/claude-transcript-sync
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getSessionStatePersistence } from '../session/session-state-persistence.js';
import { TokenUsageService } from './token-usage.service.js';
import { calculateCost } from './model-pricing.js';
import { CLAUDE_TRANSCRIPT_SYNC_CONSTANTS } from '../../constants.js';
import { findLatestSessionFile, findSessionJsonlPath } from './claude-session-tokens.service.js';
import { effectiveClaudeAccount } from '../runtime-fallback/effective-runtime.js';
import { claudeAccountConfigDir } from '../harness/claude-accounts.js';

/**
 * How far a single session's transcript has been consumed.
 *
 * Persisted so a backend restart resumes where it left off instead of
 * re-counting a transcript that may hold hundreds of dollars of history.
 */
export interface TranscriptCursor {
	/** Absolute path of the transcript this cursor belongs to */
	filePath: string;
	/** Byte offset already consumed */
	offset: number;
	/**
	 * Offsets reached in this session's earlier transcripts, by path.
	 *
	 * A session that switches between the owner's Claude Code accounts (or
	 * between conversations) can come back to a transcript it already read.
	 * Resuming at the remembered offset, instead of 0, keeps every turn
	 * counted once. Bounded to `MAX_REMEMBERED_TRANSCRIPTS` entries.
	 */
	fileOffsets?: Record<string, number>;
	/**
	 * Ids of the most recently counted assistant messages.
	 *
	 * Claude Code can rewrite a line for the same `message.id` (for instance
	 * when a turn is streamed and then finalised), so an offset alone is not
	 * enough to guarantee exactly-once counting. Bounded to
	 * `MAX_DEDUPE_IDS` entries.
	 */
	seenMessageIds: string[];
	/** Cumulative USD cost attributed to this session so far */
	cost: number;
	/**
	 * Context size of the last turn we parsed, in tokens.
	 *
	 * Re-emitted on every pass, not only on passes that found new turns.
	 * An idle agent produces no turns, but it is still holding that context
	 * and will drag it through its next one — and the context monitor may not
	 * have started watching the session yet when the first reading was taken,
	 * since session restore is staggered over a minute or so after boot.
	 */
	lastContextTokens?: number;
	/**
	 * `2` once `cost` has been recomputed from this cursor's own transcript.
	 *
	 * Before the shared-cwd guard (2026-09-22), several agents' cursors were
	 * pointed at one foreign transcript and each accumulated its whole cost —
	 * Atlas and Max each showed ~$300. Cursors without this mark are recounted
	 * once on load.
	 */
	costBasis?: 2;
}

/** One agent's context size, as measured from its latest transcript turn. */
export interface ContextReading {
	/** Crewly session name (e.g. `think-tank-atlas-b4e166f6`) */
	sessionName: string;
	/** Fresh + cache-read + cache-written input tokens on the latest turn */
	contextTokens: number;
	/** Model id that produced the turn */
	model: string;
}

/** Callback invoked once per sync for every session with a fresh reading. */
export type ContextObserver = (reading: ContextReading) => void;

/** What one sync pass did, returned for logging and tests. */
export interface SyncResult {
	/** Sessions that had at least one new turn */
	sessionsUpdated: number;
	/** New assistant turns counted across all sessions */
	turnsCounted: number;
	/** USD attributed in this pass */
	costAdded: number;
	/** Sessions skipped because no transcript could be located */
	sessionsWithoutTranscript: number;
}

/** What reading one transcript's unread tail found. */
interface ConsumeResult {
	turns: number;
	cost: number;
	/** The newest turn read, for the context reading */
	latest: AssistantTurn | null;
}

/** Shape of one assistant entry we care about in the transcript. */
interface AssistantTurn {
	messageId: string;
	timestamp: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Reads Claude Code transcripts on an interval and records exact token usage.
 *
 * @example
 * ```typescript
 * const sync = ClaudeTranscriptSyncService.getInstance();
 * sync.onContextReading((r) => monitor.updateContextTokens(r.sessionName, r.contextTokens));
 * await sync.start();
 * ```
 */
export class ClaudeTranscriptSyncService {
	private static instance: ClaudeTranscriptSyncService | null = null;

	private readonly logger: ComponentLogger;
	private readonly cursorFile: string;
	/**
	 * Home directory that `~/.claude/projects` is resolved against.
	 *
	 * Injectable because `os.homedir()` does not reliably follow a `$HOME`
	 * override once the process has already resolved it, which makes it
	 * untestable against a temp tree.
	 */
	private readonly homeDir: string;
	/** Config dir of one of the owner's other Claude Code accounts (issue #942) */
	private readonly accountConfigDir: (account: string) => string;
	private cursors: Map<string, TranscriptCursor> = new Map();
	private timer: ReturnType<typeof setInterval> | null = null;
	private observers: ContextObserver[] = [];
	private loaded = false;
	/** Guards against a slow pass overlapping the next tick. */
	private running = false;

	/**
	 * @param cursorFile - Override the cursor persistence path (tests)
	 * @param homeDir - Override the home directory transcripts live under (tests)
	 * @param accountConfigDir - Override where an account's config dir is (tests)
	 */
	constructor(cursorFile?: string, homeDir?: string, accountConfigDir?: (account: string) => string) {
		this.logger = LoggerService.getInstance().createComponentLogger('ClaudeTranscriptSync');
		this.homeDir = homeDir ?? os.homedir();
		this.accountConfigDir = accountConfigDir ?? ((account) => claudeAccountConfigDir(account));
		this.cursorFile =
			cursorFile ?? path.join(this.homeDir, '.crewly', CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.CURSOR_FILE);
	}

	/**
	 * Get the shared instance.
	 *
	 * @returns The singleton service
	 */
	static getInstance(): ClaudeTranscriptSyncService {
		if (!ClaudeTranscriptSyncService.instance) {
			ClaudeTranscriptSyncService.instance = new ClaudeTranscriptSyncService();
		}
		return ClaudeTranscriptSyncService.instance;
	}

	/** Drops the singleton and stops its timer (tests). */
	static resetInstance(): void {
		ClaudeTranscriptSyncService.instance?.stop();
		ClaudeTranscriptSyncService.instance = null;
	}

	/**
	 * Register a callback to receive each session's context size per pass.
	 *
	 * @param observer - Invoked once per session that produced a new turn
	 */
	onContextReading(observer: ContextObserver): void {
		this.observers.push(observer);
	}

	/**
	 * Load cursors, run one pass immediately, then poll.
	 *
	 * Safe to call twice; the second call is a no-op.
	 */
	async start(): Promise<void> {
		if (this.timer) return;
		await this.loadCursors();
		await this.sync();
		this.timer = setInterval(() => {
			void this.sync();
		}, CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.SYNC_INTERVAL_MS);
		// Never hold the event loop open for a metrics poll.
		this.timer.unref?.();
		this.logger.info('Claude transcript sync started', {
			intervalMs: CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.SYNC_INTERVAL_MS,
			cursorFile: this.cursorFile,
		});
	}

	/** Stops polling. Cursors already on disk are left alone. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Run one sync pass across every registered claude-code session.
	 *
	 * Overlapping calls are dropped rather than queued — a pass that outruns
	 * the interval means the machine is busy, and piling up reads of
	 * multi-megabyte transcripts would make that worse.
	 *
	 * @returns What the pass counted
	 */
	async sync(): Promise<SyncResult> {
		const result: SyncResult = {
			sessionsUpdated: 0,
			turnsCounted: 0,
			costAdded: 0,
			sessionsWithoutTranscript: 0,
		};
		if (this.running) return result;
		this.running = true;

		try {
			if (!this.loaded) await this.loadCursors();

			const sessions = getSessionStatePersistence().getRegisteredSessionsMap();

			// Several agents commonly work in one repo. Count them up front so
			// transcript resolution knows when a directory cannot identify a
			// single agent.
			const perCwd = new Map<string, number>();
			// Conversation id → session, so a transcript another session now
			// owns is never drained into this one's spend.
			const ownerOfConversation = new Map<string, string>();
			for (const [name, info] of sessions) {
				if (info.runtimeType !== 'claude-code' || !info.cwd) continue;
				perCwd.set(info.cwd, (perCwd.get(info.cwd) ?? 0) + 1);
				if (info.claudeSessionId) ownerOfConversation.set(info.claudeSessionId, name);
			}

			for (const [sessionName, info] of sessions) {
				// Only Claude Code writes the transcripts this service reads.
				if (info.runtimeType !== 'claude-code') continue;
				if (!info.cwd) continue;

				const filePath = await this.resolveTranscript(
					info.cwd,
					info.claudeSessionId,
					(perCwd.get(info.cwd) ?? 0) > 1,
					this.accountConfigDirsOf(sessionName),
				);
				if (!filePath) {
					result.sessionsWithoutTranscript += 1;
					continue;
				}

				const counted = await this.syncOne(sessionName, filePath, (id) => {
					const owner = ownerOfConversation.get(id);
					return owner !== undefined && owner !== sessionName;
				});
				if (counted.turns > 0) {
					result.sessionsUpdated += 1;
					result.turnsCounted += counted.turns;
					result.costAdded += counted.cost;
				} else {
					const cursor = this.cursors.get(sessionName);

					// No new turns, but the agent is still carrying whatever it
					// was carrying. Re-announce it so a monitor that started
					// after the first reading still learns the figure.
					if (cursor?.lastContextTokens !== undefined) {
						this.emitContext({ sessionName, contextTokens: cursor.lastContextTokens, model: '' });
					}

					// Re-assert the cache-aware cost too. The override lives in
					// memory only, so after a restart an agent that has not
					// taken a turn since would fall back to a cost computed
					// without the cache split — which for a long-lived agent is
					// wrong by an order of magnitude, in whichever direction the
					// cache/output ratio happens to fall.
					if (cursor && cursor.cost > 0) {
						TokenUsageService.getInstance().overrideSessionCost(sessionName, cursor.cost);
					}
				}
			}

			if (result.sessionsUpdated > 0) {
				await this.saveCursors();
				this.logger.info('Synced Claude transcripts', result);
			}
		} catch (err) {
			// A metrics poll must never take the server down.
			this.logger.warn('Claude transcript sync pass failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.running = false;
		}

		return result;
	}

	/**
	 * Claude config dirs to search for a session besides `~/.claude`: the
	 * config dir of the owner's other Claude Code account it runs on, if any.
	 *
	 * @param sessionName - Crewly session name
	 * @returns `[accountConfigDir]` while on `claude-code@<name>`, else `[]`
	 */
	private accountConfigDirsOf(sessionName: string): string[] {
		const account = effectiveClaudeAccount(sessionName);
		if (!account) return [];
		try {
			return [this.accountConfigDir(account)];
		} catch {
			return [];
		}
	}

	/**
	 * Locate a session's transcript file.
	 *
	 * Prefers the conversation id Crewly recorded when it launched the agent.
	 * Falls back to the newest transcript in the project's slug directory,
	 * which covers an agent whose id has not been captured yet.
	 *
	 * @param cwd - The agent's working directory
	 * @param claudeSessionId - Conversation id, when known
	 * @param cwdIsShared - Whether another registered session works in the
	 *                      same directory, which makes newest-wins unsafe
	 * @param configDirs - Config dirs of the owner's other Claude Code account
	 *                     the session runs on (searched before `~/.claude`)
	 * @returns Absolute path, or null when nothing readable exists
	 */
	private async resolveTranscript(
		cwd: string,
		claudeSessionId: string | undefined,
		cwdIsShared: boolean,
		configDirs: readonly string[] = [],
	): Promise<string | null> {
		// Claude Code files transcripts under the *resolved* cwd, so a cwd that
		// goes through a symlink (/tmp on macOS) lands in a different slug
		// directory than the raw path suggests (#938). Both lookups below check
		// the realpath slug first, then the raw slug.
		if (claudeSessionId) {
			const direct = await findSessionJsonlPath(cwd, claudeSessionId, this.homeDir, configDirs);
			if (direct) return direct;
			// Recorded id has no file — fall through to newest-wins.
		}

		// Newest transcript in the project directory. Covers an agent whose
		// conversation id Crewly has not captured yet.
		//
		// Only safe when this agent is the sole one working in this directory.
		// Several agents in one repo share a slug directory, so newest-wins
		// would hand all of them the same transcript and attribute one busy
		// agent's turns — and its context size — to every one of its
		// colleagues. Observed exactly that: four agents each reported the
		// same 726,475 tokens, which was one agent's figure. Waiting for the
		// conversation id costs a little early data; guessing costs the
		// dashboard its meaning.
		if (cwdIsShared) return null;

		return findLatestSessionFile(cwd, this.homeDir, configDirs);
	}

	/**
	 * Consume the unread tail of one transcript and record what it holds.
	 *
	 * When the session's transcript changed since the last pass (a new
	 * conversation, or a move to another of the owner's Claude Code accounts,
	 * whose transcripts live in that account's config dir), the transcript it
	 * leaves is read to its end first — turns written there just before the
	 * move would otherwise never be counted — unless another session now owns
	 * that conversation. Its offset is remembered, and the new transcript
	 * resumes at its own remembered offset (0 when new). Message ids seen are
	 * kept across transcripts, so a turn is counted once whichever file it is
	 * read from.
	 *
	 * @param sessionName - Crewly session name, used as the usage key
	 * @param filePath - Transcript to read
	 * @param ownedByOther - Whether a conversation id belongs to another session
	 * @returns Turns counted and cost added for this session
	 */
	private async syncOne(
		sessionName: string,
		filePath: string,
		ownedByOther: (conversationId: string) => boolean = () => false,
	): Promise<{ turns: number; cost: number }> {
		let cursor = this.cursors.get(sessionName);
		if (!cursor) {
			cursor = { filePath, offset: 0, seenMessageIds: [], cost: 0, costBasis: 2 };
			this.cursors.set(sessionName, cursor);
		}

		let turns = 0;
		let costAdded = 0;
		let latest: AssistantTurn | null = null;

		if (cursor.filePath !== filePath) {
			const left = cursor.filePath;
			if (!ownedByOther(path.basename(left, '.jsonl'))) {
				const drained = await this.consume(sessionName, cursor);
				turns += drained.turns;
				costAdded += drained.cost;
			}
			const offsets = { ...(cursor.fileOffsets ?? {}) };
			delete offsets[left];
			offsets[left] = cursor.offset;
			const resumeAt = offsets[filePath] ?? 0;
			delete offsets[filePath];
			const kept = Object.entries(offsets).slice(-CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.MAX_REMEMBERED_TRANSCRIPTS);
			cursor.filePath = filePath;
			cursor.offset = resumeAt;
			cursor.fileOffsets = Object.fromEntries(kept);
		}

		const read = await this.consume(sessionName, cursor);
		turns += read.turns;
		costAdded += read.cost;
		latest = read.latest;

		if (turns === 0) return { turns: 0, cost: 0 };

		cursor.cost += costAdded;
		TokenUsageService.getInstance().overrideSessionCost(sessionName, cursor.cost);

		if (latest) {
			const contextTokens = latest.input + latest.cacheRead + latest.cacheWrite;
			cursor.lastContextTokens = contextTokens;
			this.emitContext({ sessionName, contextTokens, model: latest.model });
		}

		return { turns, cost: costAdded };
	}

	/**
	 * Read `cursor.filePath` from `cursor.offset` to its last whole line,
	 * record each new turn in the token ledger and advance the cursor.
	 *
	 * Does not touch `cursor.cost`; the caller adds the returned cost.
	 *
	 * @param sessionName - Crewly session name, used as the usage key
	 * @param cursor - The session's cursor (mutated: offset, seen ids)
	 * @returns Turns recorded, their cost and the newest of them
	 */
	private async consume(sessionName: string, cursor: TranscriptCursor): Promise<ConsumeResult> {
		const none: ConsumeResult = { turns: 0, cost: 0, latest: null };
		const filePath = cursor.filePath;

		let size: number;
		try {
			size = (await fs.stat(filePath)).size;
		} catch {
			return none;
		}

		// Truncated or rotated underneath us — re-read from the top rather
		// than seeking past the end and silently counting nothing forever.
		// The seen ids are kept: a turn still in the file is not new.
		if (size < cursor.offset) cursor.offset = 0;
		if (size === cursor.offset) return none;

		const tail = await this.readFrom(filePath, cursor.offset, size);
		// Only advance past whole lines; a partial trailing line is re-read next pass.
		const lastNewline = tail.lastIndexOf('\n');
		if (lastNewline < 0) return none;
		const complete = tail.slice(0, lastNewline);
		const consumedBytes = Buffer.byteLength(complete, 'utf-8') + 1;

		const seen = new Set(cursor.seenMessageIds);
		const turns = this.parseTurns(complete, seen);

		cursor.offset += consumedBytes;

		if (turns.length === 0) return none;

		const tokenSvc = TokenUsageService.getInstance();
		let costAdded = 0;
		let latest: AssistantTurn | null = null;

		for (const turn of turns) {
			const { cost } = calculateCost(
				{ input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite },
				turn.model,
			);
			costAdded += cost;

			// `input` stays the fresh-token count so the dashboard's input
			// column means what it says; cached tokens ride along in `detail`
			// and are what make the cost figure meaningful.
			tokenSvc.recordUsage(sessionName, sessionName, turn.input, turn.output, turn.model, undefined, {
				cachedInput: turn.cacheRead + turn.cacheWrite,
				cacheWrite: turn.cacheWrite,
				timestamp: turn.timestamp,
			});

			seen.add(turn.messageId);
			latest = turn;
		}

		// Keep the dedupe set bounded — only the newest ids can collide with
		// a line Claude Code rewrites.
		cursor.seenMessageIds = Array.from(seen).slice(-CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.MAX_DEDUPE_IDS);

		return { turns: turns.length, cost: costAdded, latest };
	}

	/**
	 * Read a byte range of a file as UTF-8.
	 *
	 * Reads only the new tail; these transcripts reach tens of megabytes and
	 * loading one whole on every poll is what makes a naive version of this
	 * service more expensive than the usage it measures.
	 *
	 * @param filePath - File to read
	 * @param start - First byte to read
	 * @param end - Exclusive end byte
	 * @returns The decoded slice
	 */
	private async readFrom(filePath: string, start: number, end: number): Promise<string> {
		const handle = await fs.open(filePath, 'r');
		try {
			const length = end - start;
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, start);
			return buf.toString('utf-8');
		} finally {
			await handle.close();
		}
	}

	/**
	 * Extract the assistant turns from a slice of transcript.
	 *
	 * @param text - Whole lines of JSONL
	 * @param seen - Message ids already counted; matches are skipped
	 * @returns Turns in file order
	 */
	private parseTurns(text: string, seen: Set<string>): AssistantTurn[] {
		const turns: AssistantTurn[] = [];

		for (const line of text.split('\n')) {
			if (!line.trim()) continue;

			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== 'assistant') continue;

			const msg = entry.message as Record<string, unknown> | undefined;
			const usage = msg?.usage as Record<string, number> | undefined;
			if (!msg || !usage) continue;

			const input = usage.input_tokens || 0;
			const output = usage.output_tokens || 0;
			const cacheRead = usage.cache_read_input_tokens || 0;
			const cacheWrite = usage.cache_creation_input_tokens || 0;

			// Claude Code writes `<synthetic>` entries — cancellations, tool
			// bookkeeping — with an all-zero usage block. They are not model
			// round-trips. Counting them inflates the turn count, and worse,
			// one landing last makes the agent look like it is carrying no
			// context at all: Atlas sat behind three of them reporting 0
			// while actually holding 726k tokens.
			if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;

			const messageId = (msg.id as string) || `${entry.timestamp as string}`;
			if (seen.has(messageId)) continue;
			seen.add(messageId);

			turns.push({
				messageId,
				timestamp: (entry.timestamp as string) || new Date().toISOString(),
				model: (msg.model as string) || '',
				input,
				output,
				cacheRead,
				cacheWrite,
			});
		}

		return turns;
	}

	/**
	 * Hand a context reading to every observer, isolating their failures.
	 *
	 * @param reading - The measurement to publish
	 */
	private emitContext(reading: ContextReading): void {
		for (const observer of this.observers) {
			try {
				observer(reading);
			} catch (err) {
				this.logger.warn('Context observer threw', {
					sessionName: reading.sessionName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/** Reads persisted cursors; a missing or corrupt file starts fresh. */
	private async loadCursors(): Promise<void> {
		this.loaded = true;
		try {
			const raw = await fs.readFile(this.cursorFile, 'utf-8');
			const parsed = JSON.parse(raw) as Record<string, TranscriptCursor>;
			this.cursors = new Map(Object.entries(parsed));
			this.logger.debug('Loaded transcript cursors', { sessions: this.cursors.size });
			await this.recountLegacyCosts();
		} catch {
			this.cursors = new Map();
		}
	}

	/**
	 * Recount, once, the cost of every cursor written before the shared-cwd
	 * guard, from its own transcript alone.
	 *
	 * Only the current transcript is counted, so an agent that was given a
	 * fresh conversation at some point loses the cost of the earlier one. That
	 * is the honest direction to be wrong in: the old figure included other
	 * agents' spending.
	 */
	private async recountLegacyCosts(): Promise<void> {
		let changed = false;
		for (const [sessionName, cursor] of this.cursors) {
			if (cursor.costBasis === 2) continue;
			let text: string;
			try {
				text = await fs.readFile(cursor.filePath, 'utf-8');
			} catch {
				continue;
			}
			// Count whole lines only, exactly as syncOne() does; a partial
			// trailing line is left for the next sync to read.
			const lastNewline = text.lastIndexOf('\n');
			const complete = lastNewline < 0 ? '' : text.slice(0, lastNewline);
			const seen = new Set<string>();
			let cost = 0;
			for (const turn of this.parseTurns(complete, seen)) {
				cost += calculateCost(
					{ input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite },
					turn.model,
				).cost;
			}
			if (Math.abs(cost - cursor.cost) > 0.01) {
				this.logger.info('Recounted session cost from its own transcript', {
					sessionName,
					was: Math.round(cursor.cost * 100) / 100,
					now: Math.round(cost * 100) / 100,
				});
			}
			cursor.cost = cost;
			cursor.costBasis = 2;
			// Move the cursor to the end of what was just counted (#972). The
			// legacy offset often belonged to another agent's transcript; left
			// past the end of this file, the next sync would take it for a
			// truncation, re-read from the top and count every turn again.
			cursor.offset = lastNewline < 0 ? 0 : Buffer.byteLength(complete, 'utf-8') + 1;
			cursor.seenMessageIds = Array.from(seen).slice(-CLAUDE_TRANSCRIPT_SYNC_CONSTANTS.MAX_DEDUPE_IDS);
			changed = true;
		}
		if (changed) await this.saveCursors();
	}

	/** Writes cursors atomically so a crash mid-write cannot corrupt them. */
	private async saveCursors(): Promise<void> {
		const obj: Record<string, TranscriptCursor> = {};
		for (const [k, v] of this.cursors) obj[k] = v;
		const tmp = `${this.cursorFile}.tmp`;
		try {
			await fs.mkdir(path.dirname(this.cursorFile), { recursive: true });
			await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
			await fs.rename(tmp, this.cursorFile);
		} catch (err) {
			this.logger.warn('Failed to persist transcript cursors', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Current cursor for a session (tests and diagnostics).
	 *
	 * @param sessionName - Crewly session name
	 * @returns The cursor, or undefined if the session has never synced
	 */
	getCursor(sessionName: string): TranscriptCursor | undefined {
		return this.cursors.get(sessionName);
	}
}

/**
 * Convenience accessor for the shared sync service.
 *
 * @returns The singleton instance
 */
export function getClaudeTranscriptSync(): ClaudeTranscriptSyncService {
	return ClaudeTranscriptSyncService.getInstance();
}
