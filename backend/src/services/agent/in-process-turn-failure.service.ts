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
 * 2. When that fails too, the owner messages the agent owes are parked by the
 *    owner-message watchdog (owner told once, message kept and re-delivered),
 *    and the failure is reported — for a member to the orchestrator, for the
 *    orchestrator to the owner — at most once per agent per
 *    NOTICE_COOLDOWN_MS, counting what failed in between.
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
	/** Park the owner messages the agent owes and tell the owner (watchdog `noteTurnFailed`) */
	noteOwnerMessages?: (sessionName: string, detail: string) => Promise<number>;
	/** Re-deliver parked owner messages (watchdog `resumeAfterRecovery`) */
	resumeOwnerMessages?: (sessionName: string) => Promise<number>;
	/**
	 * Report the failure: a member's to the orchestrator, the orchestrator's
	 * to the owner. `sample` is the message that failed (its origin header
	 * may name the chat it came from).
	 */
	report: (sessionName: string, text: string, sample: string) => void;
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
 */
export class InProcessTurnFailureService {
	private readonly logger: ComponentLogger;
	/** `<session>\0<message hash>` → re-deliveries made and when the first failure was */
	private readonly attempts = new Map<string, { count: number; at: number }>();
	/** Per agent: when it was last reported, and failures since */
	private readonly notices = new Map<string, { lastAt: number; since: number }>();
	/** Agents with a reported failure and no successful turn since */
	private readonly failing = new Set<string>();

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
	 * A turn threw. Retry the message once; after that, report.
	 *
	 * @param sessionName - The agent
	 * @param message - The message it was handling
	 * @param error - What the turn rejected with
	 */
	onTurnFailed(sessionName: string, message: string, error: TurnError): void {
		try {
			const detail = describeTurnError(error);
			this.prune();
			const key = `${sessionName}\0${createHash('sha1').update(message).digest('hex')}`;
			const seen = this.attempts.get(key);
			const count = seen?.count ?? 0;
			if (count < C.MAX_RETRIES) {
				this.attempts.set(key, { count: count + 1, at: seen?.at ?? this.now() });
				this.logger.warn('In-process turn failed — delivering the message once more', {
					sessionName,
					detail,
					inSeconds: Math.round(C.RETRY_DELAY_MS / 1000),
				});
				const timer = (this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => void this.retry(sessionName, message, detail), C.RETRY_DELAY_MS);
				(timer as { unref?: () => void } | null)?.unref?.();
				return;
			}
			this.attempts.delete(key);
			this.giveUp(sessionName, message, detail);
		} catch (err) {
			this.logger.warn('Handling a failed in-process turn failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
		}
	}

	/**
	 * A turn completed. An agent whose turns were failing gets its parked
	 * owner messages again.
	 *
	 * @param sessionName - The agent
	 */
	onTurnSucceeded(sessionName: string): void {
		if (!this.failing.delete(sessionName)) return;
		this.logger.info('In-process agent completed a turn again after failures', { sessionName });
		void (this.deps.resumeOwnerMessages?.(sessionName) ?? Promise.resolve(0)).catch((err: unknown) =>
			this.logger.warn('Could not re-deliver parked owner messages', { sessionName, error: err instanceof Error ? err.message : String(err) }),
		);
	}

	private async retry(sessionName: string, message: string, detail: string): Promise<void> {
		let result: TurnRedeliveryResult;
		try {
			result = await this.deps.redeliver(sessionName, message);
		} catch (err) {
			result = { success: false, error: err instanceof Error ? err.message : String(err) };
		}
		// Delivered (its turn reports again if it fails) or queued (a runtime
		// switch, the token cap, the drain — that queue reports its drops).
		if (result.success || result.queued) return;
		this.giveUp(sessionName, message, `${detail}; the retry could not be delivered: ${result.error ?? 'unknown error'}`);
	}

	private giveUp(sessionName: string, message: string, detail: string): void {
		this.failing.add(sessionName);
		this.logger.error('In-process turn failed again — reporting it', { sessionName, detail, messagePreview: preview(message, 80) });
		void (this.deps.noteOwnerMessages?.(sessionName, detail) ?? Promise.resolve(0)).catch((err: unknown) =>
			this.logger.warn('Could not tell the owner about a failed turn', { sessionName, error: err instanceof Error ? err.message : String(err) }),
		);
		const now = this.now();
		const notice = this.notices.get(sessionName) ?? { lastAt: Number.NEGATIVE_INFINITY, since: 0 };
		if (now - notice.lastAt < C.NOTICE_COOLDOWN_MS) {
			notice.since += 1;
			this.notices.set(sessionName, notice);
			return;
		}
		const name = this.deps.displayName?.(sessionName) || sessionName;
		const others = notice.since > 0 ? ` ${notice.since} more failed run(s) since the last notice.` : '';
		const consequence =
			sessionName === ORCHESTRATOR_SESSION_NAME
				? ' Until this is fixed the orchestrator answers nothing; your own messages to it are kept and re-delivered.'
				: ` Owner messages ${name} owes are kept and re-delivered; anything else sent to ${name} needs sending again once it works.`;
		const text = `${name}'s model run failed twice on the same message (${detail}).${others} The message was: "${preview(message, C.PREVIEW_CHARS)}".${consequence}`;
		this.notices.set(sessionName, { lastAt: now, since: 0 });
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
