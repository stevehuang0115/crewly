/**
 * Liveness monitor (crewly#1015 §12).
 *
 * On 2026-10-01 the backend on the Mac was silent from 09:50 to 14:39 ET:
 * no shutdown line, no crash line, no alert. Every owner message in that
 * window waited up to 4 h 46 min and nobody knew why.
 *
 * The monitor writes `<CREWLY_HOME>/liveness.json` every TICK_MS and finds
 * two kinds of gap:
 *
 * - **stall**: two of its ticks more than GAP_ALERT_MS apart on the
 *   MONOTONIC clock — the event loop was blocked or the process was
 *   stopped. A gap only the wall clock shows is the computer sleeping
 *   (macOS's monotonic clock does not advance in sleep): logged, no DM —
 *   every lid-close would otherwise alarm the owner;
 * - **crash**: the previous process ended through an uncaught exception or
 *   an unhandled rejection (recorded on its way out), however quickly it
 *   came back;
 * - **unclean stop**: at boot, the previous process's last tick is more than
 *   GAP_ALERT_MS old and it never recorded a clean shutdown.
 *
 * Either is logged as an error and the owner is told once by Slack DM,
 * retried every tick while Slack is not up yet (for at most
 * ALERT_RETRY_MAX_MS). An alert while the machine is still down has to come
 * from Cloud (heartbeats stop) — not something a stopped process can send.
 *
 * @module services/monitoring/liveness-monitor.service
 * @see specs/2026-10-03-harness-drop-gaps.md §12
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { LIVENESS_MONITOR_CONSTANTS as C } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFileSync } from '../../utils/file-io.utils.js';

/** What `liveness.json` holds. */
export interface LivenessRecord {
	/** Last tick of the process (epoch ms) */
	lastAliveAt: number;
	/** The process that wrote it */
	pid: number;
	/** When that process started (epoch ms) */
	startedAt: number;
	/** Set when it shut down on purpose (epoch ms) */
	cleanShutdownAt?: number;
	/** Set when it went down through a crash handler: when, and why */
	crash?: { at: number; reason: string };
	/**
	 * Crashes not yet told to the owner, and when the last crash DM went out:
	 * crashes within CRASH_MERGE_WINDOW_MS go out as one DM with a count
	 * (follow-up M2). Carried from record to record.
	 */
	crashAlert?: CrashAlertState;
}

/** Crash DMs: what is waiting to be told, and when the last one went out. */
export interface CrashAlertState {
	lastSentAt?: number;
	unsent: Array<{ at: number; reason: string; backAt: number }>;
}

/** A gap to tell the owner about. */
export interface LivenessGap {
	kind: 'stalled' | 'stopped' | 'crashed';
	/** Crash reason (`crashed`; the last one when several) */
	reason?: string;
	/** How many crashes this alert covers (`crashed`; default 1) */
	count?: number;
	/** Last sign of life before the gap (epoch ms) */
	from: number;
	/** First sign of life after it (epoch ms) */
	to: number;
}

/** Injected behaviour. */
export interface LivenessMonitorDeps {
	/** Path of `liveness.json` */
	storePath: string;
	/** DM the owner; true when delivered */
	notifyOwner: (text: string) => Promise<boolean>;
	/** This machine's name ("Mac", "steamfun-ops") */
	machineName: () => string;
	/** Clock (tests) */
	now?: () => number;
	/** Process id (tests) */
	pid?: number;
	/** Time zone for the times in the alert (tests); machine-local by default */
	timeZone?: string;
	/**
	 * Monotonic clock in ms (default `performance.now()`); on macOS it does
	 * not advance while the computer sleeps.
	 */
	monoNow?: () => number;
}

/**
 * The owner's alert for a gap, in plain words.
 *
 * @param gap - The gap
 * @param machine - Machine name
 * @param timeZone - Time zone for the times (default machine-local)
 * @returns Alert text
 */
