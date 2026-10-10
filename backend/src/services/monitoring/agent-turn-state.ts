/**
 * Agent Turn State
 *
 * Whether an agent is mid-turn according to its runtime, not according to
 * its screen. Long tool calls, a model writing a long tool input and
 * background subagents are all silent on the PTY. Reading silence as "idle"
 * let a restart kill Eve mid-work (2026-10-02, TKT-194). See
 * specs/2026-10-02-restart-busy-and-resume.md.
 *
 * Sources:
 * - Claude Code hooks (POST /api/agent-hooks): SessionStart, UserPromptSubmit,
 *   PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop. Only
 *   identifiers are kept (event names, tool-use ids, subagent ids), never
 *   payload content.
 * - The Claude Code transcript (see claude-transcript-turn.ts).
 *
 * How they combine:
 * - The hooks lead. A transcript turn end (end_turn, interrupt, API or
 *   usage-limit error) newer than the last hook event ends a hook `turn`:
 *   Esc and API errors fire no Stop hook.
 * - `Stop` clears open tool calls and holds the turn's subagents. Held
 *   subagents count as `background` only while the transcript (Claude Code's
 *   own pending-background count) agrees; a transcript turn end with nothing
 *   pending drops them.
 * - A transcript-only `background` (no hook saw a subagent) is reported as
 *   `idle`: on its own it never blocks the drain or settling.
 * - A transcript `turn` newer than the last hook event (a lost hook) is a turn.
 *
 * Verdicts:
 * - `turn`: a turn is in progress;
 * - `background`: the turn ended, but a subagent is still running and will
 *   start a new turn when it finishes;
 * - `idle`: the runtime said the turn ended and nothing is pending;
 * - `unknown`: no trustworthy signal; callers fall back to the screen.
 *
 * @module services/monitoring/agent-turn-state
 */

import { TURN_STATE_CONSTANTS } from '../../constants.js';
import { claudeTranscriptTurnState, type TranscriptTurnState } from './claude-transcript-turn.js';

/** What the runtime says about a session. */
export type TurnVerdictState = 'turn' | 'background' | 'idle' | 'unknown';

/** A verdict with the details callers need. */
export interface TurnVerdict {
	/** The state */
	state: TurnVerdictState;
	/** A tool call, subagent or background task is open (the drain waits longer) */
	longRunning: boolean;
	/** Epoch ms the turn / background work began, when known */
	since: number | null;
	/** Which source decided */
	source: 'hooks' | 'transcript' | 'none';
}

/** Identifiers a hook event may carry. */
export interface TurnHookIds {
	/** Claude Code tool_use_id (PreToolUse / PostToolUse) */
	toolUseId?: string;
	/** Subagent id (SubagentStart / SubagentStop) */
	agentId?: string;
	/** SessionStart source (startup / resume / clear / compact) */
	source?: string;
}

/** Per-session record built from hook events. */
interface HookRecord {
	active: boolean;
	activeSince: number;
	lastEventAt: number;
	/** Epoch ms of the last turn end (Stop, or a newer transcript turn end); null before any */
	stoppedAt: number | null;
	/** Epoch ms the current runtime process started, when known */
	runtimeStartedAt: number | null;
	openTools: Map<string, number>;
	/** Subagents started in the current turn (or after the last Stop) */
	subagents: Map<string, number>;
	/** Subagents held over a Stop: background only while the transcript agrees */
	heldSubagents: Map<string, number>;
	anonSeq: number;
	/** Epoch ms of recent PreToolUse events (newest last, capped) */
	toolStarts: number[];
}

/** Resolves a session to its Claude Code transcript file, or null. */
export type TranscriptLocator = (sessionName: string) => string | null;

/** Hook events this service reads. */
const TURN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']);
/** SessionStart sources that mean a new runtime process. */
const RUNTIME_START_SOURCES = new Set(['startup', 'resume']);
/** Prefix of synthetic ids for subagents that reported none. */
const ANON = '\u0000anon-';

const UNKNOWN: TurnVerdict = { state: 'unknown', longRunning: false, since: null, source: 'none' };

/**
 * Oldest value, or null.
 *
 * @param values - Timestamps
 * @returns Smallest, or null when empty
 */
