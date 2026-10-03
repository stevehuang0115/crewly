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
 * - Claude Code hooks (POST /api/agent-hooks): UserPromptSubmit, PreToolUse,
 *   PostToolUse, SubagentStart, SubagentStop, Stop. Only identifiers are kept
 *   (event names, tool-use ids, subagent ids), never payload content.
 * - The Claude Code transcript, as a fallback that also sees background
 *   shells (see claude-transcript-turn.ts).
 *
 * Verdicts:
 * - `turn`: a turn is in progress;
 * - `background`: the turn ended, but a subagent / background task is still
 *   running and will start a new turn when it finishes;
 * - `idle`: the runtime said the turn ended and nothing is pending;
 * - `unknown`: no trustworthy signal; callers fall back to the screen.
 *
 * @module services/monitoring/agent-turn-state
 */

import { TURN_STATE_CONSTANTS } from '../../constants.js';
import { claudeTranscriptTurnState } from './claude-transcript-turn.js';

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
}

/** Per-session record built from hook events. */
interface HookRecord {
	active: boolean;
	activeSince: number;
	lastEventAt: number;
	openTools: Map<string, number>;
	subagents: Map<string, number>;
	anonSubagents: number[];
}

/** Resolves a session to its Claude Code transcript file, or null. */
export type TranscriptLocator = (sessionName: string) => string | null;

const UNKNOWN: TurnVerdict = { state: 'unknown', longRunning: false, since: null, source: 'none' };
const RANK: Record<TurnVerdictState, number> = { unknown: 0, idle: 1, background: 2, turn: 3 };

