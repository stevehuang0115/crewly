/**
 * Failed turns of the in-process Crewly Agent runtime (crewly#1015 §2).
 *
 * A turn of the in-process runtime that throws (DeepSeek "No output
 * generated", an out-of-credit account, a crashed worker) used to be logged
 * and nothing else: the message was gone, nobody was told. On 2026-10-01 the
 * orchestrator failed about 80 turns that way over ~20 hours.
 *
 * Now:
 * 1. The same message is delivered once more after RETRY_DELAY_MS (through
 *    `sendMessageToAgent`, so a runtime switch, the token cap or the
 *    restart drain can queue it instead).
 *    Not when the account is out of credit / quota (it fails the same way),
 *    and not when the agent is stopped or not running (the message is
 *    queued for its next start instead — that is no model failure).
 * 2. When that fails too, the owner messages the agent owes are parked by the
 *    owner-message watchdog (owner told once, message kept and re-delivered
 *    on a backing-off timer, never on a timer for credit / quota), and the
 *    failure is reported ONCE per episode — for a member to the
 *    orchestrator, for the orchestrator to the owner — until a turn succeeds.
 * 3. The agent's next successful turn re-delivers the parked owner messages.
 *
 * Harness text is English. The service never throws into its callers.
 *
 * @module services/agent/in-process-turn-failure.service
 * @see specs/2026-10-03-harness-drop-gaps.md §2
 */

