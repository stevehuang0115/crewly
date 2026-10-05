/**
 * Input-blocked retry — keeps retrying messages the input guard held back,
 * and tells someone when an agent's input stays blocked.
 *
 * Since crewly#1014 the harness types into an agent only when its input box
 * is readable and empty, and presses Enter only on text it can prove it
 * wrote. A refused message goes back on the agent's queue
 * (`[INPUT_NOT_OURS]`). The queue otherwise drains only on registration or
 * on a busy→idle change — an agent sitting idle in front of a box holding
 * someone's half-typed text would never get it. This service:
 *
 * - retries on a timer while the queue is non-empty and the agent is idle,
 *   with backoff (15 s → 2 min);
 * - after a few minutes or a few refusals, tells the owner/orchestrator once
 *   per blocked episode what kind of content blocks it (never the text: a
 *   box can hold a password or a code);
 * - clears its state when a delivery to the agent succeeds;
 * - sends at most one alert per agent per NOTIFY_COOLDOWN_MS (30 min). The
 *   one exception: an alert the owner must act on (box unreadable or holding
 *   someone's text) still goes out once after an informational "busy in a
 *   long turn" alert in the same window — the FYI must not hide a real block.
 *
 * @module services/messaging/input-blocked-retry.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { INPUT_BLOCKED_RETRY_CONSTANTS, TUI_INPUT_GUARD } from '../../constants.js';

/** What the guard saw when it refused. */
export interface InputRefusal {
	/** `unknown` (unreadable), `foreign` (someone else's text), or `busy` (held while the agent looked mid-turn) */
	state: string;
	/** How many characters the box held (its text is never kept or shown) */
	inputLength: number;
	/** The message that was held */
	message: string;
}

/** A blocked episode, as passed to the notifier. */
export interface InputBlockedNotice {
	sessionName: string;
	/**
	 * What blocks it: `foreign` / `unknown` (refusals), `busy`, `stuck`, or
	 * `circuit-open` (refused for so long that automatic redelivery was
	 * slowed to a probe now and then — crewly#1028); `blockedState` then
	 * says what the box held.
	 */
	state: string;
	/** With `circuit-open`: the guard reading that kept refusing */
	blockedState?: string;
	/** How many characters of text not written by Crewly the box held */
	inputLength: number;
	refusals: number;
	blockedForMs: number;
	/** The first held message (to find its origin) */
	message: string;
}

/** Collaborators (wired in index.ts). */
export interface InputBlockedRetryDeps {
	/** Messages still queued for the agent */
	hasQueued(sessionName: string): boolean;
	/** The agent is not in a turn */
	isIdle(sessionName: string): boolean;
	/** Deliver the agent's queued messages now */
	flush(sessionName: string): Promise<void>;
	/** Tell the owner / orchestrator once */
	notify(notice: InputBlockedNotice): Promise<void>;
}

/** One blocked agent. */
interface Episode {
	firstAt: number;
	refusals: number;
	attempt: number;
	notified: boolean;
	last: InputRefusal;
	firstMessage: string;
	timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Retries held messages and reports agents whose input stays blocked.
 */
export class InputBlockedRetryService {
	private static instance: InputBlockedRetryService | null = null;
	private deps: InputBlockedRetryDeps | null = null;
	private readonly episodes = new Map<string, Episode>();
	/** Agents whose long busy hold was already reported (until a delivery) */
	private readonly busyHoldNotified = new Set<string>();
	/** Agents whose blocked input was already reported via the circuit breaker (until a delivery) */
	private readonly circuitNotified = new Set<string>();
	/** Last alert sent per agent, for the per-agent cooldown (survives deliveries) */
	private readonly lastAlert = new Map<string, { at: number; actionable: boolean }>();
	private readonly logger: ComponentLogger;
	private readonly now: () => number;

	/**
	 * @param now - Clock (tests)
	 */
	constructor(now: () => number = Date.now) {
		this.logger = LoggerService.getInstance().createComponentLogger('InputBlockedRetry');
		this.now = now;
	}

	/**
	 * The process-wide service.
	 *
	 * @returns The singleton
	 */
	static getInstance(): InputBlockedRetryService {
		if (!InputBlockedRetryService.instance) InputBlockedRetryService.instance = new InputBlockedRetryService();
		return InputBlockedRetryService.instance;
	}

