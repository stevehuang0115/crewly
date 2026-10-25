/**
 * Network status — notices when this machine has lost the internet.
 *
 * Several services talk to Crewly Cloud (relay WebSocket, sync heartbeat,
 * Slack registry). When the network is gone they all fail together, every
 * minute, for as long as the outage lasts. Each one used to retry and log on
 * its own; nothing knew the machine was simply offline. On 2026-10-25 a 3 h
 * outage produced ~900 identical log lines, 183 attempts to DM the owner
 * through a Slack that was equally unreachable, and seven wake cycles that
 * started two agents into a Claude CLI which could not reach its API.
 *
 * This service is the single judgement. Callers report their failures and
 * successes; the breaker trips after a few consecutive route/DNS-level errors
 * (`ENOTFOUND`, `ENETUNREACH`, …) and resets on the first success. Only those
 * codes count: a Cloud 5xx or a refused connection means Cloud is down, not
 * the network, and local agents must keep working through that.
 *
 * Consumers:
 * - the reconciler skips `start`/`rehydrate` wakes while offline,
 * - the Cloud disconnect notice does not try to DM the owner while offline,
 * - repeat failure logs drop to debug after the first one per source,
 *   with one "still offline" line per 10 minutes.
 */

import { EventEmitter } from 'events';
import { NETWORK_STATUS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from './logger.service.js';

/** Snapshot of the breaker, for `/health`-style reporting and tests. */
export interface NetworkStatus {
	/** The machine is judged to be offline */
	offline: boolean;
	/** When the current offline episode began (ISO), while offline */
	offlineSince?: string;
	/** Consecutive qualifying failures so far */
	consecutiveFailures: number;
	/** Source of the most recent qualifying failure */
	lastFailureSource?: string;
	/** Error code of the most recent qualifying failure */
	lastErrorCode?: string;
}

/**
 * Find a network error code on an error or any of its `cause` links.
 *
 * `fetch` (undici) throws `TypeError: fetch failed` with the real
 * `ENOTFOUND` on `error.cause`; `ws` puts the code on the error itself. Also
 * falls back to the message text, because some callers rethrow with a string.
 *
 * @param error - Whatever was thrown
 * @returns The first code from {@link NETWORK_STATUS_CONSTANTS.OFFLINE_ERROR_CODES} found, or null
 */
export function extractOfflineErrorCode(error: unknown): string | null {
	const codes: readonly string[] = NETWORK_STATUS_CONSTANTS.OFFLINE_ERROR_CODES;
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		if (typeof current === 'object') {
			const code = (current as { code?: unknown }).code;
			if (typeof code === 'string' && codes.includes(code)) return code;
			const message = (current as { message?: unknown }).message;
			if (typeof message === 'string') {
				const hit = codes.find((c) => message.includes(c));
				if (hit) return hit;
			}
			current = (current as { cause?: unknown }).cause;
		} else if (typeof current === 'string') {
			const hit = codes.find((c) => current === c || (current as string).includes(c));
			return hit ?? null;
		} else {
			break;
		}
	}
	return null;
}

/**
 * Process-wide offline breaker. Emits `offline` (with the status) when it
 * trips and `online` (with the outage length in ms) when the network is back.
 */
export class NetworkStatusService extends EventEmitter {
	private static instance: NetworkStatusService | null = null;
	private readonly logger: ComponentLogger;
	private consecutiveFailures = 0;
	private offlineSinceMs: number | null = null;
	private lastFailureSource?: string;
	private lastErrorCode?: string;
	/** Per source: when it last got a full-volume log line */
	private readonly lastLoggedAt = new Map<string, number>();
	/** Clock, replaceable in tests */
	now: () => number = () => Date.now();

	private constructor() {
		super();
		this.logger = LoggerService.getInstance().createComponentLogger('NetworkStatus');
	}