import { createHash } from 'crypto';
import { IN_PROCESS_TURN_FAILURE_CONSTANTS as C, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** Outcome of a re-delivery (the shape `sendMessageToAgent` returns). */
export interface TurnRedeliveryResult {
	success: boolean;
	queued?: boolean;
	error?: string;
}

/** Injected behaviour. */
export interface InProcessTurnFailureDeps {
	/** Deliver the message to the agent again */
	redeliver: (sessionName: string, message: string) => Promise<TurnRedeliveryResult>;
	/**
	 * Park the owner messages the agent owes and tell the owner (watchdog
	 * `noteTurnFailed`); `needsCredit` stops timed re-deliveries.
	 */
	noteOwnerMessages?: (sessionName: string, detail: string, opts: { needsCredit: boolean }) => Promise<number>;
	/** Re-deliver parked owner messages (watchdog `resumeAfterRecovery`) */
	resumeOwnerMessages?: (sessionName: string) => Promise<number>;
	/**
	 * Report the failure: a member's to the orchestrator, the orchestrator's
	 * to the owner. `sample` is the message that failed (its origin header
	 * may name the chat it came from).
	 */
	report: (sessionName: string, text: string, sample: string) => void;
	/** The owner stopped this agent (its messages wait for its next start) */
	isOwnerStopped?: (sessionName: string) => boolean;
	/** Whether the agent's runtime is up (false: stopped / not initialised) */
	isRunning?: (sessionName: string) => boolean;
	/** Hold a message for the agent's next start (persistent queue) */
	queueForAgent?: (sessionName: string, message: string) => void;
	/**
	 * Whether the failed turn already answered where the message came from
	 * (an owner answer seen there since `since`); the retry is skipped then.
	 */
	answeredSince?: (sessionName: string, message: string, since: number) => boolean;
	/** Display name ("Orc", "Ella"); defaults to the session name */
	displayName?: (sessionName: string) => string;
	/** Clock (tests) */
	now?: () => number;
	/** Timer (tests) */
	setTimer?: (fn: () => void, ms: number) => unknown;
}

/** An error the in-process runtime rejected a turn with. */
export type TurnError = unknown;

/**
 * Whether a turn error means the account is out of credit / quota: nothing
 * helps until the owner tops up or the agent moves to another runtime.
 *
 * @param error - What the turn rejected with
 * @returns True for `billing` / `usage_limit`
 */
export function isCreditFailure(error: TurnError): boolean {
	const kind = (error as { usageLimitKind?: unknown } | null)?.usageLimitKind;
	return kind === 'billing' || kind === 'usage_limit';
}

/**
 * The reason of a failed turn in plain words, for the owner and the orchestrator.
 *
 * @param error - What the turn rejected with (`usageLimitKind` is set by the
 *   external runtime when a usage-limit rule matched its stderr)
 * @returns A short phrase
 *
 * @example
 * ```typescript
 * describeTurnError(Object.assign(new Error('No output generated.'), { usageLimitKind: 'billing' }));
 * // 'the model account is out of credit'
 * ```
 */
export function describeTurnError(error: TurnError): string {
	const kind = (error as { usageLimitKind?: unknown } | null)?.usageLimitKind;
	if (kind === 'billing') return 'the model account is out of credit';
	if (kind === 'usage_limit') return "the model's usage limit was reached";
	if (kind === 'transient') return 'the model provider is rate-limiting';
	const message = error instanceof Error ? error.message : String(error ?? '');
	if (/no output generated/i.test(message)) return 'the model returned no output';
	const one = message.replace(/\s+/g, ' ').trim();
	if (!one) return 'unknown error';
	return one.length > C.ERROR_CHARS ? `${one.slice(0, C.ERROR_CHARS)}…` : one;
}

/**
 * Retries and reports failed in-process turns.
 *
 * One report per failure EPISODE: from the first reported failure until the
 * agent completes a turn again, later failures are counted, not reported
 * (crewly#1015 review B2: ~40 notices a day while credit was out).
 */
export class InProcessTurnFailureService {
	private readonly logger: ComponentLogger;
	/** `<session>\0<message hash>` → retries made and when the first failure was */
	private readonly attempts = new Map<string, { count: number; at: number }>();
	/** Agents in a reported failure episode → failures since the report */
	private readonly failing = new Map<string, number>();

	/**
	 * @param deps - Injected behaviour
	 */
	constructor(private readonly deps: InProcessTurnFailureDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('InProcessTurnFailure');
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/**
	 * A turn threw. Retry the message once (unless it cannot help); after
	 * that, report — once per failure episode.
	 *
	 * @param sessionName - The agent
	 * @param message - The message it was handling
	 * @param error - What the turn rejected with
	 */
	onTurnFailed(sessionName: string, message: string, error: TurnError): void {
		try {
			// Stopped on purpose (by the owner) or not running: not a model
			// failure. The message waits for the agent's next start.
			if (this.agentIsDown(sessionName)) {
				this.hold(sessionName, message, 'the agent is not running');
				return;
			}
			const detail = describeTurnError(error);
			const needsCredit = isCreditFailure(error);
			this.prune();
			const key = `${sessionName}\0${createHash('sha1').update(message).digest('hex')}`;
			const seen = this.attempts.get(key);
			const count = seen?.count ?? 0;
			// Out of credit / quota: a retry in a minute fails the same way.
			if (!needsCredit && count < C.MAX_RETRIES) {
				const failedAt = this.now();
				this.attempts.set(key, { count: count + 1, at: seen?.at ?? failedAt });
				this.logger.warn('In-process turn failed — delivering the message once more', {
					sessionName,
					detail,
					inSeconds: Math.round(C.RETRY_DELAY_MS / 1000),
				});
				const timer = (this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(
					() => void this.retry(sessionName, message, detail, failedAt),
					C.RETRY_DELAY_MS,
				);
				(timer as { unref?: () => void } | null)?.unref?.();
				return;
			}
			// The key is kept (until ATTEMPT_TTL_MS): a later failure of this
			// same message goes straight here, without another retry.
			if (!seen) this.attempts.set(key, { count, at: this.now() });
			this.giveUp(sessionName, message, detail, needsCredit, 'failed');
		} catch (err) {
			this.logger.warn('Handling a failed in-process turn failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * A turn completed: the failure episode is over. The parked owner
	 * messages are re-delivered.
	 *
	 * @param sessionName - The agent
	 */
	onTurnSucceeded(sessionName: string): void {
		const since = this.failing.get(sessionName);
		if (since === undefined) return;
		this.failing.delete(sessionName);
		this.logger.info('In-process agent completed a turn again after failures', { sessionName, failuresSinceReport: since });
		void (this.deps.resumeOwnerMessages?.(sessionName) ?? Promise.resolve(0)).catch((err: unknown) =>
			this.logger.warn('Could not re-deliver parked owner messages', { sessionName, error: err instanceof Error ? err.message : String(err) }),
		);
	}

	private agentIsDown(sessionName: string): boolean {
		try {
			if (this.deps.isOwnerStopped?.(sessionName)) return true;
			return this.deps.isRunning ? !this.deps.isRunning(sessionName) : false;
		} catch {
			return false;
		}
	}

	private hold(sessionName: string, message: string, why: string): void {
		try {
			this.deps.queueForAgent?.(sessionName, message);
		} catch (err) {
			this.logger.warn('Could not queue the message for the stopped agent', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
		this.logger.info('Turn not completed and not retried — message queued for the agent\'s next start', { sessionName, why });
	}

	private async retry(sessionName: string, message: string, detail: string, failedAt: number): Promise<void> {
		// The failed turn may have answered before it threw: a second turn
		// would answer twice (crewly#1015 review H3).
		try {
			if (this.deps.answeredSince?.(sessionName, message, failedAt - C.RETRY_DELAY_MS)) {
				this.logger.info('Failed turn had already answered — not retrying', { sessionName });
				return;
			}
		} catch {
			/* retry */
		}
		if (this.agentIsDown(sessionName)) {
			this.hold(sessionName, message, 'the agent stopped before the retry');
			return;
		}
		let result: TurnRedeliveryResult;
		try {
			result = await this.deps.redeliver(sessionName, message);
		} catch (err) {
			result = { success: false, error: err instanceof Error ? err.message : String(err) };
		}
		// Delivered (its turn reports again if it fails) or queued (a runtime
		// switch, the token cap, the drain — that queue reports its drops).
		if (result.success || result.queued) return;
		if (this.agentIsDown(sessionName)) {
			this.hold(sessionName, message, 'the agent stopped before the retry');
			return;
		}
		this.giveUp(sessionName, message, `${detail}; delivering it again failed: ${result.error ?? 'unknown error'}`, false, 'undeliverable');
	}

	private giveUp(sessionName: string, message: string, detail: string, needsCredit: boolean, how: 'failed' | 'undeliverable'): void {
		this.logger.error('In-process turn failed again', { sessionName, detail, needsCredit, messagePreview: preview(message, 80) });
		void (this.deps.noteOwnerMessages?.(sessionName, detail, { needsCredit }) ?? Promise.resolve(0)).catch((err: unknown) =>
			this.logger.warn('Could not tell the owner about a failed turn', { sessionName, error: err instanceof Error ? err.message : String(err) }),
		);
		const since = this.failing.get(sessionName);
		if (since !== undefined) {
			// Same episode: already reported.
			this.failing.set(sessionName, since + 1);
			return;
		}
		this.failing.set(sessionName, 0);
		const name = this.deps.displayName?.(sessionName) || sessionName;
		const what =
			how === 'failed'
				? needsCredit
					? `${name}'s model run failed (${detail}).`
					: `${name}'s model run failed twice on the same message (${detail}).`
				: `${name}'s model run failed and the message could not be delivered to it again (${detail}).`;
		const consequence =
			sessionName === ORCHESTRATOR_SESSION_NAME
				? ' Until this is fixed the orchestrator answers nothing; your own messages to it are kept and re-delivered once it works again.'
				: ` Owner messages ${name} owes are kept and re-delivered once it works again; anything else sent to ${name} needs sending again.`;
		const text = `${what} The message was: "${preview(message, C.PREVIEW_CHARS)}".${consequence} No further notices until it completes a run.`;
		try {
			this.deps.report(sessionName, text, message);
		} catch (err) {
			this.logger.warn('Could not report a failed turn', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
	}

	private prune(): void {
		const cutoff = this.now() - C.ATTEMPT_TTL_MS;
		for (const [k, v] of this.attempts) if (v.at < cutoff) this.attempts.delete(k);
	}
}

/**
 * One-line preview of a message, without its routing header.
 *
 * @param message - Message text
 * @param max - Limit
 * @returns Preview
 */
function preview(message: string, max: number): string {
	let body = message;
	for (;;) {
		const next = body.replace(/^\s*\[(?:G?CHAT|SLACK|SLACK-THREAD)[^\]]*\]\s*/, '');
		if (next === body) break;
		body = next;
	}
	body = body.replace(/\s+/g, ' ').trim();
	return body.length > max ? `${body.slice(0, max)}…` : body;
}

let instance: InProcessTurnFailureService | null = null;

/** @returns The wired service, or null before boot (and in tests) */
export function getInProcessTurnFailureService(): InProcessTurnFailureService | null {
	return instance;
}

/** @param service - The service to expose (null to clear) */
export function setInProcessTurnFailureService(service: InProcessTurnFailureService | null): void {
	instance = service;
}
