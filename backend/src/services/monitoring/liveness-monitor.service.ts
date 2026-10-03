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
 * - **stall**: two of its ticks more than GAP_ALERT_MS apart — the computer
 *   slept, the event loop was blocked, or the process was stopped;
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
}

/** A gap to tell the owner about. */
export interface LivenessGap {
	kind: 'stalled' | 'stopped';
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
	return gap.kind === 'stalled'
		? `⚠️ Crewly on ${machine} was not running from ${fmt(gap.from)} to ${fmt(gap.to)} (${dur}) — the computer may have been asleep, or Crewly was stuck.${tail}`
		: `⚠️ Crewly on ${machine} stopped without shutting down at ${fmt(gap.from)} and was back at ${fmt(gap.to)} (${dur} offline).${tail}`;
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
	private readonly startedAt: number;
	private pending: { gap: LivenessGap; firstTriedAt: number } | null = null;
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
		if (
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
		if (this.lastTickAt !== null && now - this.lastTickAt > C.GAP_ALERT_MS) {
			this.raise({ kind: 'stalled', from: this.lastTickAt, to: now });
		}
		this.lastTickAt = now;
		this.write({ lastAliveAt: now, pid: this.pid, startedAt: this.startedAt });
		void this.sendPending();
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

	/** @returns The gap waiting to be told to the owner (tests / debugging) */
	get pendingGap(): LivenessGap | null {
		return this.pending?.gap ?? null;
	}

	private raise(gap: LivenessGap): void {
		this.logger.error(
			gap.kind === 'stalled'
				? 'Crewly was not running for a while (machine asleep, or the process stuck) — telling the owner'
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
			atomicWriteFileSync(this.deps.storePath, JSON.stringify(record));
		} catch (err) {
			this.logger.debug('Could not write the liveness record', { error: err instanceof Error ? err.message : String(err) });
		}
	}
}
