/**
 * Claude Code transcript → turn state.
 *
 * Reads the end of a Claude Code conversation transcript (JSONL) and says
 * whether the agent is mid-turn, done with its turn, or done but with
 * background work (a subagent or a `run_in_background` shell) that will start
 * another turn when it finishes. Fallback for the hook-fed turn state
 * (specs/2026-10-02-restart-busy-and-resume.md).
 *
 * Completion notices (`<task-notification>…<tool-use-id>X</tool-use-id>`)
 * reach the transcript in three shapes, and all three count: a `user`
 * message, a `queue-operation` entry's `content`, and a `queued_command`
 * `attachment`'s `prompt`. Reading only the first left about half of all
 * transcripts ending in a false "background" (PR #1013 review).
 *
 * Launches older than the current runtime (`launchedAfter`) are ignored: a
 * restart kills background work, and the resumed conversation still lists it.
 *
 * Only the main chain counts (`isSidechain` entries belong to subagents).
 * Nothing read here is logged or stored beyond the verdict.
 *
 * @module services/monitoring/claude-transcript-turn
 */

import * as fs from 'fs';
import { TURN_STATE_CONSTANTS } from '../../constants.js';

/** What the transcript says. */
export type TranscriptTurnVerdict = 'turn' | 'background' | 'idle' | 'unknown';

/** Result of reading a transcript. */
export interface TranscriptTurnState {
	/** Verdict at the end of the file */
	verdict: TranscriptTurnVerdict;
	/** Epoch ms of the newest relevant entry (NaN when none) */
	lastEntryAt: number;
	/** Epoch ms of the newest turn end (end_turn, turn_duration, interrupt, API / usage-limit error); NaN when none */
	turnEndedAt: number;
	/** Background launches with no completion notice yet */
	pendingBackground: number;
	/** Epoch ms of the oldest pending background launch (NaN when none) */
	oldestPendingAt: number;
	/** File modification time (epoch ms) */
	mtimeMs: number;
}

/** Options for parsing. */
export interface TranscriptParseOptions {
	/** Ignore background launches (and turn-end pending counts) older than this (epoch ms) */
	launchedAfter?: number;
}

/** Shape of the transcript entries this reader looks at. */
interface TranscriptEntry {
	type?: string;
	subtype?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	timestamp?: string;
	pendingBackgroundAgentCount?: number;
	content?: unknown;
	attachment?: { type?: string; prompt?: unknown };
	message?: {
		role?: string;
		stop_reason?: string | null;
		content?: unknown;
	};
}

/** A content block of a message. */
interface ContentBlock {
	type?: string;
	id?: string;
	tool_use_id?: string;
	input?: Record<string, unknown>;
	content?: unknown;
	text?: string;
}

/** Stop reasons that end a turn. */
const TURN_ENDING_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
/** System entries Claude Code writes when a turn ends. */
const TURN_END_SUBTYPES = new Set(['turn_duration', 'stop_hook_summary']);
/** Tool results that mean "launched in the background". */
const BACKGROUND_RESULT_MARKERS = ['async agent launched', 'running in background with id'];
/** The notice Claude Code injects when background work finishes. */
const NOTIFICATION_TOOL_USE_ID = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>/g;
/** An interrupt (Esc) written as a user message. */
const INTERRUPT = /^\s*\[Request interrupted by user/;

const cache = new Map<string, { size: number; mtimeMs: number; state: TranscriptTurnState }>();

/**
 * Plain text of a content value (string, or blocks with text).
 *
 * @param content - Message or tool-result content
 * @returns Concatenated text
 */
function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((b) => {
			const block = b as ContentBlock;
			if (typeof block?.text === 'string') return block.text;
			if (block?.content !== undefined) return textOf(block.content);
			return '';
		})
		.join('\n');
}

/**
 * Read the tail of a file.
 *
 * @param filePath - File
 * @param maxBytes - Bytes from the end
 * @returns Text, or null when unreadable
 */
