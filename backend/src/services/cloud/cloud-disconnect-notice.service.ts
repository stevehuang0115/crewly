/**
 * Cloud disconnect notice — tells the owner on Slack when this machine has
 * lost Crewly Cloud, and lets them fix it from their phone.
 *
 * Why: inbound Slack reaches a machine only through Cloud → relay. When a
 * machine's Cloud sign-in expires (or Cloud is unreachable) its agents can
 * still post, but every message to them queues in Cloud unseen. On
 * 2026-09-27 a second Mac sat like that for hours; nobody was told, and the
 * owner — never at the machine — could not fix it remotely.
 *
 * What it does, once a minute:
 * 1. Detect ({@link evaluateDisconnect}): signed in (a Cloud config exists)
 *    AND (sync is `auth_expired` OR Cloud has not answered for 15 min OR the
 *    relay has refused this machine a message queue for 2 min — e.g. 429
 *    quota_exceeded, when heartbeats still succeed but nothing arrives).
 * 2. When the sign-in is the problem, run `crewly cloud login --no-browser`
 *    in a PTY ({@link startCloudLogin}) — the same device pairing the owner
 *    would run by hand — and take the approve link it prints.
 * 3. DM the owner through the Slack Web API with the bot tokens this machine
 *    already holds (outbound needs no Cloud), link included.
 * 4. The CLI waits for the approval and saves the credentials itself; then
 *    CloudSync is restarted and the owner gets 「已重新连上 Cloud…」.
 *    If the CLI asks for typed input, the owner's reply is read straight from
 *    the DM (`conversations.history`) — it cannot arrive through Cloud.
 *
 * Rate limit: one notice per disconnect episode, repeated at most every 6 h,
 * persisted under the Crewly home so a restart does not re-notify (relay
 * queue failures: at most every 6 h across episodes too, so a flapping
 * registration does not DM the owner each time). An
 * expired link is replaced by editing the same message (no new
 * notification); a failed login gets one brief note and waits for the next
 * window. Kill switch: `CREWLY_CLOUD_DISCONNECT_NOTICE=0`.
 *
 * @module services/cloud/cloud-disconnect-notice.service
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLOUD_DISCONNECT_NOTICE_CONSTANTS } from '../../../../config/constants.js';
import { LoggerService } from '../core/logger.service.js';
import { resolveRunningPackageRoot } from '../system/auto-update.utils.js';
import type { OwnerDirectDm } from '../slack/slack-owner-direct-dm.js';
import { CloudClientService } from './cloud-client.service.js';
import { CloudSyncService } from './cloud-sync.service.js';
import type { CloudSyncHealth } from './cloud-sync.types.js';
import { isCloudLoginFinished, startCloudLogin, type CloudLoginHandle, type CloudLoginSnapshot } from './cloud-login-runner.js';
import {
	RECONNECTED_NOTICE,
	clearNoticeState,
	composeDisconnectNotice,
	composeLoginFailedNotice,
	evaluateDisconnect,
	readLastRelayQueueNotice,
	readNoticeState,
	shouldNotify,
	writeLastRelayQueueNotice,
	writeNoticeState,
	type DisconnectNoticeState,
	type DisconnectReason,
} from './cloud-disconnect-notice.utils.js';

const C = CLOUD_DISCONNECT_NOTICE_CONSTANTS;

/** Minimal logger. */
export interface DisconnectNoticeLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** Everything the service touches outside itself. */
export interface CloudDisconnectNoticeDeps {
	/** State file (`<crewlyHome>/cloud/disconnect-notice.json`) */
	stateFile: string;
	/**
	 * When the owner last heard about a relay-queue failure
	 * (`<crewlyHome>/cloud/relay-queue-notice.json`). Outlives the episode so a
	 * flapping registration is reported at most once per repeat interval.
	 * Omitted = per-episode limit only.
	 */
	relayQueueNoticeFile?: string;
	/** A Cloud config exists (signed in, not logged out) */
	isSignedIn: () => Promise<boolean>;
	/** CloudSyncService health */
	getHealth: () => CloudSyncHealth;
	/** This machine's name */
	getDeviceName: () => Promise<string>;
	/** Owner DM over the bot token, or null when Slack is not configured here */
	getDm: () => OwnerDirectDm | null;
	/** Start `crewly cloud login` in a PTY (throws when it cannot) */
	startLogin: () => CloudLoginHandle;
	/** After a successful CLI login: make sure CloudSync runs on the new credentials */
	reconnect: () => Promise<boolean>;
	logger: DisconnectNoticeLogger;
	now: () => number;
	schedule: (fn: () => void, ms: number) => unknown;
	cancel: (handle: unknown) => void;
	thresholdMs?: number;
	/** Relay queue registration failing this long = disconnected (default 2 min) */
	queueThresholdMs?: number;
	repeatMs?: number;
	checkIntervalMs?: number;
	linkWaitMs?: number;
	loginRetryMs?: number;
	replyPollMs?: number;
	replyMaxWaitMs?: number;
}