function oldest(values: Iterable<number>): number | null {
	let min: number | null = null;
	for (const v of values) if (min === null || v < min) min = v;
	return min;
}

/**
 * Process-wide runtime turn state. Singleton; in memory only (a backend
 * restart kills the agents too, so nothing needs to survive one).
 */
export class AgentTurnStateService {
	private static instance: AgentTurnStateService | null = null;
	private readonly records = new Map<string, HookRecord>();
	private transcriptLocator: TranscriptLocator | null = null;
	/** Located transcript per session, re-resolved after LOCATOR_CACHE_MS */
	private readonly located = new Map<string, { file: string | null; at: number }>();

	/**
	 * @returns The singleton
	 */
	static getInstance(): AgentTurnStateService {
		if (!AgentTurnStateService.instance) AgentTurnStateService.instance = new AgentTurnStateService();
		return AgentTurnStateService.instance;
	}

	/** Reset the singleton (tests only). */
	static resetInstance(): void {
		AgentTurnStateService.instance = null;
	}

	/**
	 * Install the transcript locator.
	 *
	 * @param locator - Locator, or null to disable the transcript
	 */
	setTranscriptLocator(locator: TranscriptLocator | null): void {
		this.transcriptLocator = locator;
		this.located.clear();
	}

	/**
	 * A runtime process was (re)started for the session: forget its old turn
	 * state, and ignore transcript background launches from before now.
	 *
	 * @param sessionName - Session
	 * @param now - Start time
	 */
	noteRuntimeStart(sessionName: string, now: number = Date.now()): void {
		this.records.delete(sessionName);
		this.located.delete(sessionName);
		const r = this.recordFor(sessionName, now);
		r.runtimeStartedAt = now;
	}

	/**
	 * Record a Claude Code hook event.
	 *
	 * @param sessionName - Reporting session
	 * @param event - Hook event name (validated by the caller)
	 * @param ids - Tool-use / subagent ids and SessionStart source, already validated
	 * @param now - Clock
	 * @returns True when the event changed the turn state model
	 */
	recordHook(sessionName: string, event: string, ids: TurnHookIds = {}, now: number = Date.now()): boolean {
		if (!TURN_EVENTS.has(event)) return false;
		if (event === 'SessionStart') {
			if (ids.source && RUNTIME_START_SOURCES.has(ids.source)) {
				this.noteRuntimeStart(sessionName, now);
			} else {
				// /clear or compaction: same process, maybe another transcript file.
				this.located.delete(sessionName);
			}
			return true;
		}
		const r = this.recordFor(sessionName, now);
		r.lastEventAt = now;
		const markActive = (): void => {
			if (!r.active) {
				r.active = true;
				r.activeSince = now;
			}
		};
		const max = TURN_STATE_CONSTANTS.MAX_OPEN_PER_SESSION;
		switch (event) {
			case 'UserPromptSubmit':
				markActive();
				break;
			case 'PreToolUse':
				markActive();
				r.toolStarts.push(now);
				if (r.toolStarts.length > 64) r.toolStarts.shift();
				if (ids.toolUseId && r.openTools.size < max) r.openTools.set(ids.toolUseId, now);
				break;
			case 'PostToolUse':
				markActive();
				if (ids.toolUseId) r.openTools.delete(ids.toolUseId);
				break;
			case 'SubagentStart':
				if (r.subagents.size < max) r.subagents.set(ids.agentId ?? `${ANON}${r.anonSeq++}`, now);
				break;
			case 'SubagentStop': {
				const removeFrom = (m: Map<string, number>): boolean => {
					if (ids.agentId && m.delete(ids.agentId)) return true;
					if (!ids.agentId) {
						const anon = [...m.keys()].find((k) => k.startsWith(ANON)) ?? m.keys().next().value;
						if (anon !== undefined) return m.delete(anon);
					}
					return false;
				};
				if (!removeFrom(r.subagents)) removeFrom(r.heldSubagents);
				// The parent is notified and resumes: its turn is active again
				// until the next Stop (2026-10-02, Eve's 04:41:11 turn).
				markActive();
				break;
			}
			case 'Stop':
				this.endTurn(r, now);
				break;
		}
		return true;
	}

