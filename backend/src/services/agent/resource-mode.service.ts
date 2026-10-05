/**
 * Adaptive agent limits. Normal mode: no cap, idle agents stop only when
 * memory is tight (IdleDetectionService). Pressure mode (memory/swap/OS
 * pressure or sustained high CPU load): cap running agents, stop idle ones
 * sooner, and queue starts that would exceed the cap.
 *
 * @module services/agent/resource-mode.service
 */

import os from 'os';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getMemoryStats } from '../core/system-health.util.js';
import { AGENT_SUSPEND_CONSTANTS } from '../../constants.js';

export const RESOURCE_MODE_CONSTANTS = {
	DEFAULT_MAX_RUNNING_AGENTS: 6,
	DEFAULT_IDLE_TIMEOUT_MINUTES: 10,
	/** Consecutive tight samples before entering pressure mode */
	ENTER_AFTER: 2,
	/** Consecutive calm samples before leaving pressure mode */
	LEAVE_AFTER: 3,
	/** Load average (5 min) above this many times the core count counts as tight */
	LOAD_PER_CORE: 2,
	SAMPLE_INTERVAL_MS: 30_000,
	/** How long a queued start waits for a slot before giving up (messages stay queued) */
	START_WAIT_MS: 2 * 60_000,
	/** A started agent counts against the cap even before it shows as running */
	ADMIT_TTL_MS: 3 * 60_000,
} as const;

export type ResourceMode = 'normal' | 'pressure';

export interface MemoryReading {
	usedPercent: number;
	freeMB: number;
	totalMB: number;
	swapUsedPercent?: number;
	pressureElevated?: boolean;
}

/**
 * Whether memory alone is tight (used share, free floor, swap, OS pressure).
 *
 * @param stats - Memory reading
 * @returns True when tight
 */
export function memoryIsTightFor(stats: MemoryReading): boolean {
	if (!stats.totalMB) return false;
	return (
		stats.usedPercent >= AGENT_SUSPEND_CONSTANTS.IDLE_STOP_MEMORY_USED_PERCENT ||
		stats.freeMB < AGENT_SUSPEND_CONSTANTS.IDLE_STOP_MIN_FREE_MB ||
		(stats.swapUsedPercent ?? 0) >= AGENT_SUSPEND_CONSTANTS.IDLE_STOP_SWAP_USED_PERCENT ||
		stats.pressureElevated === true
	);
}

/** A running, non-exempt agent as seen by the cap. */
export interface RunningAgent {
	sessionName: string;
	role: string;
	idleMs: number;
	/** Mid-turn (working status in_progress) */
	busy: boolean;
}

export interface ResourceModeDeps {
	listRunning: () => Promise<RunningAgent[]>;
	stopAgent: (sessionName: string, role: string) => Promise<void>;
	hasOwnerMessage: (sessionName: string) => boolean;
	limits: () => Promise<{ maxRunning: number; idleTimeoutMinutes: number }>;
}

interface Waiter { name: string; owner: boolean; seq: number; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }

export class ResourceModeService {
	private static instance: ResourceModeService | null = null;
	private logger: ComponentLogger;
	private mode: ResourceMode = 'normal';
	private tightStreak = 0;
	private calmStreak = 0;
	private lastReason = '';
	private timer: NodeJS.Timeout | null = null;
	private deps: ResourceModeDeps | null = null;
	private waiters: Waiter[] = [];
	private seq = 0;
	private admitted = new Map<string, number>();
	private pumping = false;
	private lastRunning = 0;
	private lastCap: number = RESOURCE_MODE_CONSTANTS.DEFAULT_MAX_RUNNING_AGENTS;