/**
 * Owner-facing text for how a login run ended.
 *
 * @param snapshot - The finished run
 * @returns Short English reason
 */
function loginFailureDetail(snapshot: CloudLoginSnapshot): string {
	if (snapshot.state === 'timed_out') return 'it timed out';
	if (snapshot.state === 'expired') return 'the link expired';
	if (snapshot.message && /denied/i.test(snapshot.message)) return 'sign-in was denied';
	return 'the sign-in command failed';
}

/** Watches the Cloud connection and DMs the owner when it is lost. */
export class CloudDisconnectNoticeService {
	private readonly thresholdMs: number;
	private readonly queueThresholdMs: number;
	private readonly repeatMs: number;
	private readonly checkIntervalMs: number;
	private readonly linkWaitMs: number;
	private readonly loginRetryMs: number;
	private readonly replyPollMs: number;
	private readonly replyMaxWaitMs: number;
	private monitorStartedAt = 0;
	private timer: unknown = null;
	private stopped = true;
	private ticking = false;
	private login: CloudLoginHandle | null = null;
	private lastLoginAttemptAt = 0;
	private replyTimer: unknown = null;
	private replyDeadline = 0;
	private lastReplyTs: string | null = null;
	/** Where the current notice is (for reading the owner's replies) */
	private notice: { channelId: string; ts: string } | null = null;
	/** Serialises checks and login outcomes so neither overwrites the other's state */
	private chain: Promise<void> = Promise.resolve();

	/**
	 * @param deps - Collaborators (see {@link CloudDisconnectNoticeDeps})
	 */
	constructor(private readonly deps: CloudDisconnectNoticeDeps) {
		this.thresholdMs = deps.thresholdMs ?? C.DISCONNECT_THRESHOLD_MS;
		this.queueThresholdMs = deps.queueThresholdMs ?? C.QUEUE_FAILURE_THRESHOLD_MS;
		this.repeatMs = deps.repeatMs ?? C.REPEAT_INTERVAL_MS;
		this.checkIntervalMs = deps.checkIntervalMs ?? C.CHECK_INTERVAL_MS;
		this.linkWaitMs = deps.linkWaitMs ?? C.LINK_WAIT_MS;
		this.loginRetryMs = deps.loginRetryMs ?? C.LOGIN_RETRY_MS;
		this.replyPollMs = deps.replyPollMs ?? C.REPLY_POLL_INTERVAL_MS;
		this.replyMaxWaitMs = deps.replyMaxWaitMs ?? C.REPLY_MAX_WAIT_MS;
	}