export function livenessAlertText(gap: LivenessGap, machine: string, timeZone?: string): string {
	const fmt = (ms: number): string =>
		new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
	const dur = formatDuration(gap.to - gap.from);
	const tail = ' Messages sent in that time were delayed; agents are picking them up now.';
	if (gap.kind === 'stalled') {
		return `⚠️ Crewly on ${machine} was stuck from ${fmt(gap.from)} to ${fmt(gap.to)} (${dur}) and did not handle anything in that time.${tail}`;
	}
	if (gap.kind === 'crashed') {
		if ((gap.count ?? 1) > 1) {
			const last = gap.reason ? ` (last: ${gap.reason})` : '';
			return `⚠️ Crewly on ${machine} crashed ${gap.count} times between ${fmt(gap.from)} and ${fmt(gap.to)}${last} and is running again.${tail}`;
		}
		const why = gap.reason ? ` (${gap.reason})` : '';
		return `⚠️ Crewly on ${machine} crashed at ${fmt(gap.from)}${why} and was back at ${fmt(gap.to)}.${tail}`;
	}
	return `⚠️ Crewly on ${machine} stopped without shutting down at ${fmt(gap.from)} and was back at ${fmt(gap.to)} (${dur} offline).${tail}`;
}

/**
 * "4 h 49 min" / "12 min".
 *
 * @param ms - Duration
 * @returns Text
 */