	/**
	 * Forget a session (its runtime exited).
	 *
	 * @param sessionName - Session
	 */
	forget(sessionName: string): void {
		this.records.delete(sessionName);
		this.located.delete(sessionName);
	}

	/**
	 * Sessions that reported a hook event (still remembered).
	 *
	 * @returns Session names
	 */
	knownSessions(): string[] {
		return [...this.records.keys()];
	}

	/**
	 * Epoch ms of the session's last hook event, or null when it never sent one.
	 *
	 * @param sessionName - Session
	 * @returns Time or null
	 */
	lastHookEventAt(sessionName: string): number | null {
		const r = this.records.get(sessionName);
		return r && r.lastEventAt > 0 ? r.lastEventAt : null;
	}

	/**
	 * How many tool calls the session started after `since` (PreToolUse hooks).
	 * Used to tell "said it would do X" from "did something after saying so".
	 *
	 * @param sessionName - Session
	 * @param since - Epoch ms (exclusive)
	 * @returns Count, or null when the session reports no hooks (the caller must not guess)
	 */
	toolStartsSince(sessionName: string, since: number): number | null {
		const r = this.records.get(sessionName);
		if (!r || r.lastEventAt === 0) return null;
		let n = 0;
		for (const t of r.toolStarts) if (t > since) n++;
		return n;
	}

	/**
	 * Epoch ms the session's current runtime process started, when known.
	 *
	 * @param sessionName - Session
	 * @returns Time or null
	 */
	runtimeStartedAt(sessionName: string): number | null {
		return this.records.get(sessionName)?.runtimeStartedAt ?? null;
	}

	/**
	 * What the hooks alone say (held subagents count as background here).
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns Verdict (`unknown` without hooks or after a long silence)
	 */
	hookVerdict(sessionName: string, now: number = Date.now()): TurnVerdict {
		const r = this.records.get(sessionName);
		if (!r || r.lastEventAt === 0) return UNKNOWN;
		this.expire(r, now);
		const subs = r.subagents.size + r.heldSubagents.size;
		if (r.active) {
			const open = r.openTools.size > 0 || subs > 0;
			if (open || now - r.lastEventAt <= TURN_STATE_CONSTANTS.HOOK_SILENCE_MS) {
				return { state: 'turn', longRunning: open, since: r.activeSince, source: 'hooks' };
			}
			// A lost Stop must not pin the agent as busy forever.
			return UNKNOWN;
		}
		if (subs > 0) {
			return { state: 'background', longRunning: true, since: oldest([...r.subagents.values(), ...r.heldSubagents.values()]), source: 'hooks' };
		}
		return { state: 'idle', longRunning: false, since: null, source: 'hooks' };
	}

	/**
	 * Combined verdict (see the module doc for the rules).
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns Verdict
	 *
	 * @example
	 * ```typescript
	 * const v = AgentTurnStateService.getInstance().getVerdict('eve-1');
	 * if (v.state === 'turn' || v.state === 'background') // do not call it idle
	 * ```
	 */
	getVerdict(sessionName: string, now: number = Date.now()): TurnVerdict {
		const r = this.records.get(sessionName);
		const t = this.readTranscript(sessionName, now, r?.runtimeStartedAt ?? undefined);
		const transcriptTurn = t !== null && t.verdict === 'turn' && now - t.mtimeMs <= TURN_STATE_CONSTANTS.TRANSCRIPT_FRESH_MS;
		const asTranscriptTurn = (): TurnVerdict => ({
			state: 'turn',
			longRunning: false,
			since: t && Number.isFinite(t.lastEntryAt) ? t.lastEntryAt : null,
			source: 'transcript',
		});

		if (!r || r.lastEventAt === 0) {
			if (transcriptTurn) return asTranscriptTurn();
			// A transcript-only "background" never blocks on its own.
			if (t && (t.verdict === 'idle' || t.verdict === 'background')) return { state: 'idle', longRunning: false, since: null, source: 'transcript' };
			return UNKNOWN;
		}

		// Esc, API errors and usage limits end the turn with no Stop hook: a
		// transcript turn end newer than the last hook event ends it here too.
		if (r.active && t && Number.isFinite(t.turnEndedAt) && t.turnEndedAt > r.lastEventAt) {
			this.endTurn(r, t.turnEndedAt);
		}

		const hooks = this.hookVerdict(sessionName, now);
		if (hooks.state === 'turn') return hooks;
		if (hooks.state === 'background') {
			// Held subagents need Claude Code's own word that they still run.
			// (A transcript still mid-flush — its last entry the turn's tool
			// result — agrees too when it lists the launch as pending.)
			const agrees = t !== null && t.pendingBackground > 0 && (t.verdict === 'background' || transcriptTurn);
			const liveSince = oldest(r.subagents.values());
			if (r.subagents.size > 0 || agrees) {
				return { ...hooks, ...(agrees ? {} : { since: liveSince }) };
			}
			if (t !== null && t.verdict === 'idle' && r.stoppedAt !== null && Number.isFinite(t.turnEndedAt) && t.turnEndedAt >= r.stoppedAt - TURN_STATE_CONSTANTS.TRANSCRIPT_LAG_MS) {
				r.heldSubagents.clear(); // the transcript says nothing is pending: they were stale
			}
			if (!t) r.heldSubagents.clear(); // no second opinion: Stop clears them
			return { state: 'idle', longRunning: false, since: null, source: 'hooks' };
		}
		// A turn the hooks missed (a failed POST) but the transcript shows.
		if (transcriptTurn && t && t.lastEntryAt > r.lastEventAt) return asTranscriptTurn();
		return hooks;
	}

