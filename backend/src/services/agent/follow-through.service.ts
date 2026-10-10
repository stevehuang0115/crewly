/**
 * Agent follow-through guard.
 *
 * An agent that tells the owner "I'm doing X now" and then ends its turn has
 * broken a promise that nothing tracked (2026-10-10, Pia, three videos: two
 * turns ended on "I haven't started yet — the next step is …" and she was
 * idle-stopped 24 minutes later). This service remembers the last stated
 * intent per agent and, at turn end, nudges the agent once when nothing
 * followed it — no tool call, no WorkItem for the work, no hand-off.
 *
 * Cheap by construction: text heuristics ({@link detectStatedIntent}) plus
 * the runtime's own tool hooks; no model call. Off switch:
 * `CREWLY_FOLLOW_THROUGH=off`.
 *
 * @module services/agent/follow-through.service
 * @see specs/2026-10-10-agent-follow-through.md
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { detectStatedIntent } from './stated-intent.js';

/** Tunables (ms). */
export const FOLLOW_THROUGH_CONSTANTS = {
	/** A statement older than this is stale: the turn that ended now is not about it */
	MAX_AGE_MS: 30 * 60_000,
	/** A statement keeps its agent from being idle-stopped for this long */
	HOLD_MS: 60 * 60_000,
	/** Never nudge one agent more often than this, whatever it says next */
	NUDGE_COOLDOWN_MS: 10 * 60_000,
	/** Without tool hooks: PTY output for longer than this after the statement counts as work */
	OUTPUT_WORK_MS: 45_000,
	/** After a runtime restart the first tool call is the harness's own register-self */
	TOOLS_AFTER_RESTART: 2,
} as const;

/** What the guard needs from the rest of the backend. */
export interface FollowThroughDeps {
	/** Deliver text into the agent's conversation (wakes nothing; false when not delivered) */
	nudgeAgent: (session: string, text: string) => Promise<boolean>;
	/** Tool calls started after `since`; null when the runtime reports no hooks */
	toolStartsSince: (session: string, since: number) => number | null;
	/** Epoch ms the agent's runtime process started, when known */
	runtimeStartedAt?: (session: string) => number | null;
	/** Fallback without hooks: ms of PTY output after `since`; null when unknown */
	outputSpanSince?: (session: string, since: number) => number | null;
	/** The agent handed the work to someone or put it on the pool since `since` */
	handedOff: (session: string, since: number) => Promise<boolean>;
	/** The agent is waiting on an owner card / question */
	waitingOnOwner?: (session: string) => Promise<boolean>;
	/** Owner-stopped or team-paused agents are never nudged */
	isHeldBack?: (session: string) => boolean;
	now?: () => number;
}

/** One remembered statement. */
interface Statement {
	at: number;
	sentence: string;
	nudged: boolean;
}

/** What a turn end did. */
export type TurnEndOutcome = 'none' | 'stale' | 'worked' | 'handed_off' | 'waiting' | 'held' | 'cooldown' | 'nudged' | 'not_delivered';

/**
 * @param sentence - What the agent said
 * @returns The nudge text (harness text, English)
 */
export function followThroughNudge(sentence: string): string {
	return (
		`[FOLLOW-THROUGH] You told the owner you would do this now: "${sentence}". ` +
		'Your turn ended without starting it. Start it now, in this turn; ' +
		"don't reply again until there's a result or a real blocker."
	);
}

/**
 * Tracks the last stated intent per agent and nudges once when a turn ends
 * without following it.
 */
export class AgentFollowThroughService {
	private readonly statements = new Map<string, Statement>();
	private readonly lastNudgeAt = new Map<string, number>();
	private readonly lastReplyAt = new Map<string, number>();
	private readonly logger: ComponentLogger;