export function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60000));
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m} min`;
	return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Watches for gaps in this process's life and tells the owner about them.
 */
export class LivenessMonitorService {
	private readonly logger: ComponentLogger;
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastTickAt: number | null = null;
	private lastTickMono: number | null = null;
	private readonly startedAt: number;
	private pending: { gap: LivenessGap; firstTriedAt: number } | null = null;
	private crashAlert: CrashAlertState = { unsent: [] };
	private sending = false;

	/**
	 * @param deps - Injected behaviour
	 */
	constructor(private readonly deps: LivenessMonitorDeps) {
		this.logger = LoggerService.getInstance().createComponentLogger('LivenessMonitor');
		this.startedAt = this.now();
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private mono(): number {
		return this.deps.monoNow ? this.deps.monoNow() : performance.now();
	}

	private get pid(): number {
		return this.deps.pid ?? process.pid;
	}

	/**
	 * Check how the previous process ended, write the first record and start
	 * ticking (unref'd: never keeps the process alive).
	 */
	start(): void {
		const previous = this.read();
		const now = this.now();
		if (previous?.crashAlert && Array.isArray(previous.crashAlert.unsent)) {
			this.crashAlert = { ...previous.crashAlert, unsent: previous.crashAlert.unsent.slice(-C.CRASH_UNSENT_MAX) };
		}
		if (previous && previous.pid !== this.pid && previous.crash) {
			// Crash loops: crashes within the merge window go out as one DM.
			this.logger.error('The previous Crewly process crashed — the owner will be told', {
				at: new Date(previous.crash.at).toISOString(),
				reason: previous.crash.reason,
				waitingToTell: this.crashAlert.unsent.length + 1,
			});
			this.crashAlert.unsent = [...this.crashAlert.unsent, { at: previous.crash.at, reason: previous.crash.reason, backAt: now }].slice(-C.CRASH_UNSENT_MAX);
		} else if (
			previous &&
			previous.pid !== this.pid &&
			!(previous.cleanShutdownAt !== undefined && previous.cleanShutdownAt >= previous.lastAliveAt) &&
			now - previous.lastAliveAt > C.GAP_ALERT_MS
		) {
			this.raise({ kind: 'stopped', from: previous.lastAliveAt, to: now });
		}
		this.tick();
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), C.TICK_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** Stop ticking. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * One tick: detect a stall since the last tick, record that the process
	 * is alive, and (re)try a pending owner alert.
	 */
	tick(): void {
		const now = this.now();
		const mono = this.mono();
		if (this.lastTickAt !== null && this.lastTickMono !== null && now - this.lastTickAt > C.GAP_ALERT_MS) {
			if (mono - this.lastTickMono > C.GAP_ALERT_MS) {
				this.raise({ kind: 'stalled', from: this.lastTickAt, to: now });
			} else {
				// Wall clock jumped, monotonic did not: the computer slept. Not an outage of Crewly's making.
				this.logger.info('The computer was asleep — no ticks for a while (not alerting)', {
					from: new Date(this.lastTickAt).toISOString(),
					to: new Date(now).toISOString(),
					minutes: Math.round((now - this.lastTickAt) / 60000),
				});
			}
		}
		this.lastTickAt = now;
		this.lastTickMono = mono;
		this.write({ lastAliveAt: now, pid: this.pid, startedAt: this.startedAt });
		void this.sendPending();
		void this.sendCrashes();
	}

	/**
	 * Record that this process is shutting down on purpose, so the next boot
	 * does not report an unclean stop.
	 */
	markCleanShutdown(): void {
		const now = this.now();
		this.write({ lastAliveAt: now, pid: this.pid, startedAt: this.startedAt, cleanShutdownAt: now });
		this.stop();
	}

	/**
	 * Record that this process is going down through a crash handler, so the
	 * next boot tells the owner (crewly#1015 review B1).
	 *
	 * @param reason - `uncaughtException` / `unhandledRejection` (and the message)
	 */
	markCrash(reason: string): void {
		const now = this.now();
		this.write({ lastAliveAt: now, pid: this.pid, startedAt: this.startedAt, crash: { at: now, reason: reason.slice(0, 160) } });
		this.stop();
	}

	/** @returns The gap waiting to be told to the owner (tests / debugging) */
	get pendingGap(): LivenessGap | null {
		return this.pending?.gap ?? null;
	}

	private raise(gap: LivenessGap): void {
		this.logger.error(
			gap.kind === 'stalled'
				? 'Crewly was stuck for a while (not asleep: the monotonic clock advanced) — telling the owner'
				: gap.kind === 'crashed'
					? 'The previous Crewly process crashed — telling the owner'
					: 'The previous Crewly process stopped without a clean shutdown — telling the owner',
			{ kind: gap.kind, from: new Date(gap.from).toISOString(), to: new Date(gap.to).toISOString(), minutes: Math.round((gap.to - gap.from) / 60000) },
		);
		// A newer gap replaces one not yet told: the owner hears the latest.
		this.pending = { gap, firstTriedAt: this.now() };
	}

	private async sendPending(): Promise<void> {
		if (!this.pending || this.sending) return;
		const pending = this.pending;
		if (this.now() - pending.firstTriedAt > C.ALERT_RETRY_MAX_MS) {
			this.logger.warn('Could not tell the owner about a Crewly outage (Slack never came up) — giving up', { kind: pending.gap.kind });
			this.pending = null;
			return;
		}
		this.sending = true;
		try {
			const text = livenessAlertText(pending.gap, this.deps.machineName(), this.deps.timeZone);
			const sent = await this.deps.notifyOwner(text).catch(() => false);
			if (sent && this.pending === pending) {
				this.pending = null;
				this.logger.info('Owner told about a Crewly outage', { kind: pending.gap.kind });
			}
		} finally {
			this.sending = false;
		}
	}

	/**
	 * Tell the owner about crashes not yet told, at most one DM per
	 * CRASH_MERGE_WINDOW_MS: crashes in between are merged into the next DM
	 * with a count (follow-up M2).
	 */
	private async sendCrashes(): Promise<void> {
		const unsent = this.crashAlert.unsent;
		if (unsent.length === 0 || this.sending) return;
		const now = this.now();
		if (this.crashAlert.lastSentAt !== undefined && now - this.crashAlert.lastSentAt < C.CRASH_MERGE_WINDOW_MS) return;
		this.sending = true;
		try {
			const batch = [...unsent];
			const last = batch[batch.length - 1];
			const gap: LivenessGap =
				batch.length === 1
					? { kind: 'crashed', from: last.at, to: last.backAt, reason: last.reason }
					: { kind: 'crashed', from: batch[0].at, to: last.at, reason: last.reason, count: batch.length };
			const sent = await this.deps.notifyOwner(livenessAlertText(gap, this.deps.machineName(), this.deps.timeZone)).catch(() => false);
			if (!sent) return;
			this.crashAlert = { lastSentAt: this.now(), unsent: this.crashAlert.unsent.slice(batch.length) };
			this.write({ lastAliveAt: this.lastTickAt ?? now, pid: this.pid, startedAt: this.startedAt });
			this.logger.info('Owner told about Crewly crashes', { count: batch.length });
		} finally {
			this.sending = false;
		}
	}

	/** @returns Crashes waiting to be told (tests / debugging) */
	get unsentCrashes(): number {
		return this.crashAlert.unsent.length;
	}

	private read(): LivenessRecord | null {
		try {
			if (!existsSync(this.deps.storePath)) return null;
			const raw = JSON.parse(readFileSync(this.deps.storePath, 'utf8')) as Partial<LivenessRecord>;
			if (typeof raw.lastAliveAt !== 'number' || typeof raw.pid !== 'number') return null;
			return raw as LivenessRecord;
		} catch (err) {
			this.logger.warn('Could not read the liveness record', { error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	}

	private write(record: LivenessRecord): void {
		try {
			mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
			atomicWriteFileSync(this.deps.storePath, JSON.stringify({ ...record, crashAlert: this.crashAlert }));
		} catch (err) {
			this.logger.debug('Could not write the liveness record', { error: err instanceof Error ? err.message : String(err) });
		}
	}
}
