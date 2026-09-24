/**
 * In-Flight Turn Tracker
 *
 * Remembers, per agent session, the messages that were written into the
 * agent's PTY (or handed to an in-process runtime) and whether the agent has
 * finished the turn they started.
 *
 * Why this exists: the persistent message queue only protects messages that
 * have not been delivered yet. Once a message is in the PTY it is off the
 * queue, so a restart during the agent's turn used to lose the turn with no
 * trace — the owner DM'd Ella at 01:38:30, a restart at 01:39:31 killed her
 * mid-turn, and nothing picked it back up (2026-09-24). The drain and the
 * interrupted-turn resume both read from here.
 *
 * Turn completion is decided by a {@link TurnProbe}, not by events alone:
 * - the ActivityMonitor `agent:idle` event is a *prompt* to re-probe, never a
 *   verdict — it fires on a 30s poll and is force-emitted after 15 minutes of
 *   continuous output even when the agent is still working;
 * - a reply (report-status / reply-slack / chat) is not a verdict either — an
 *   agent says "on it" and keeps working, which is exactly the Ella case;
 * - in-process (crewly-agent) turns end precisely when their promise settles,
 *   so the caller reports that directly via {@link completeMessage}.
 *
 * @module services/restart/in-flight-turn-tracker
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SAFE_RESTART } from '../../constants.js';

/** What the probe says about a session right now. */
export type TurnProbeResult = 'busy' | 'idle' | 'gone';

/** Answers whether an agent session is currently mid-turn. */
export type TurnProbe = (sessionName: string) => TurnProbeResult;

/** How the message reached the agent. */
export type DeliveryRuntime = 'pty' | 'in-process';

/** Queue metadata attached by the message-queue processor after delivery. */
export interface DeliveryMeta {
	/** Message-queue id */
	messageId?: string;
	/** Message source (slack, web_chat, system_event, …) */
	source?: string;
	/** Conversation id used for reply routing */
	conversationId?: string;
	/** Message body before the queue processor added its [CHAT:…] prefix */
	originalContent?: string;
	/** JSON-safe subset of the source metadata (channelId, threadTs, …) */
	sourceMetadata?: Record<string, string | number | boolean>;
	/** True for scheduler / status pings wrapped in [SYSTEM] markers */
	systemEvent?: boolean;
}

/** One message delivered into an agent's current turn. */
export interface DeliveredMessage extends DeliveryMeta {
	/** Epoch ms of the write */
	deliveredAt: number;
	/** Exactly what was written to the PTY / runtime */
	text: string;
	/** Single-line preview of `text` */
	preview: string;
}

/** A session whose last delivered message(s) may still be in progress. */
export interface InFlightTurn {
	/** Agent session name */
	sessionName: string;
	/** How the messages were delivered */
	runtime: DeliveryRuntime;
	/** Epoch ms of the oldest open delivery */
	since: number;
	/** Open deliveries, oldest first */
	messages: DeliveredMessage[];
}

/** Minimal event-bus surface the tracker listens to. */
export interface TurnEventSource {
	on(event: 'eventPublished', listener: (event: { type?: string; sessionName?: string }) => void): unknown;
	off?(event: 'eventPublished', listener: (event: { type?: string; sessionName?: string }) => void): unknown;
	removeListener?(event: 'eventPublished', listener: (event: { type?: string; sessionName?: string }) => void): unknown;
}