	/** Readings, overridable in tests. */
	memoryStats: () => MemoryReading = getMemoryStats;
	loadAvg: () => number = () => os.loadavg()[1];
	cpuCount: () => number = () => os.cpus().length || 1;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('ResourceMode');
	}

	static getInstance(): ResourceModeService {
		return (ResourceModeService.instance ??= new ResourceModeService());
	}

	static resetInstance(): void {
		ResourceModeService.instance?.stop();
		ResourceModeService.instance = null;
	}

	setDeps(deps: ResourceModeDeps | null): void {
		this.deps = deps;
	}

	/** Start periodic sampling. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => { void this.sample(); }, RESOURCE_MODE_CONSTANTS.SAMPLE_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(false); }
		this.waiters = [];
	}

	getMode(): ResourceMode {
		return this.mode;
	}

	/** Why a sample is tight, or '' when calm. */
	private tightReason(): string {
		const mem = this.memoryStats();
		if (memoryIsTightFor(mem)) {
			return `memory used=${mem.usedPercent}% free=${mem.freeMB}MB swap=${mem.swapUsedPercent ?? 0}% osPressure=${mem.pressureElevated === true}`;
		}
		const load = this.loadAvg();
		const cores = this.cpuCount();
		if (load > RESOURCE_MODE_CONSTANTS.LOAD_PER_CORE * cores) return `cpu load ${load.toFixed(1)} > ${RESOURCE_MODE_CONSTANTS.LOAD_PER_CORE}x${cores} cores`;
		return '';
	}

	/**
	 * Take one reading and apply hysteresis: enter pressure after
	 * ENTER_AFTER tight samples in a row, leave after LEAVE_AFTER calm ones.
	 *
	 * @returns The mode after this sample
	 */
	async sample(): Promise<ResourceMode> {
		const reason = this.tightReason();
		if (reason) { this.tightStreak++; this.calmStreak = 0; } else { this.calmStreak++; this.tightStreak = 0; }
		if (this.mode === 'normal' && this.tightStreak >= RESOURCE_MODE_CONSTANTS.ENTER_AFTER) {
			this.mode = 'pressure';
			this.lastReason = reason;
			this.logger.warn('Entering pressure mode: agent cap and shorter idle timeout apply', { reason });
		} else if (this.mode === 'pressure' && this.calmStreak >= RESOURCE_MODE_CONSTANTS.LEAVE_AFTER) {
			this.mode = 'normal';
			this.lastReason = '';
			this.logger.info('Leaving pressure mode: back to normal limits');
		}
		await this.pump();
		return this.mode;
	}

	/**
	 * Idle timeout in minutes for the current mode.
	 *
	 * @param normalMinutes - `general.agentIdleTimeoutMinutes`
	 * @param pressureMinutes - `general.pressureIdleTimeoutMinutes`
	 * @returns Effective timeout (0 = disabled)
	 */
	effectiveIdleTimeoutMinutes(normalMinutes: number, pressureMinutes: number): number {
		if (this.mode !== 'pressure') return normalMinutes;
		return pressureMinutes > 0 ? pressureMinutes : normalMinutes;
	}

	/** Snapshot for /health. */
	stats(): { resourceMode: ResourceMode; running: number; cap: number | null; waiting: number; reason: string } {
		return {
			resourceMode: this.mode,
			running: this.lastRunning,
			cap: this.mode === 'pressure' ? this.lastCap : null,
			waiting: this.waiters.length,
			reason: this.lastReason,
		};
	}

	/**
	 * Ask for permission to start an agent. Resolves true at once in normal
	 * mode. In pressure mode with the cap reached, tries to free a slot by
	 * stopping the longest-idle agent; otherwise waits (owner-triggered starts
	 * first). Resolves false when no slot opened in time — the caller leaves
	 * the agent's messages queued.
	 *
	 * @param sessionName - Agent to start
	 * @param ownerTriggered - An owner message is waiting for it
	 * @returns True when the start may proceed
	 */
	async requestStart(sessionName: string, ownerTriggered: boolean): Promise<boolean> {
		if (this.mode !== 'pressure' || !this.deps) return true;
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				this.logger.warn('Agent start still waiting for a slot; giving up for now (messages stay queued)', { sessionName });
				resolve(false);
			}, RESOURCE_MODE_CONSTANTS.START_WAIT_MS);
			const waiter: Waiter = { name: sessionName, owner: ownerTriggered, seq: this.seq++, resolve, timer };
			this.waiters.push(waiter);
			this.waiters.sort((a, b) => Number(b.owner) - Number(a.owner) || a.seq - b.seq);
			this.logger.info('Start queued: running-agent cap reached', { sessionName, ownerTriggered, waiting: this.waiters.length });
			void this.pump();
		});
	}

	/** Admit waiting starts while a slot is free or can be freed. */
	async pump(): Promise<void> {
		if (this.pumping || !this.deps) return;
		this.pumping = true;
		try {
			const now = Date.now();
			for (const [n, at] of this.admitted) if (now - at > RESOURCE_MODE_CONSTANTS.ADMIT_TTL_MS) this.admitted.delete(n);
			const { maxRunning } = await this.deps.limits();
			this.lastCap = maxRunning;
			const running = await this.deps.listRunning();
			const names = new Set(running.map((r) => r.sessionName));
			for (const n of names) this.admitted.delete(n);
			let count = running.length + this.admitted.size;
			this.lastRunning = count;
			let pool = running;
			// Already running: nothing to admit, nothing to count twice.
			for (const w of this.waiters.filter((x) => names.has(x.name))) {
				this.waiters = this.waiters.filter((x) => x !== w);
				this.release(w);
			}
			while (this.waiters.length > 0) {
				if (this.mode !== 'pressure') { this.release(this.waiters.shift()!); continue; }
				if (count >= maxRunning) {
					const victim = this.pickVictim(pool);
					if (!victim) break;
					try {
						this.logger.info('Stopping longest-idle agent to free a slot', { sessionName: victim.sessionName, idleMinutes: Math.round(victim.idleMs / 60000), waiter: this.waiters[0].name });
						await this.deps.stopAgent(victim.sessionName, victim.role);
					} catch (err) {
						this.logger.error('Failed to stop agent for slot', { sessionName: victim.sessionName, error: err instanceof Error ? err.message : String(err) });
						pool = pool.filter((r) => r !== victim);
						continue;
					}
					pool = pool.filter((r) => r !== victim);
					count--;
				}
				const w = this.waiters.shift()!;
				this.admitted.set(w.name, Date.now());
				count++;
				this.release(w);
			}
			this.lastRunning = count;
			if (this.waiters.length > 0) this.schedulePump();
		} catch (err) {
			this.logger.error('Slot pump failed', { error: err instanceof Error ? err.message : String(err) });
		} finally {
			this.pumping = false;
		}
	}

	/** Longest-idle agent that is not busy and has no owner message pending. */
	private pickVictim(running: RunningAgent[]): RunningAgent | undefined {
		const waiting = new Set(this.waiters.map((w) => w.name));
		return running
			.filter((r) => !r.busy
				&& !waiting.has(r.sessionName)
				&& !AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES.includes(r.role as typeof AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES[number])
				&& !this.deps!.hasOwnerMessage(r.sessionName))
			.sort((a, b) => b.idleMs - a.idleMs)[0];
	}

	private release(w: Waiter): void {
		clearTimeout(w.timer);
		w.resolve(true);
	}

	private schedulePump(): void {
		const t = setTimeout(() => { void this.pump(); }, 10_000);
		t.unref?.();
	}
}