	/**
	 * Whether the agent still has background work after its turn ended: the
	 * work it is answering for is not finished yet.
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns True for a `background` verdict
	 */
	hasBackgroundWork(sessionName: string, now: number = Date.now()): boolean {
		return this.getVerdict(sessionName, now).state === 'background';
	}

	/**
	 * End a record's turn: open tools are cleared, the turn's subagents are held.
	 *
	 * @param r - Record
	 * @param at - When the turn ended
	 */
	private endTurn(r: HookRecord, at: number): void {
		r.active = false;
		r.stoppedAt = at;
		r.openTools.clear();
		for (const [id, startedAt] of r.subagents) r.heldSubagents.set(id, startedAt);
		r.subagents.clear();
	}

	/**
	 * Drop open tool calls and subagents older than OPEN_WORK_MAX_MS.
	 *
	 * @param r - Record
	 * @param now - Clock
	 */
	private expire(r: HookRecord, now: number): void {
		const maxAge = TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS;
		for (const m of [r.openTools, r.subagents, r.heldSubagents]) {
			for (const [id, at] of m) if (now - at > maxAge) m.delete(id);
		}
	}

	/**
	 * Read the session's transcript, if a locator finds one.
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @param launchedAfter - Runtime start (older launches ignored)
	 * @returns The transcript state, or null
	 */
	private readTranscript(sessionName: string, now: number, launchedAfter: number | undefined): TranscriptTurnState | null {
		if (!this.transcriptLocator) return null;
		const cached = this.located.get(sessionName);
		let file: string | null;
		if (cached && now - cached.at < TURN_STATE_CONSTANTS.LOCATOR_CACHE_MS) {
			file = cached.file;
		} else {
			try {
				file = this.transcriptLocator(sessionName);
			} catch {
				file = null;
			}
			if (this.located.size >= TURN_STATE_CONSTANTS.MAX_TRACKED_SESSIONS) this.located.clear();
			this.located.set(sessionName, { file, at: now });
		}
		if (!file) return null;
		return claudeTranscriptTurnState(file, launchedAfter !== undefined ? { launchedAfter } : {});
	}

	/**
	 * Get or create a session's record (bounded).
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns The record
	 */
	private recordFor(sessionName: string, now: number): HookRecord {
		let r = this.records.get(sessionName);
		if (r) return r;
		if (this.records.size >= TURN_STATE_CONSTANTS.MAX_TRACKED_SESSIONS) {
			const first = this.records.keys().next().value;
			if (first !== undefined) this.records.delete(first);
		}
		r = {
			active: false,
			activeSince: now,
			lastEventAt: 0,
			stoppedAt: null,
			runtimeStartedAt: null,
			openTools: new Map(),
			subagents: new Map(),
			heldSubagents: new Map(),
			anonSeq: 0,
			toolStarts: [],
		};
		this.records.set(sessionName, r);
		return r;
	}
}