function readTail(filePath: string, maxBytes: number): { text: string; size: number; mtimeMs: number } | null {
	try {
		const stat = fs.statSync(filePath);
		const start = Math.max(0, stat.size - maxBytes);
		const fd = fs.openSync(filePath, 'r');
		try {
			const buf = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			return { text: buf.toString('utf-8'), size: stat.size, mtimeMs: stat.mtimeMs };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * Turn state from transcript text (pure; exported for tests).
 *
 * @param text - JSONL text (a partial first line is ignored)
 * @param mtimeMs - File modification time
 * @param options - Runtime start filter
 * @returns The state
 */
export function parseClaudeTranscriptTurn(text: string, mtimeMs: number = Date.now(), options: TranscriptParseOptions = {}): TranscriptTurnState {
	const after = options.launchedAfter ?? -Infinity;
	const launched = new Map<string, number>();
	const notified = new Set<string>();
	let verdict: TranscriptTurnVerdict = 'unknown';
	let lastEntryAt = NaN;
	let turnEndedAt = NaN;
	let pendingAgentsAtTurnEnd = 0;

	const noteNotifications = (value: unknown): void => {
		const flat = textOf(value);
		if (!flat.includes('<tool-use-id>')) return;
		for (const m of flat.matchAll(NOTIFICATION_TOOL_USE_ID)) notified.add(m[1]);
	};
	const launch = (id: string, at: number): void => {
		// Unknown time: keep it (cannot prove it predates the runtime).
		if (Number.isFinite(at) && at < after) return;
		if (!launched.has(id)) launched.set(id, at);
	};
	const endTurn = (at: number): void => {
		verdict = 'idle';
		if (Number.isFinite(at)) {
			turnEndedAt = at;
			lastEntryAt = at;
		}
	};

	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(line) as TranscriptEntry;
		} catch {
			continue; // partial first line of the tail, or a malformed one
		}
		if (!entry || typeof entry !== 'object' || entry.isSidechain === true) continue;
		const at = Date.parse(entry.timestamp ?? '');
		const content = entry.message?.content;

		// Completion notices queued while the agent was busy, or delivered as an attachment.
		if (entry.type === 'queue-operation') {
			noteNotifications(entry.content);
			continue;
		}
		if (entry.type === 'attachment') {
			noteNotifications(entry.attachment?.prompt);
			continue;
		}
		if (entry.type === 'system' && entry.subtype && TURN_END_SUBTYPES.has(entry.subtype)) {
			endTurn(at);
			if (entry.subtype === 'turn_duration') {
				const fresh = !Number.isFinite(at) || at >= after;
				pendingAgentsAtTurnEnd = fresh && typeof entry.pendingBackgroundAgentCount === 'number' ? entry.pendingBackgroundAgentCount : 0;
			}
			continue;
		}
		if (entry.type === 'assistant') {
			const stop = entry.message?.stop_reason;
			if (Array.isArray(content)) {
				for (const b of content as ContentBlock[]) {
					if (b?.type === 'tool_use' && typeof b.id === 'string' && b.input?.run_in_background === true) launch(b.id, at);
				}
			}
			// API errors and usage limits end the turn without a Stop hook.
			if (entry.isApiErrorMessage === true || (typeof stop === 'string' && TURN_ENDING_STOP_REASONS.has(stop))) {
				endTurn(at);
			} else {
				verdict = 'turn';
				pendingAgentsAtTurnEnd = 0;
				if (Number.isFinite(at)) lastEntryAt = at;
			}
			continue;
		}
		if (entry.type === 'user' && entry.isMeta !== true) {
			noteNotifications(content);
			if (Array.isArray(content)) {
				for (const b of content as ContentBlock[]) {
					if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
					const result = textOf(b.content).slice(0, 400).toLowerCase();
					if (BACKGROUND_RESULT_MARKERS.some((marker) => result.includes(marker))) launch(b.tool_use_id, at);
				}
			}
			if (INTERRUPT.test(textOf(content))) {
				endTurn(at);
			} else {
				verdict = 'turn';
				pendingAgentsAtTurnEnd = 0;
				if (Number.isFinite(at)) lastEntryAt = at;
			}
		}
	}

	let pendingBackground = 0;
	let oldestPendingAt = NaN;
	for (const [id, at] of launched) {
		if (notified.has(id)) continue;
		pendingBackground += 1;
		if (Number.isFinite(at) && !(at >= oldestPendingAt)) oldestPendingAt = at;
	}
	// (Assigned inside closures, which narrowing cannot see.)
	let final = verdict as TranscriptTurnVerdict;
	// The turn-end record counts background agents too; trust the larger number.
	if (final === 'idle' && pendingAgentsAtTurnEnd > pendingBackground) {
		pendingBackground = pendingAgentsAtTurnEnd;
		if (!Number.isFinite(oldestPendingAt)) oldestPendingAt = turnEndedAt;
	}
	if (final === 'idle' && pendingBackground > 0) final = 'background';
	return { verdict: final, lastEntryAt, turnEndedAt, pendingBackground, oldestPendingAt, mtimeMs };
}

/**
 * Turn state of a transcript file, cached by (size, mtime, launchedAfter).
 *
 * @param filePath - Transcript path
 * @param options - Runtime start filter
 * @returns The state, or null when the file cannot be read
 *
 * @example
 * ```typescript
 * const s = claudeTranscriptTurnState('/Users/me/.claude/projects/-x/abc.jsonl', { launchedAfter: startedAt });
 * if (s?.verdict === 'turn') // mid-turn
 * ```
 */
export function claudeTranscriptTurnState(filePath: string, options: TranscriptParseOptions = {}): TranscriptTurnState | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return null;
	}
	const key = `${filePath}\u0000${options.launchedAfter ?? ''}`;
	const hit = cache.get(key);
	if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.state;
	const tail = readTail(filePath, TURN_STATE_CONSTANTS.TRANSCRIPT_TAIL_BYTES);
	if (!tail) return null;
	const state = parseClaudeTranscriptTurn(tail.text, tail.mtimeMs, options);
	if (cache.size >= TURN_STATE_CONSTANTS.MAX_TRACKED_SESSIONS) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { size: tail.size, mtimeMs: tail.mtimeMs, state });
	return state;
}

/**
 * Forget cached transcript reads (tests only).
 */
export function resetTranscriptTurnCache(): void {
	cache.clear();
}