	/** Start checking every minute. */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.monitorStartedAt = this.deps.now();
		this.scheduleNext();
	}

	/** Stop checking and kill any login run. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.deps.cancel(this.timer);
		this.timer = null;
		this.stopReplyPolling();
		this.login?.cancel();
		this.login = null;
	}

	/**
	 * One check. Public for tests; the timer calls it every minute.
	 *
	 * @returns Resolves when the check (and any notice) is done
	 */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.serial(() => this.check());
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Run `fn` after every earlier check / login outcome has finished.
	 *
	 * @param fn - Work that reads and writes the state file
	 * @returns Resolves when `fn` is done (never rejects)
	 */
	private serial(fn: () => Promise<void>): Promise<void> {
		const run = this.chain.then(fn).catch((error: unknown) => {
			this.deps.logger.warn('Cloud disconnect check failed', { error: error instanceof Error ? error.message : String(error) });
		});
		this.chain = run;
		return run;
	}

	/**
	 * The check itself: detect, then notify, refresh the link, or close the episode.
	 */
	private async check(): Promise<void> {
		const now = this.deps.now();
		const verdict = evaluateDisconnect({
			signedIn: await this.deps.isSignedIn(),
			health: this.deps.getHealth(),
			monitorStartedAt: this.monitorStartedAt || now,
			now,
			thresholdMs: this.thresholdMs,
			queueThresholdMs: this.queueThresholdMs,
		});
		const state = readNoticeState(this.deps.stateFile);

		if (verdict.status === 'signed_out') {
			// Logged out on purpose: nothing to tell, nothing to fix.
			if (state) await this.endEpisode(false);
			return;
		}
		if (verdict.status === 'connected') {
			if (state) await this.endEpisode(true);
			return;
		}
		if (verdict.status !== 'disconnected') return;

		const current: DisconnectNoticeState = state ?? {
			episodeStartedAt: new Date(verdict.since).toISOString(),
			reason: verdict.reason,
			lastNotifiedAt: null,
		};
		current.reason = verdict.reason;
		if (current.channelId && current.messageTs) this.notice = { channelId: current.channelId, ts: current.messageTs };

		if (shouldNotify(state, now, this.repeatMs)) {
			await this.sendNotice(current, verdict.reason, verdict.detail ?? null);
		} else if (this.shouldRefreshLink(current, now)) {
			await this.refreshLink(current);
		}
		writeNoticeState(this.deps.stateFile, current);
	}

	/**
	 * Send the notice (first of the episode, or the 6-hourly repeat).
	 *
	 * @param state - Episode state (updated in place)
	 * @param reason - Why
	 * @param detail - Specific reason (relay_queue), e.g. `relay quota full`
	 */
	private async sendNotice(state: DisconnectNoticeState, reason: DisconnectReason, detail: string | null = null): Promise<void> {
		const now = this.deps.now();
		if (reason === 'relay_queue' && this.deps.relayQueueNoticeFile) {
			const last = readLastRelayQueueNotice(this.deps.relayQueueNoticeFile);
			if (last !== null && now - last < this.repeatMs) {
				// Told less than the repeat interval ago (an earlier episode):
				// stay quiet until that window ends.
				state.lastNotifiedAt = new Date(last).toISOString();
				state.quiet = true;
				return;
			}
		}
		const dm = this.deps.getDm();
		if (!dm) {
			this.deps.logger.warn('Disconnected from Crewly Cloud; Slack is not configured here, so the owner was not notified', { reason });
			state.lastNotifiedAt = new Date(now).toISOString();
			return;
		}
		// A new window lifts the block a failed login set.
		delete state.loginBlockedUntil;
		const link = reason === 'auth' ? await this.ensureLoginLink() : null;
		const text = composeDisconnectNotice({
			deviceName: await this.deviceName(),
			reason,
			since: Date.parse(state.episodeStartedAt),
			loginUrl: link?.url ?? null,
			userCode: link?.userCode ?? null,
			detail,
		});
		try {
			const posted = await dm.send(text);
			state.lastNotifiedAt = new Date(now).toISOString();
			delete state.quiet;
			if (reason === 'relay_queue' && this.deps.relayQueueNoticeFile) {
				writeLastRelayQueueNotice(this.deps.relayQueueNoticeFile, now);
			}
			state.channelId = posted.channelId;
			state.messageTs = posted.ts;
			state.hasLink = !!link?.url;
			this.notice = { channelId: posted.channelId, ts: posted.ts };
			this.lastReplyTs = posted.ts;
			this.deps.logger.info('Owner told that this machine is disconnected from Crewly Cloud', { reason, withLink: state.hasLink });
			if (this.login?.get().needsInput) this.startReplyPolling();
		} catch (error) {
			// Not recorded as notified: the next check tries again.
			this.deps.logger.warn('Could not DM the owner about the Cloud disconnect', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Whether to start a new login run and put its link into the notice:
	 * sign-in problem, a notice to edit, no live run, not blocked by a failed
	 * login, and not retried within the last few minutes.
	 *
	 * @param state - Episode state
	 * @param now - Now (epoch ms)
	 * @returns True to refresh
	 */
	private shouldRefreshLink(state: DisconnectNoticeState, now: number): boolean {
		if (state.reason !== 'auth' || !state.channelId || !state.messageTs) return false;
		if (this.login && !isCloudLoginFinished(this.login.get().state)) return false;
		if (state.loginBlockedUntil && Date.parse(state.loginBlockedUntil) > now) return false;
		return now - this.lastLoginAttemptAt >= this.loginRetryMs;
	}

	/**
	 * Start a login run and edit the notice to carry its link (the link in it
	 * is missing or has expired). Editing does not notify the owner again.
	 *
	 * @param state - Episode state (updated in place)
	 */
	private async refreshLink(state: DisconnectNoticeState): Promise<void> {
		const dm = this.deps.getDm();
		if (!dm || !state.channelId || !state.messageTs) return;
		const link = await this.ensureLoginLink();
		if (!link?.url) return;
		const text = composeDisconnectNotice({
			deviceName: await this.deviceName(),
			reason: 'auth',
			since: Date.parse(state.episodeStartedAt),
			loginUrl: link.url,
			userCode: link.userCode,
		});
		try {
			await dm.update(state.channelId, state.messageTs, text);
			state.hasLink = true;
			this.deps.logger.info('Cloud re-login link in the owner notice refreshed');
		} catch (error) {
			this.deps.logger.warn('Could not update the Cloud disconnect notice with a new link', { error: error instanceof Error ? error.message : String(error) });
			this.login?.cancel();
			await this.blockUntilNextWindow(state, 'the link expired');
		}
	}

	/**
	 * Start (or reuse) a CLI login run and wait briefly for its link.
	 *
	 * @returns The run's snapshot with a link, or null when none came
	 */
	private async ensureLoginLink(): Promise<CloudLoginSnapshot | null> {
		if (!this.login || isCloudLoginFinished(this.login.get().state)) {
			this.lastLoginAttemptAt = this.deps.now();
			let handle: CloudLoginHandle;
			try {
				handle = this.deps.startLogin();
			} catch (error) {
				this.deps.logger.warn('Could not start `crewly cloud login`', { error: error instanceof Error ? error.message : String(error) });
				return null;
			}
			this.login = handle;
			handle.onChange((snapshot) => {
				if (snapshot.needsInput) this.startReplyPolling();
			});
			void handle.done.then((snapshot) => this.serial(() => this.onLoginFinished(handle, snapshot)));
		}
		const snapshot = await this.login.waitForLink(this.linkWaitMs);
		return snapshot.url && !isCloudLoginFinished(snapshot.state) ? snapshot : null;
	}

	/**
	 * A login run ended.
	 *
	 * @param handle - The run
	 * @param snapshot - How it ended
	 */
	private async onLoginFinished(handle: CloudLoginHandle, snapshot: CloudLoginSnapshot): Promise<void> {
		if (this.login === handle) this.login = null;
		this.stopReplyPolling();
		if (this.stopped || snapshot.state === 'cancelled') return;
		if (snapshot.state === 'succeeded') {
			let ok = false;
			try {
				ok = await this.deps.reconnect();
			} catch (error) {
				this.deps.logger.warn('Cloud login succeeded but reconnecting failed', { error: error instanceof Error ? error.message : String(error) });
			}
			if (ok) {
				this.deps.logger.info('Reconnected to Crewly Cloud after the owner signed in again');
				await this.endEpisode(true);
			}
			return;
		}
		const state = readNoticeState(this.deps.stateFile);
		if (!state?.lastNotifiedAt) return;
		// An expired link is replaced in place by the next check when the
		// notice can be edited; anything else waits for the next window.
		if (snapshot.state === 'expired' && state.channelId && state.messageTs) {
			state.hasLink = false;
			writeNoticeState(this.deps.stateFile, state);
			return;
		}
		this.deps.logger.info('Cloud re-login did not finish', { state: snapshot.state });
		await this.blockUntilNextWindow(state, loginFailureDetail(snapshot));
		writeNoticeState(this.deps.stateFile, state);
	}

	/**
	 * Tell the owner briefly that the login did not finish, and hold further
	 * login runs until the next notice window.
	 *
	 * @param state - Episode state (updated in place)
	 * @param detail - Owner-facing reason
	 */
	private async blockUntilNextWindow(state: DisconnectNoticeState, detail: string): Promise<void> {
		const last = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : this.deps.now();
		const retryAt = last + this.repeatMs;
		state.loginBlockedUntil = new Date(retryAt).toISOString();
		state.hasLink = false;
		const dm = this.deps.getDm();
		if (!dm) return;
		try {
			await dm.send(composeLoginFailedNotice(detail, retryAt));
		} catch (error) {
			this.deps.logger.warn('Could not tell the owner the Cloud re-login did not finish', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * The episode is over: forget it and, when the owner was told and the
	 * machine is back, say so.
	 *
	 * @param reconnected - Back on Cloud (false = logged out on purpose)
	 */
	private async endEpisode(reconnected: boolean): Promise<void> {
		const state = readNoticeState(this.deps.stateFile);
		clearNoticeState(this.deps.stateFile);
		this.notice = null;
		this.lastReplyTs = null;
		this.stopReplyPolling();
		if (this.login && !isCloudLoginFinished(this.login.get().state)) this.login.cancel();
		this.login = null;
		this.lastLoginAttemptAt = 0;
		if (!reconnected || !state?.lastNotifiedAt || state.quiet) return;
		const dm = this.deps.getDm();
		if (!dm) return;
		try {
			await dm.send(RECONNECTED_NOTICE);
			this.deps.logger.info('Owner told that this machine is back on Crewly Cloud');
		} catch (error) {
			this.deps.logger.warn('Could not tell the owner the machine is back on Cloud', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Read the owner's DM replies while the CLI waits for typed input. */
	private startReplyPolling(): void {
		if (this.replyTimer !== null || this.stopped || !this.notice) return;
		this.replyDeadline = this.deps.now() + this.replyMaxWaitMs;
		const { channelId, ts: noticeTs } = this.notice;
		const poll = async (): Promise<void> => {
			this.replyTimer = null;
			const login = this.login;
			if (this.stopped || !login || !login.get().needsInput) return;
			if (this.deps.now() >= this.replyDeadline) {
				this.deps.logger.info('Stopped waiting for the owner to answer the Cloud login in Slack');
				return;
			}
			try {
				const dm = this.deps.getDm();
				const replies = dm ? await dm.readOwnerReplies(channelId, this.lastReplyTs ?? noticeTs) : [];
				const reply = replies[replies.length - 1];
				if (reply) {
					this.lastReplyTs = reply.ts;
					// Never log the reply: it may be a token.
					login.input(reply.text);
					this.deps.logger.info('Owner reply typed into `crewly cloud login`');
					return;
				}
			} catch (error) {
				this.deps.logger.warn('Could not read the owner DM for a login reply', { error: error instanceof Error ? error.message : String(error) });
			}
			this.replyTimer = this.deps.schedule(() => void poll(), this.replyPollMs);
		};
		this.replyTimer = this.deps.schedule(() => void poll(), this.replyPollMs);
	}

	/** Stop reading replies. */
	private stopReplyPolling(): void {
		if (this.replyTimer !== null) this.deps.cancel(this.replyTimer);
		this.replyTimer = null;
	}

	/**
	 * This machine's name (hostname fallback is the caller's job).
	 *
	 * @returns The name
	 */
	private async deviceName(): Promise<string> {
		try {
			return await this.deps.getDeviceName();
		} catch {
			return 'unknown';
		}
	}

	/** Schedule the next check. */
	private scheduleNext(): void {
		if (this.stopped) return;
		this.timer = this.deps.schedule(() => {
			this.timer = null;
			void this.tick().finally(() => this.scheduleNext());
		}, this.checkIntervalMs);
	}
}

/** Live hooks the server provides to {@link createCloudDisconnectNoticeService}. */
export interface CloudDisconnectNoticeWiring {
	/** Crewly home (the state file lives here) */
	crewlyHome: string;
	/** Owner DM over this machine's bot token, or null when Slack is not configured */
	getDm: () => OwnerDirectDm | null;
	/** Restart CloudSync on the credentials the CLI saved */
	reconnect: () => Promise<boolean>;
	/** This machine's name */
	getDeviceName: () => Promise<string>;
}

/**
 * Build the service with the real Cloud config, CloudSync health, CLI login,
 * clock and timers.
 *
 * @param wiring - Server hooks
 * @returns The service (not started)
 */
export function createCloudDisconnectNoticeService(wiring: CloudDisconnectNoticeWiring): CloudDisconnectNoticeService {
	const logger = LoggerService.getInstance().createComponentLogger('CloudDisconnectNotice');
	return new CloudDisconnectNoticeService({
		stateFile: path.join(wiring.crewlyHome, C.STATE_FILE),
		relayQueueNoticeFile: path.join(wiring.crewlyHome, C.RELAY_QUEUE_NOTICE_FILE),
		isSignedIn: async () => fs.existsSync(CloudClientService.getConfigPath()),
		getHealth: () => CloudSyncService.getInstance().getHealth(),
		getDeviceName: wiring.getDeviceName,
		getDm: wiring.getDm,
		startLogin: () => {
			const root = resolveRunningPackageRoot(process.argv[1]);
			const cliEntry = root ? path.join(root, C.CLI_ENTRY) : null;
			if (!cliEntry || !fs.existsSync(cliEntry)) throw new Error('crewly CLI not found next to the running backend');
			return startCloudLogin({ cliEntry });
		},
		reconnect: wiring.reconnect,
		logger,
		now: Date.now,
		schedule: (fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref?.();
			return t;
		},
		cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	});
}