	/**
	 * Singleton accessor.
	 *
	 * @returns The process-wide instance
	 */
	static getInstance(): NetworkStatusService {
		if (!NetworkStatusService.instance) NetworkStatusService.instance = new NetworkStatusService();
		return NetworkStatusService.instance;
	}

	/** Drop the singleton (tests). */
	static resetInstance(): void {
		NetworkStatusService.instance = null;
	}

	/**
	 * Report a failed network call.
	 *
	 * Only errors carrying one of the offline codes count toward the breaker;
	 * anything else (HTTP status, refused connection, timeout) is ignored, so a
	 * Cloud outage never looks like a lost network.
	 *
	 * @param source - Short caller name, e.g. `relay`, `cloud-sync`
	 * @param error - The error that was thrown
	 * @returns true when the failure counted (an offline-class error)
	 */
	recordFailure(source: string, error: unknown): boolean {
		const code = extractOfflineErrorCode(error);
		if (!code) return false;
		this.consecutiveFailures++;
		this.lastFailureSource = source;
		this.lastErrorCode = code;
		if (this.offlineSinceMs === null && this.consecutiveFailures >= NETWORK_STATUS_CONSTANTS.OFFLINE_AFTER_FAILURES) {
			this.offlineSinceMs = this.now();
			this.logger.warn('Network appears to be offline — wakes and owner DMs paused until it is back', {
				source,
				code,
				failures: this.consecutiveFailures,
			});
			this.emit('offline', this.getStatus());
		}
		return true;
	}

	/**
	 * Report a successful network call. Ends an offline episode if one is open.
	 *
	 * @param source - Short caller name
	 */
	recordSuccess(source: string): void {
		this.consecutiveFailures = 0;
		this.lastLoggedAt.clear();
		if (this.offlineSinceMs === null) return;
		const durationMs = this.now() - this.offlineSinceMs;
		this.offlineSinceMs = null;
		this.lastFailureSource = undefined;
		this.lastErrorCode = undefined;
		this.logger.info('Network is back', { source, offlineMinutes: Math.round(durationMs / 60_000) });
		this.emit('online', durationMs);
	}

	/**
	 * Whether the machine is currently judged offline.
	 *
	 * @returns true while an offline episode is open
	 */
	isOffline(): boolean {
		return this.offlineSinceMs !== null;
	}

	/**
	 * Current breaker state.
	 *
	 * @returns A copy of the status
	 */
	getStatus(): NetworkStatus {
		return {
			offline: this.offlineSinceMs !== null,
			...(this.offlineSinceMs !== null ? { offlineSince: new Date(this.offlineSinceMs).toISOString() } : {}),
			consecutiveFailures: this.consecutiveFailures,
			...(this.lastFailureSource ? { lastFailureSource: this.lastFailureSource } : {}),
			...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
		};
	}

	/**
	 * Whether a caller should log this failure at full volume.
	 *
	 * The first failure of a source always logs; while the breaker is tripped,
	 * later ones log only once per {@link NETWORK_STATUS_CONSTANTS.REPEAT_LOG_INTERVAL_MS}
	 * so a long outage leaves one line per 10 minutes, not one per retry.
	 * Callers log at debug when this returns false.
	 *
	 * @param source - Short caller name
	 * @returns true to log at the usual level
	 */
	shouldLog(source: string): boolean {
		const now = this.now();
		const last = this.lastLoggedAt.get(source);
		if (last === undefined || !this.isOffline() || now - last >= NETWORK_STATUS_CONSTANTS.REPEAT_LOG_INTERVAL_MS) {
			this.lastLoggedAt.set(source, now);
			return true;
		}
		return false;
	}

	/**
	 * How long the current outage has lasted, for log context.
	 *
	 * @returns Whole minutes offline, or 0 when online
	 */
	offlineMinutes(): number {
		return this.offlineSinceMs === null ? 0 : Math.round((this.now() - this.offlineSinceMs) / 60_000);
	}
}