	/**
	 * Replace the singleton (tests).
	 *
	 * @param service - The service, or null to rebuild lazily
	 */
	static setInstance(service: InputBlockedRetryService | null): void {
		InputBlockedRetryService.instance?.stop();
		InputBlockedRetryService.instance = service;
	}

	/**
	 * Wire collaborators. Without them refusals are only counted.
	 *
	 * @param deps - Collaborators
	 */
	setDeps(deps: InputBlockedRetryDeps): void {
		this.deps = deps;
	}

	/**
	 * The guard refused to deliver to this agent; the message is queued.
	 *
	 * @param sessionName - The agent
	 * @param refusal - What the guard saw
	 */
	noteRefusal(sessionName: string, refusal: InputRefusal): void {
		const ep = this.episodes.get(sessionName) ?? {
			firstAt: this.now(),
			refusals: 0,
			attempt: 0,
			notified: false,
			last: refusal,
			firstMessage: refusal.message,
			timer: null,
		};
		ep.refusals += 1;
		ep.last = refusal;
		this.episodes.set(sessionName, ep);
		void this.maybeNotify(sessionName, ep);
		this.schedule(sessionName, ep);
	}

	/**
	 * Messages to this agent are being held because it looks mid-turn. A
	 * hold that lasts BUSY_HOLD_NOTIFY_MS is reported once (until the next
	 * delivery): an agent that looks busy for that long may be stuck, and
	 * nothing else would say so.
	 *
	 * @param sessionName - The agent
	 * @param heldForMs - How long messages have been held for it
	 * @param message - The first held message
	 */
	noteBusyHold(sessionName: string, heldForMs: number, message: string): void {
		if (heldForMs < TUI_INPUT_GUARD.BUSY_HOLD_NOTIFY_MS || this.busyHoldNotified.has(sessionName) || !this.deps) return;
		this.busyHoldNotified.add(sessionName);
		if (!this.claimAlert(sessionName, false)) return;
		this.logger.warn('Messages held for a long time: the agent has looked mid-turn throughout', { sessionName, heldForMs });
		void this.deps
			.notify({ sessionName, state: 'busy', inputLength: 0, refusals: 0, blockedForMs: heldForMs, message })
			.catch(() => undefined);
	}

	/**
	 * An idle agent's input box has held text the harness cannot attribute
	 * (not provably its own pastes, though no outside input arrived since
	 * them) for STUCK_INPUT_NOTIFY_MS. Reported once; nothing is submitted.
	 *
	 * @param sessionName - The agent
	 * @param inputLength - Characters in the box (never the text)
	 * @param forMs - How long it has been there
	 */
	noteStuckInput(sessionName: string, inputLength: number, forMs: number): void {
		if (!this.deps) return;
		if (!this.claimAlert(sessionName, true)) return;
		void this.deps
			.notify({ sessionName, state: 'stuck', inputLength, refusals: 0, blockedForMs: forMs, message: '' })
			.catch(() => undefined);
	}

	/**
	 * The input circuit breaker opened for this agent: every delivery has
	 * been refused for a while and automatic redelivery is now only a probe
	 * now and then (crewly#1028). Tells the owner once per blocked episode —
	 * unless this episode was already reported, so one blocked box is one
	 * alert, not two.
	 *
	 * @param sessionName - The agent
	 * @param info - What the breaker saw
	 */
	noteCircuitOpen(sessionName: string, info: { state: string; inputLength: number; refusals: number; blockedForMs: number }): void {
		const ep = this.episodes.get(sessionName);
		if (ep?.notified || this.circuitNotified.has(sessionName)) {
			this.logger.warn('Agent input still blocked — automatic redelivery slowed (already reported)', { sessionName, refusals: info.refusals });
			return;
		}
		if (ep) ep.notified = true;
		this.circuitNotified.add(sessionName);
		if (!this.deps) return;
		if (!this.claimAlert(sessionName, true)) return;
		this.logger.error('Agent input blocked — automatic redelivery slowed, telling the owner', { sessionName, ...info });
		void this.deps
			.notify({
				sessionName,
				state: 'circuit-open',
				blockedState: info.state,
				inputLength: info.inputLength,
				refusals: info.refusals,
				blockedForMs: info.blockedForMs,
				message: ep?.firstMessage ?? '',
			})
			.catch(() => undefined);
	}

