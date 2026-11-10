/**
 * Keep-awake service (macOS).
 *
 * While enabled, holds a power assertion with `caffeinate -i -s -w <backend pid>`
 * so the Mac does not idle-sleep on the power adapter (a sleeping Mac makes the
 * backend go silent: Cloud "machine offline" alerts, Slack deaf). `-s` only
 * takes effect on AC power; `-w` makes caffeinate exit when the backend dies.
 * The display may still sleep. System power settings (pmset) are never changed.
 * No-op on other platforms.
 *
 * @module services/system/keep-awake.service
 */

import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

/** Path of the macOS caffeinate binary */
export const CAFFEINATE_PATH = '/usr/bin/caffeinate';

/** Restart backoff bounds for an unexpected caffeinate exit */
export const KEEP_AWAKE_BACKOFF = {
	INITIAL_MS: 5_000,
	MAX_MS: 5 * 60_000,
	/** A process that lived this long counts as healthy and resets the backoff */
	HEALTHY_MS: 60_000,
} as const;

/** Spawn function type (injectable for tests) */
export type KeepAwakeSpawn = (command: string, args: string[], options: { stdio: 'ignore' }) => ChildProcess;

/** Options for {@link KeepAwakeService} */
export interface KeepAwakeOptions {
	/** Platform override (defaults to process.platform) */
	platform?: NodeJS.Platform;
	/** Backend pid to watch (defaults to process.pid) */
	pid?: number;
	/** Spawn override */
	spawn?: KeepAwakeSpawn;
	/** Logger override */
	logger?: Pick<ComponentLogger, 'info' | 'warn'>;
}

/** Status exposed on /health */
export interface KeepAwakeStatus {
	/** The setting is on and the platform supports it */
	enabled: boolean;
	/** A caffeinate process is currently holding the assertion */
	active: boolean;
}

/**
 * Manages one `caffeinate` child that mirrors the `keepAwakeOnPower` setting.
 */
export class KeepAwakeService {
	private static instance: KeepAwakeService | null = null;

	private readonly platform: NodeJS.Platform;
	private readonly pid: number;
	private readonly spawnFn: KeepAwakeSpawn;
	private readonly logger: Pick<ComponentLogger, 'info' | 'warn'>;

	private enabled = false;
	private child: ChildProcess | null = null;
	private restartTimer: NodeJS.Timeout | null = null;
	private backoffMs: number = KEEP_AWAKE_BACKOFF.INITIAL_MS;
	private startedAt = 0;

	constructor(options: KeepAwakeOptions = {}) {
		this.platform = options.platform ?? process.platform;
		this.pid = options.pid ?? process.pid;
		this.spawnFn = options.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
		this.logger = options.logger ?? LoggerService.getInstance().createComponentLogger('KeepAwake');
	}

	/** Shared instance. */
	static getInstance(): KeepAwakeService {
		if (!KeepAwakeService.instance) {
			KeepAwakeService.instance = new KeepAwakeService();
		}
		return KeepAwakeService.instance;
	}

	/** Drop the shared instance (tests). */
	static resetInstance(): void {
		KeepAwakeService.instance?.stop();
		KeepAwakeService.instance = null;
	}

	/**
	 * Apply the setting. Safe to call repeatedly; takes effect immediately.
	 *
	 * @param enabled - Value of `general.keepAwakeOnPower`
	 */
	setEnabled(enabled: boolean): void {
		if (this.platform !== 'darwin') {
			return;
		}
		if (enabled === this.enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			this.backoffMs = KEEP_AWAKE_BACKOFF.INITIAL_MS;
			this.start();
		} else {
			this.killChild();
			this.clearTimer();
		}
	}

	/** Release the assertion and stop restarting (shutdown). */
	stop(): void {
		this.enabled = false;
		this.clearTimer();
		this.killChild();
	}

	/** Current state for /health. */
	getStatus(): KeepAwakeStatus {
		return { enabled: this.enabled, active: this.child !== null };
	}

	private start(): void {
		if (!this.enabled || this.child) {
			return;
		}
		let child: ChildProcess;
		try {
			child = this.spawnFn(CAFFEINATE_PATH, ['-i', '-s', '-w', String(this.pid)], { stdio: 'ignore' });
		} catch (err) {
			this.logger.warn('Failed to start caffeinate', { error: err instanceof Error ? err.message : String(err) });
			this.scheduleRestart();
			return;
		}
		this.child = child;
		this.startedAt = Date.now();
		this.logger.info('Holding power assertion (caffeinate -i -s)', { pid: this.pid });
		child.on('error', (err: Error) => {
			this.logger.warn('caffeinate error', { error: err.message });
			this.onChildGone(child);
		});
		child.on('exit', (code, signal) => {
			if (this.child === child) {
				this.logger.warn('caffeinate exited unexpectedly', { code, signal });
			}
			this.onChildGone(child);
		});
	}

	private onChildGone(child: ChildProcess): void {
		if (this.child !== child) {
			return; // Already replaced or deliberately killed
		}
		this.child = null;
		if (Date.now() - this.startedAt >= KEEP_AWAKE_BACKOFF.HEALTHY_MS) {
			this.backoffMs = KEEP_AWAKE_BACKOFF.INITIAL_MS;
		}
		if (this.enabled) {
			this.scheduleRestart();
		}
	}

	private scheduleRestart(): void {
		if (!this.enabled || this.restartTimer) {
			return;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, KEEP_AWAKE_BACKOFF.MAX_MS);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}

	private clearTimer(): void {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private killChild(): void {
		const child = this.child;
		this.child = null; // Mark deliberate before the exit event fires
		if (child) {
			try {
				child.kill('SIGTERM');
			} catch {
				// Already gone
			}
		}
	}
}