/** Marker that opens every scheduler / reconciler / status ping. */
const SYSTEM_MARKER = /^\s*\[SYSTEM\b/;

/**
 * Build a one-line preview of a delivered message.
 *
 * @param text - Delivered text
 * @returns Whitespace-collapsed text, cut to SAFE_RESTART.PREVIEW_CHARS
 */
export function previewOf(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > SAFE_RESTART.PREVIEW_CHARS ? `${flat.slice(0, SAFE_RESTART.PREVIEW_CHARS - 1)}…` : flat;
}

/**
 * Tracks in-flight agent turns. Singleton; all state is in memory.
 */
export class InFlightTurnTracker {
	private static instance: InFlightTurnTracker | null = null;
	private readonly logger: ComponentLogger;
	private readonly turns = new Map<string, InFlightTurn>();
	private probe: TurnProbe | null = null;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('InFlightTurnTracker');
	}

	/**
	 * Get the singleton instance.
	 *
	 * @returns The tracker
	 */
	static getInstance(): InFlightTurnTracker {
		if (!InFlightTurnTracker.instance) {
			InFlightTurnTracker.instance = new InFlightTurnTracker();
		}
		return InFlightTurnTracker.instance;
	}

	/**
	 * Reset the singleton (tests only).
	 */
	static resetInstance(): void {
		InFlightTurnTracker.instance = null;
	}

	/**
	 * Install the probe used to decide whether a PTY session is still mid-turn.
	 *
	 * @param probe - Probe function, or null to remove
	 */
	setProbe(probe: TurnProbe | null): void {
		this.probe = probe;
	}

	/**
	 * Record a message that was just written into an agent's PTY or handed to
	 * its in-process runtime.
	 *
	 * Callers should {@link settle} the session *before* writing: if the agent
	 * is resting, whatever was still open belonged to a finished turn and is
	 * dropped, so a restart never resumes a message that was already answered.
	 * (After the write the echo makes the PTY look busy, so settling then
	 * proves nothing.)
	 *
	 * @param sessionName - Agent session
	 * @param text - Exactly what was delivered
	 * @param runtime - How it was delivered
	 * @param now - Current time (ms)
	 * @returns The recorded message (pass it to completeMessage for in-process turns)
	 */
	recordDelivery(sessionName: string, text: string, runtime: DeliveryRuntime = 'pty', now: number = Date.now()): DeliveredMessage {
		const message: DeliveredMessage = {
			deliveredAt: now,
			text,
			preview: previewOf(text),
			systemEvent: SYSTEM_MARKER.test(text),
		};
		const turn = this.turns.get(sessionName);
		if (!turn) {
			this.turns.set(sessionName, { sessionName, runtime, since: now, messages: [message] });
			return message;
		}
		turn.runtime = runtime;
		turn.messages.push(message);
		while (turn.messages.length > SAFE_RESTART.MAX_OPEN_MESSAGES_PER_SESSION) {
			turn.messages.shift();
		}
		turn.since = turn.messages[0].deliveredAt;
		return message;
	}

	/**
	 * Attach queue metadata to the most recent open delivery whose text matches.
	 * Called by the queue processor after a successful delivery so the resume
	 * path can re-enqueue with the original source (Slack thread etc.).
	 *
	 * @param sessionName - Agent session
	 * @param text - The delivered text (as passed to sendMessageToAgent)
	 * @param meta - Queue metadata
	 * @returns True if a matching delivery was found
	 */
	annotate(sessionName: string, text: string, meta: DeliveryMeta): boolean {
		const turn = this.turns.get(sessionName);
		if (!turn) return false;
		for (let i = turn.messages.length - 1; i >= 0; i--) {
			const msg = turn.messages[i];
			if (msg.text === text) {
				Object.assign(msg, meta, { systemEvent: meta.systemEvent ?? msg.systemEvent });
				return true;
			}
		}
		return false;
	}

	/**
	 * Mark one delivery as finished (in-process runtimes report this exactly).
	 *
	 * @param sessionName - Agent session
	 * @param message - The object returned by recordDelivery
	 */
	completeMessage(sessionName: string, message: DeliveredMessage): void {
		const turn = this.turns.get(sessionName);
		if (!turn) return;
		turn.messages = turn.messages.filter((m) => m !== message);
		if (turn.messages.length === 0) {
			this.turns.delete(sessionName);
		} else {
			turn.since = turn.messages[0].deliveredAt;
		}
	}

	/**
	 * Drop every open delivery for a session (turn over, or session gone).
	 *
	 * @param sessionName - Agent session
	 * @param reason - Why, for the debug log
	 */
	markTurnComplete(sessionName: string, reason: string): void {
		if (this.turns.delete(sessionName)) {
			this.logger.debug('Turn complete', { sessionName, reason });
		}
	}

	/**
	 * Re-check one session with the probe and drop its open deliveries if the
	 * agent is resting or its session is gone. In-process turns are left alone:
	 * only their promise can end them.
	 *
	 * @param sessionName - Agent session
	 * @param now - Current time (ms)
	 * @returns True if the session is still mid-turn afterwards
	 */
	settle(sessionName: string, now: number = Date.now()): boolean {
		const turn = this.turns.get(sessionName);
		if (!turn) return false;
		if (turn.runtime === 'in-process') return true;
		const newest = turn.messages[turn.messages.length - 1];
		if (newest && now - newest.deliveredAt < SAFE_RESTART.TURN_START_GRACE_MS) return true;
		if (!this.probe) return true;
		let verdict: TurnProbeResult;
		try {
			verdict = this.probe(sessionName);
		} catch (error) {
			// A probe that throws cannot prove the turn is over — keep waiting.
			this.logger.warn('Turn probe failed; treating session as busy', {
				sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
			return true;
		}
		if (verdict === 'busy') return true;
		this.markTurnComplete(sessionName, verdict === 'gone' ? 'session gone' : 'agent resting');
		return false;
	}

	/**
	 * Settle every tracked session and return those still mid-turn.
	 *
	 * @param now - Current time (ms)
	 * @returns Snapshot of in-flight turns, oldest first
	 */
	getMidTurn(now: number = Date.now()): InFlightTurn[] {
		for (const sessionName of [...this.turns.keys()]) {
			this.settle(sessionName, now);
		}
		return this.snapshot();
	}

	/**
	 * Snapshot of every open turn without probing.
	 *
	 * @returns Copies of the open turns, oldest first
	 */
	snapshot(): InFlightTurn[] {
		return [...this.turns.values()]
			.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m })) }))
			.sort((a, b) => a.since - b.since);
	}

	/**
	 * Re-probe a session whenever the ActivityMonitor reports it idle, so a
	 * finished turn is forgotten promptly instead of lingering until the next
	 * delivery. The event only triggers the probe; it never decides alone.
	 *
	 * @param source - Event bus emitting 'eventPublished'
	 * @returns Function that detaches the listener
	 */
	attachEventSource(source: TurnEventSource): () => void {
		const listener = (event: { type?: string; sessionName?: string }): void => {
			if (event?.type === 'agent:idle' && typeof event.sessionName === 'string') {
				this.settle(event.sessionName);
			}
		};
		source.on('eventPublished', listener);
		return () => {
			if (source.off) source.off('eventPublished', listener);
			else source.removeListener?.('eventPublished', listener);
		};
	}
}