	/**
	 * A delivery to this agent went through: the episode is over.
	 *
	 * @param sessionName - The agent
	 */
	noteDelivered(sessionName: string): void {
		this.busyHoldNotified.delete(sessionName);
		this.circuitNotified.delete(sessionName);
		const ep = this.episodes.get(sessionName);
		if (!ep) return;
		if (ep.timer) clearTimeout(ep.timer);
		this.episodes.delete(sessionName);
		this.logger.info('Agent input unblocked — held messages are flowing again', { sessionName, refusals: ep.refusals });
	}

	/**
	 * Whether an agent is in a blocked episode.
	 *
	 * @param sessionName - The agent
	 * @returns True while blocked
	 */
	isBlocked(sessionName: string): boolean {
		return this.episodes.has(sessionName);
	}

	/**
	 * Stop all timers (shutdown, tests).
	 */
	stop(): void {
		for (const ep of this.episodes.values()) if (ep.timer) clearTimeout(ep.timer);
		this.episodes.clear();
	}

	/**
	 * Schedule the next retry with backoff, unless one is pending.
	 *
	 * @param sessionName - The agent
	 * @param ep - Its episode
	 */
	private schedule(sessionName: string, ep: Episode): void {
		if (ep.timer || !this.deps) return;
		const delays = INPUT_BLOCKED_RETRY_CONSTANTS.RETRY_DELAYS_MS;
		const wait = delays[Math.min(ep.attempt, delays.length - 1)];
		ep.attempt += 1;
		ep.timer = setTimeout(() => {
			ep.timer = null;
			void this.retry(sessionName, ep);
		}, wait);
		ep.timer.unref?.();
	}

	/**
	 * One retry: flush the queue when the agent is idle, else wait again.
	 *
	 * @param sessionName - The agent
	 * @param ep - Its episode
	 */
	private async retry(sessionName: string, ep: Episode): Promise<void> {
		const deps = this.deps;
		if (!deps || this.episodes.get(sessionName) !== ep) return;
		if (!deps.hasQueued(sessionName)) {
			this.episodes.delete(sessionName);
			return;
		}
		if (deps.isIdle(sessionName)) {
			try {
				await deps.flush(sessionName);
			} catch (err) {
				this.logger.warn('Retry of held messages failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
			}
		}
		// Still blocked (a refusal re-queued it, or the agent was busy): again.
		if (this.episodes.get(sessionName) === ep) {
			await this.maybeNotify(sessionName, ep);
			this.schedule(sessionName, ep);
		}
	}

	/**
	 * Whether an alert about this agent may go out now, and if so record it.
	 * One alert per agent per NOTIFY_COOLDOWN_MS; an actionable alert may
	 * still follow an informational one (a long-turn notice) in that window.
	 *
	 * @param sessionName - The agent
	 * @param actionable - The owner has to do something (vs. busy in a long turn)
	 * @returns True when the alert may be sent
	 */
	private claimAlert(sessionName: string, actionable: boolean): boolean {
		const now = this.now();
		const last = this.lastAlert.get(sessionName);
		if (last && now - last.at < INPUT_BLOCKED_RETRY_CONSTANTS.NOTIFY_COOLDOWN_MS && (last.actionable || !actionable)) {
			this.logger.info('Input-blocked alert not sent: one already went out for this agent recently', {
				sessionName,
				actionable,
				sinceLastMs: now - last.at,
			});
			return false;
		}
		this.lastAlert.set(sessionName, { at: now, actionable });
		return true;
	}

	/**
	 * Tell someone once per episode, after long enough or often enough.
	 *
	 * @param sessionName - The agent
	 * @param ep - Its episode
	 */
	private async maybeNotify(sessionName: string, ep: Episode): Promise<void> {
		if (ep.notified || !this.deps) return;
		if (this.circuitNotified.has(sessionName)) {
			ep.notified = true;
			return;
		}
		const blockedForMs = this.now() - ep.firstAt;
		if (blockedForMs < INPUT_BLOCKED_RETRY_CONSTANTS.NOTIFY_AFTER_MS && ep.refusals < INPUT_BLOCKED_RETRY_CONSTANTS.NOTIFY_AFTER_REFUSALS) return;
		ep.notified = true;
		if (!this.claimAlert(sessionName, true)) return;
		const notice: InputBlockedNotice = {
			sessionName,
			state: ep.last.state,
			inputLength: ep.last.inputLength,
			refusals: ep.refusals,
			blockedForMs,
			message: ep.firstMessage,
		};
		this.logger.error('Agent input blocked — telling the owner', { ...notice, message: undefined });
		try {
			await this.deps.notify(notice);
		} catch (err) {
			this.logger.warn('Could not send the input-blocked notice', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
	}
}