/**
 * Oldest value in a map, or null.
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
	 * Install the transcript locator used for the fallback.
	 *
	 * @param locator - Locator, or null to disable the fallback
	 */
	setTranscriptLocator(locator: TranscriptLocator | null): void {
		this.transcriptLocator = locator;
		this.located.clear();
	}

	/**
	 * Record a Claude Code hook event.
	 *
	 * @param sessionName - Reporting session
	 * @param event - Hook event name (validated by the caller)
	 * @param ids - Tool-use / subagent ids, already validated
	 * @param now - Clock
	 * @returns True when the event changed the turn state model
	 */
	recordHook(sessionName: string, event: string, ids: TurnHookIds = {}, now: number = Date.now()): boolean {
		const relevant = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
		if (!relevant.includes(event)) return false;
		const r = this.recordFor(sessionName, now);
		r.lastEventAt = now;
		const markActive = (): void => {
			if (!r.active) {
				r.active = true;
				r.activeSince = now;
			}
		};
		switch (event) {
			case 'UserPromptSubmit':
				markActive();
				break;
			case 'PreToolUse':
				markActive();
				if (ids.toolUseId && r.openTools.size < TURN_STATE_CONSTANTS.MAX_OPEN_PER_SESSION) r.openTools.set(ids.toolUseId, now);
				break;
			case 'PostToolUse':
				markActive();
				if (ids.toolUseId) r.openTools.delete(ids.toolUseId);
				break;
			case 'SubagentStart':
				if (ids.agentId) {
					if (r.subagents.size < TURN_STATE_CONSTANTS.MAX_OPEN_PER_SESSION) r.subagents.set(ids.agentId, now);
				} else if (r.anonSubagents.length < TURN_STATE_CONSTANTS.MAX_OPEN_PER_SESSION) {
					r.anonSubagents.push(now);
				}
				break;
			case 'SubagentStop':
				if (ids.agentId && r.subagents.has(ids.agentId)) r.subagents.delete(ids.agentId);
				else if (r.anonSubagents.length > 0) r.anonSubagents.shift();
				else if (ids.agentId === undefined && r.subagents.size > 0) {
					const first = r.subagents.keys().next().value;
					if (first !== undefined) r.subagents.delete(first);
				}
				// The parent is notified and resumes: its turn is active again
				// until the next Stop (2026-10-02, Eve's 04:41:11 turn).
				markActive();
				break;
			case 'Stop':
				r.active = false;
				r.openTools.clear();
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
	 * Sessions that ever reported a hook event (still remembered).
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
		return this.records.get(sessionName)?.lastEventAt ?? null;
	}

	/**
	 * What the hooks say.
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns Verdict (`unknown` without hooks or after a long silence)
	 */
	hookVerdict(sessionName: string, now: number = Date.now()): TurnVerdict {
		const r = this.records.get(sessionName);
		if (!r) return UNKNOWN;
		const maxAge = TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS;
		for (const [id, at] of r.openTools) if (now - at > maxAge) r.openTools.delete(id);
		for (const [id, at] of r.subagents) if (now - at > maxAge) r.subagents.delete(id);
		r.anonSubagents = r.anonSubagents.filter((at) => now - at <= maxAge);
		const subagents = r.subagents.size + r.anonSubagents.length;
		const open = r.openTools.size > 0 || subagents > 0;

		if (r.active) {
			if (open || now - r.lastEventAt <= TURN_STATE_CONSTANTS.HOOK_SILENCE_MS) {
				return { state: 'turn', longRunning: open, since: r.activeSince, source: 'hooks' };
			}
			// A lost Stop must not pin the agent as busy forever.
			return UNKNOWN;
		}
		if (subagents > 0) {
			return { state: 'background', longRunning: true, since: oldest([...r.subagents.values(), ...r.anonSubagents]), source: 'hooks' };
		}
		return { state: 'idle', longRunning: false, since: null, source: 'hooks' };
	}

	/**
	 * What the transcript says (Claude Code only; needs a locator).
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns Verdict
	 */
	transcriptVerdict(sessionName: string, now: number = Date.now()): TurnVerdict {
		if (!this.transcriptLocator) return UNKNOWN;
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
		if (!file) return UNKNOWN;
		const t = claudeTranscriptTurnState(file);
		if (!t) return UNKNOWN;
		const pendingFresh = t.pendingBackground > 0 && (!Number.isFinite(t.oldestPendingAt) || now - t.oldestPendingAt <= TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS);
		if (t.verdict === 'turn') {
			if (now - t.mtimeMs > TURN_STATE_CONSTANTS.TRANSCRIPT_FRESH_MS) return pendingFresh ? this.background(t.oldestPendingAt) : UNKNOWN;
			return { state: 'turn', longRunning: pendingFresh, since: Number.isFinite(t.lastEntryAt) ? t.lastEntryAt : null, source: 'transcript' };
		}
		if (t.verdict === 'background') return pendingFresh ? this.background(t.oldestPendingAt) : { state: 'idle', longRunning: false, since: null, source: 'transcript' };
		if (t.verdict === 'idle') return { state: 'idle', longRunning: false, since: null, source: 'transcript' };
		return UNKNOWN;
	}

	/**
	 * Combined verdict: the busiest of hooks and transcript.
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
		const hooks = this.hookVerdict(sessionName, now);
		const transcript = this.transcriptVerdict(sessionName, now);
		const winner = RANK[transcript.state] > RANK[hooks.state] ? transcript : hooks;
		const busy = (v: TurnVerdict): boolean => v.state === 'turn' || v.state === 'background';
		return {
			...winner,
			longRunning: (busy(hooks) && hooks.longRunning) || (busy(transcript) && transcript.longRunning),
		};
	}

	/**
	 * Whether the agent still has background work after its turn ended (or
	 * during it): the work it is answering for is not finished yet.
	 *
	 * @param sessionName - Session
	 * @param now - Clock
	 * @returns True for a `background` verdict
	 */
	hasBackgroundWork(sessionName: string, now: number = Date.now()): boolean {
		return this.getVerdict(sessionName, now).state === 'background';
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
			lastEventAt: now,
			openTools: new Map(),
			subagents: new Map(),
			anonSubagents: [],
		};
		this.records.set(sessionName, r);
		return r;
	}

	/**
	 * A `background` verdict from the transcript.
	 *
	 * @param since - Oldest pending launch
	 * @returns Verdict
	 */
	private background(since: number): TurnVerdict {
		return { state: 'background', longRunning: true, since: Number.isFinite(since) ? since : null, source: 'transcript' };
	}
}