	/** @param deps - Injected behaviour */
	constructor(private readonly deps: FollowThroughDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('FollowThrough');
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/**
	 * An agent posted to the owner (Slack or chat). A post that states an intent
	 * is remembered; any other post supersedes the earlier statement.
	 *
	 * @param input - Agent, the post's text, whether it was an interim "working on it" mark
	 */
	noteAgentPost(input: { agent: string; text: string; interim?: boolean; at?: number }): void {
		if (!input.agent || input.agent === ORCHESTRATOR_SESSION_NAME) return;
		const at = input.at ?? this.now();
		const found = detectStatedIntent(input.text);
		if (found) {
			this.statements.set(input.agent, { at, sentence: found.sentence, nudged: false });
			return;
		}
		this.statements.delete(input.agent);
		if (!input.interim) this.lastReplyAt.set(input.agent, at);
	}

	/**
	 * When the agent last posted something that was not a stated intent (an
	 * answer, a result, a question). Ticket work creation reads it.
	 *
	 * @param agent - Session
	 * @returns Epoch ms, or undefined
	 */
	lastRealReplyAt(agent: string): number | undefined {
		return this.lastReplyAt.get(agent);
	}

	/**
	 * Whether the agent has an unfulfilled stated intent (nudged or not) that
	 * is recent enough to keep it from being idle-stopped.
	 *
	 * @param agent - Session
	 * @returns True while one is open
	 */
	holdsIntent(agent: string): boolean {
		const s = this.statements.get(agent);
		return !!s && this.now() - s.at <= FOLLOW_THROUGH_CONSTANTS.HOLD_MS;
	}

	/**
	 * Take the open statement away (the caller turns it into a WorkItem).
	 *
	 * @param agent - Session
	 * @returns The sentence, or null
	 */
	takeIntent(agent: string): { sentence: string; at: number } | null {
		const s = this.statements.get(agent);
		if (!s) return null;
		this.statements.delete(agent);
		return { sentence: s.sentence, at: s.at };
	}

	/**
	 * The agent's turn ended: nudge it once when it stated an intent that
	 * nothing followed. Never throws.
	 *
	 * @param agent - Session
	 * @returns What happened
	 */
	async onTurnEnd(agent: string): Promise<TurnEndOutcome> {
		try {
			const s = this.statements.get(agent);
			if (!s || s.nudged) return 'none';
			const now = this.now();
			if (now - s.at > FOLLOW_THROUGH_CONSTANTS.MAX_AGE_MS) {
				this.statements.delete(agent);
				return 'stale';
			}
			if (this.followed(agent, s)) {
				this.statements.delete(agent);
				return 'worked';
			}
			if (await this.deps.handedOff(agent, s.at - 60_000).catch(() => false)) {
				this.statements.delete(agent);
				return 'handed_off';
			}
			if (await this.deps.waitingOnOwner?.(agent).catch(() => false)) return 'waiting';
			if (this.deps.isHeldBack?.(agent)) return 'held';
			// One nudge per statement; one per agent per cooldown, whatever it says next.
			s.nudged = true;
			const last = this.lastNudgeAt.get(agent);
			if (last !== undefined && now - last < FOLLOW_THROUGH_CONSTANTS.NUDGE_COOLDOWN_MS) return 'cooldown';
			const ok = await this.deps.nudgeAgent(agent, followThroughNudge(s.sentence)).catch(() => false);
			this.logger.info('Stated intent without action — agent nudged', { agent, sentence: s.sentence, delivered: ok });
			if (!ok) return 'not_delivered';
			this.lastNudgeAt.set(agent, now);
			return 'nudged';
		} catch (err) {
			this.logger.debug('Follow-through check failed (non-fatal)', { agent, error: err instanceof Error ? err.message : String(err) });
			return 'none';
		}
	}

	/** Whether the agent did anything after the statement. */
	private followed(agent: string, s: Statement): boolean {
		const tools = this.deps.toolStartsSince(agent, s.at);
		if (tools !== null) {
			const restarted = (this.deps.runtimeStartedAt?.(agent) ?? 0) > s.at;
			return tools >= (restarted ? FOLLOW_THROUGH_CONSTANTS.TOOLS_AFTER_RESTART : 1);
		}
		const span = this.deps.outputSpanSince?.(agent, s.at);
		// No hooks and no output reading: cannot tell, so do not nag.
		if (span === null || span === undefined) return true;
		return span >= FOLLOW_THROUGH_CONSTANTS.OUTPUT_WORK_MS;
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AgentFollowThroughService | null = null;

/** @returns The wired guard, or null before boot (and when switched off) */
export function getFollowThrough(): AgentFollowThroughService | null {
	return instance;
}

/** @param service - The guard to expose (null clears) */
export function setFollowThrough(service: AgentFollowThroughService | null): void {
	instance = service;
}

/**
 * Report an agent's post to the owner, if the guard runs. Never throws.
 *
 * @param input - Agent, text, interim flag
 */
export function reportAgentPostForFollowThrough(input: { agent: string; text: string; interim?: boolean }): void {
	try {
		instance?.noteAgentPost(input);
	} catch {
		/* best-effort */
	}
}
