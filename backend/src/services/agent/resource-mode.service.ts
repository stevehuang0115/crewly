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
import { AGENT_SUSPEND_CONSTANTS, SYSTEM_RESOURCE_ALERT_CONSTANTS } from '../../constants.js';
import { isDriveWarm } from '../drive/drive-keep-warm.js';

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
	/**
	 * A start that has waited this long for a slot stops the best available
	 * agent even if it is idle for less than the idle timeout or has work in
	 * flight: a waiting start often carries an owner message and must never be
	 * blocked forever.
	 */
	RELAX_AFTER_MS: 3 * 60_000,
	/**
	 * An agent started less than this long ago is never stopped to free a slot
	 * (except at critical memory). Starting an agent and stopping it minutes
	 * later wastes the whole start and releases its work back to the pool
	 * (2026-10-16: Luna stopped 8 times in 2 h, some after 0-3 min idle).
	 */
	MIN_RUN_BEFORE_EVICT_MS: 10 * 60_000,
	/**
	 * Hysteresis: for this long after A was stopped to start B, A's own start
	 * may not stop B (2026-10-16: Luna and Max evicted each other back and forth).
	 * Longer than MIN_RUN_BEFORE_EVICT_MS so it still holds once B's own start
	 * protection has run out.
	 */
	DISPLACED_GUARD_MS: 30 * 60_000,
	/**
	 * An agent idle for less than this is never stopped to free a slot — not
	 * for an owner-message waiter, not when the rules relax — unless memory is
	 * critical. Eviction at `idleMinutes: 0` (32 slot stops in 9 h on
	 * 2026-10-16, Luna and Max taking turns) throws away an agent that just
	 * finished a turn and is about to get the next one (crewly#1344).
	 */
	MIN_IDLE_BEFORE_EVICT_MS: 5 * 60_000,
	/**
	 * The soft reasons to keep an agent running for a slot — the owner spoke
	 * to it lately (answered), it stated an intent, or it waits on a teammate's
	 * ticket or delegated work — lapse once it has been idle this long. Such an
	 * agent is woken again by the message it waits for; holding the slot for
	 * hours starved everyone else (2026-10-19: Ella waited 2 h 38 min, with
	 * 1132 "owes the owner" keeps in a day). An unanswered owner message, an
	 * owner promise and work in hand still protect at any idle.
	 */
	SOFT_KEEP_MAX_IDLE_MS: 30 * 60_000,
	/** A wait record older than this since its last touch is a new wait */
	WAIT_RECORD_TTL_MS: 10 * 60_000,
	/** A started agent counts against the cap even before it shows as running */
	ADMIT_TTL_MS: 3 * 60_000,
	/** errorCode of a start that waited for a slot and got none (deferred, not failed) */
	START_DEFERRED_ERROR_CODE: 'RESOURCE_PRESSURE_CAP',
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
 * Whether memory alone is tight: the used share, the free floor, the OS
 * pressure flag, or swap at or above its threshold while free memory is also
 * under twice the floor.
 *
 * Swap fill alone does not count (same rule as `boot-pressure.ts`): macOS
 * grows its swap file on demand and keeps it full for hours after the
 * pressure is gone, so a 16 GB Mac with 5–6 GB available and the kernel
 * reporting no pressure entered pressure mode 11 times on 2026-10-26 — 18
 * idle stops, 13 starts queued behind the cap, 2 boot restores deferred, for
 * nothing. A machine that is really swapping itself to a crawl still trips
 * the OS pressure flag, the CPU-load rule or the used share.
 *
 * @param stats - Memory reading
 * @returns True when tight
 */
export function memoryIsTightFor(stats: MemoryReading): boolean {
	if (!stats.totalMB) return false;
	const swapTight =
		(stats.swapUsedPercent ?? 0) >= AGENT_SUSPEND_CONSTANTS.IDLE_STOP_SWAP_USED_PERCENT &&
		stats.freeMB < AGENT_SUSPEND_CONSTANTS.IDLE_STOP_MIN_FREE_MB * AGENT_SUSPEND_CONSTANTS.IDLE_STOP_SWAP_FREE_FACTOR;
	return (
		stats.usedPercent >= AGENT_SUSPEND_CONSTANTS.IDLE_STOP_MEMORY_USED_PERCENT ||
		stats.freeMB < AGENT_SUSPEND_CONSTANTS.IDLE_STOP_MIN_FREE_MB ||
		swapTight ||
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
	/**
	 * The agent owes the owner: an unanswered owner message, a promise in an
	 * owner thread, or a stated "starting now". Such an agent is never stopped
	 * to free a slot unless memory is critical; the waiter waits for another
	 * victim (2026-10-08: Atlas and Ella were stopped mid-conversation;
	 * 2026-10-12: Pia was stopped with a video owed). `idleMs` lets the soft
	 * reasons lapse (see SOFT_KEEP_MAX_IDLE_MS).
	 */
	owesOwnerThread?: (sessionName: string, idleMs: number) => boolean;
	/**
	 * Why this agent must not be stopped for a slot: it has work queued for it,
	 * owns an open ticket, or delegated work that is still open (its report is
	 * still to come). Null/undefined = free to stop. Errors count as free.
	 * `idleMs` lets the waiting-on-a-teammate reasons lapse (see SOFT_KEEP_MAX_IDLE_MS).
	 */
	protectedReason?: (sessionName: string, idleMs: number) => Promise<string | null | undefined>;
	/**
	 * Whether the waiter is waiting on the candidate's work (it delegated an
	 * open work item or ticket to it). Such a candidate is never stopped for
	 * that waiter. Errors count as false.
	 */
	waitsOn?: (waiter: string, candidate: string) => Promise<boolean>;
	/** An agent was stopped to free a slot (the owner thread it owes is told) */
	onStoppedForSlot?: (sessionName: string) => void;
	/** A start waited for a slot and got none (deferred; its messages stay queued) */
	onStartDeferred?: (sessionName: string) => void;
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
	/** The start promise of each agent waiting for a slot (one per agent) */
	private pendingStarts = new Map<string, Promise<boolean>>();
	private pumping = false;
	/** When the "no slot" reason was last logged per waiter (the pump retries every 10 s) */
	private lastNoSlotLog = new Map<string, number>();
	/** When each agent's start first began waiting for a slot (survives the 2-minute deferral, cleared on admission) */
	private waitingSince = new Map<string, { since: number; touched: number }>();
	private lastRunning = 0;
	/** When each agent was last seen turning idle (events), or the first pump that saw it idle after seeing it busy */
	private idleSince = new Map<string, number>();
	/** Agents seen busy by a pump (their idle time starts at that sighting at the earliest) */
	private lastSeenBusy = new Map<string, number>();
	private lastCap: number = RESOURCE_MODE_CONSTANTS.DEFAULT_MAX_RUNNING_AGENTS;
	/** When each agent's start was last allowed (it counts as freshly started for MIN_RUN_BEFORE_EVICT_MS) */
	private startedAt = new Map<string, number>();
	/** Who displaced each agent stopped for a slot, and when (hysteresis, DISPLACED_GUARD_MS) */
	private displacedBy = new Map<string, { by: string; at: number }>();

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

	/**
	 * An agent's working status changed. Idle time for eviction is counted
	 * from the busy to idle transition, not from its last output: an agent
	 * that was busy for an hour with a silent background task is not "idle for
	 * 60 minutes" the moment it finishes (Pia, 2026-10-12).
	 *
	 * @param sessionName - Agent
	 * @param idle - True on busy to idle, false on idle to busy
	 * @param at - Epoch ms of the transition
	 */
	noteWorkingStatus(sessionName: string, idle: boolean, at: number = Date.now()): void {
		if (idle) this.idleSince.set(sessionName, at);
		else this.idleSince.delete(sessionName);
		if (!idle) this.lastSeenBusy.delete(sessionName);
	}

	/** Idle time of a running agent counted from when it became idle. */
	private withHonestIdle(running: RunningAgent[], now: number): RunningAgent[] {
		return running.map((r) => {
			if (r.busy) {
				this.lastSeenBusy.set(r.sessionName, now);
				this.idleSince.delete(r.sessionName);
				return r;
			}
			const since = this.idleSince.get(r.sessionName) ?? this.lastSeenBusy.get(r.sessionName);
			return since === undefined ? r : { ...r, idleMs: Math.min(r.idleMs, Math.max(0, now - since)) };
		});
	}

	/** Whether memory is critical: the only case where an agent that owes the owner may be stopped for a slot. */
	private memoryCritical(): boolean {
		try {
			return this.memoryStats().usedPercent >= SYSTEM_RESOURCE_ALERT_CONSTANTS.THRESHOLDS.MEMORY_CRITICAL;
		} catch {
			return false;
		}
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
		this.pendingStarts.clear();
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
		if (this.mode !== 'pressure' || !this.deps) {
			this.startedAt.set(sessionName, Date.now());
			return true;
		}
		// One place in line per agent (CREW-304): a second request for an agent
		// already waiting joins that wait instead of queuing it twice. An owner
		// message moves the existing place to the front.
		const existing = this.pendingStarts.get(sessionName);
		if (existing) {
			const queued = this.waiters.find((w) => w.name === sessionName);
			if (queued && ownerTriggered && !queued.owner) {
				queued.owner = true;
				this.waiters.sort((a, b) => Number(b.owner) - Number(a.owner) || a.seq - b.seq);
			}
			return existing;
		}
		const promise = this.enqueueStart(sessionName, ownerTriggered);
		this.pendingStarts.set(sessionName, promise);
		void promise.finally(() => {
			if (this.pendingStarts.get(sessionName) === promise) this.pendingStarts.delete(sessionName);
		});
		return promise;
	}

	/**
	 * Whether a start for this agent is waiting for a slot right now.
	 *
	 * @param sessionName - Agent session
	 * @returns True while it waits behind the running-agent cap
	 */
	isStartWaiting(sessionName: string): boolean {
		return this.waiters.some((w) => w.name === sessionName);
	}

	/** Queue a start behind the cap (see {@link requestStart}). */
	private enqueueStart(sessionName: string, ownerTriggered: boolean): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				this.logger.warn('Agent start still waiting for a slot; giving up for now (messages stay queued)', { sessionName });
				try { this.deps?.onStartDeferred?.(sessionName); } catch { /* best-effort */ }
				resolve(false);
			}, RESOURCE_MODE_CONSTANTS.START_WAIT_MS);
			const nowMs = Date.now();
			const rec = this.waitingSince.get(sessionName);
			if (!rec || nowMs - rec.touched > RESOURCE_MODE_CONSTANTS.WAIT_RECORD_TTL_MS) this.waitingSince.set(sessionName, { since: nowMs, touched: nowMs });
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
			for (const [n, at] of this.startedAt) if (now - at >= RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS) this.startedAt.delete(n);
			for (const [n, d] of this.displacedBy) if (now - d.at >= RESOURCE_MODE_CONSTANTS.DISPLACED_GUARD_MS) this.displacedBy.delete(n);
			const { maxRunning, idleTimeoutMinutes } = await this.deps.limits();
			this.lastCap = maxRunning;
			const running = this.withHonestIdle(await this.deps.listRunning(), now);
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
				if (this.mode !== 'pressure') {
					const w = this.waiters.shift()!;
					this.startedAt.set(w.name, Date.now());
					this.release(w);
					continue;
				}
				if (count >= maxRunning) {
					const head = this.waiters[0];
					const rec = this.waitingSince.get(head.name);
					if (rec) rec.touched = now;
					const waitedMs = rec ? now - rec.since : 0;
					const { victim, skipped, relaxedBecause } = await this.pickVictim(pool, idleTimeoutMinutes, waitedMs >= RESOURCE_MODE_CONSTANTS.RELAX_AFTER_MS, head.owner, head.name, now);
					if (victim && relaxedBecause !== undefined) {
						this.logger.warn('A start has waited too long for a slot; relaxing the eviction rules', {
							waiter: head.name,
							waitedMin: Math.round(waitedMs / 60000),
							stopping: victim.sessionName,
							idleMinutes: Math.round(victim.idleMs / 60000),
							wasKeptBecause: relaxedBecause || 'it was not protected',
						});
					}
					if (!victim) {
						this.logNoSlot(this.waiters[0].name, count, maxRunning, idleTimeoutMinutes, skipped);
						break;
					}
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
					this.displacedBy.set(victim.sessionName, { by: head.name, at: Date.now() });
					this.startedAt.delete(victim.sessionName);
					try { this.deps.onStoppedForSlot?.(victim.sessionName); } catch { /* best-effort */ }
				}
				const w = this.waiters.shift()!;
				this.admitted.set(w.name, Date.now());
				this.startedAt.set(w.name, Date.now());
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

	/**
	 * Longest-idle agent that may be stopped for a slot. Never one that is
	 * busy, waiting for a start itself, always-on, holding an owner message,
	 * Drive-warm, idle for less than the pressure idle timeout, or protected
	 * by {@link ResourceModeDeps.protectedReason} (queued messages, pending
	 * work, an open ticket, an open delegation). An agent that owes the owner
	 * is never picked unless memory is critical.
	 *
	 * Anti-thrash rules (2026-10-16, Luna and Max evicting each other), which
	 * hold in every mode, relaxed included, unless memory is critical:
	 *  - an agent idle for less than MIN_IDLE_BEFORE_EVICT_MS is kept (also for an owner-message waiter),
	 *  - an agent started less than MIN_RUN_BEFORE_EVICT_MS ago is kept,
	 *  - an agent whose work the waiter waits on ({@link ResourceModeDeps.waitsOn}) is kept,
	 *  - an agent that displaced the waiter less than DISPLACED_GUARD_MS ago is kept (hysteresis).
	 * An owner-message waiter skips the first and last rule (owner messages are
	 * rare, so they cannot thrash, and the owner must never wait); it keeps only
	 * the waits-on rule and the protections above.
	 * Relaxing only lifts the idle timeout; protected agents are never stopped.
	 * When no agent qualifies, the waiter waits.
	 *
	 * @param running - Running agents
	 * @param idleTimeoutMinutes - Pressure idle timeout; a younger idle is never stopped
	 * @param relax - The first waiter has waited past RELAX_AFTER_MS: when no agent passes the rules, stop the best one anyway
	 * @param ownerWaiter - The first waiter carries an owner message: the idle timeout does not protect an agent (the longest-idle one goes at once); busy, owner-message, Drive-warm and pending-work/ticket/delegation protections still apply
	 * @param waiterName - The first waiter (for the waits-on and hysteresis rules)
	 * @param now - Epoch ms of this pump
	 * @returns The victim (if any), why each skipped agent was kept, and, when the rules were relaxed, why the victim had been kept
	 */
	private async pickVictim(
		running: RunningAgent[],
		idleTimeoutMinutes: number,
		relax = false,
		ownerWaiter = false,
		waiterName = '',
		now: number = Date.now(),
	): Promise<{ victim?: RunningAgent; skipped: string[]; relaxedBecause?: string }> {
		const waiting = new Set(this.waiters.map((w) => w.name));
		const critical = this.memoryCritical();
		const minIdleMs = ownerWaiter ? 0 : Math.max(0, idleTimeoutMinutes) * 60_000;
		const skipped: string[] = [];
		const ordered = running
			.filter((r) => !r.busy
				&& !waiting.has(r.sessionName)
				&& !AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES.includes(r.role as typeof AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES[number])
				&& !this.deps!.hasOwnerMessage(r.sessionName)
				// Kept warm for the owner's Drive mode session (specs/2026-10-09-drive-mode-v3.md §5)
				&& !isDriveWarm(r.sessionName))
			.sort((a, b) => b.idleMs - a.idleMs);
		const candidates: RunningAgent[] = [];
		const keptBecause = new Map<RunningAgent, string>();
		const unprotected: RunningAgent[] = [];
		for (const r of ordered) {
			// Floor under every rule (owner waiter and relaxed included): an agent
			// that went idle moments ago is not a slot, it is the next turn's
			// agent (crewly#1344). Only critical memory overrides it.
			if (!critical && r.idleMs < RESOURCE_MODE_CONSTANTS.MIN_IDLE_BEFORE_EVICT_MS) {
				skipped.push(`${r.sessionName}: idle ${Math.round(r.idleMs / 60000)} min, under the ${RESOURCE_MODE_CONSTANTS.MIN_IDLE_BEFORE_EVICT_MS / 60000} min eviction floor`);
				continue;
			}
			const thrash = critical ? null : await this.thrashReason(r.sessionName, waiterName, now, ownerWaiter);
			if (thrash) {
				skipped.push(`${r.sessionName}: ${thrash}`);
				continue;
			}
			let why: string | null | undefined;
			try { why = await this.deps!.protectedReason?.(r.sessionName, r.idleMs); } catch { why = null; }
			const tooYoung = r.idleMs < minIdleMs;
			if (tooYoung || why) {
				const text = [tooYoung ? `idle ${Math.round(r.idleMs / 60000)} min, under the ${idleTimeoutMinutes} min idle timeout` : '', why ?? ''].filter(Boolean).join('; ');
				skipped.push(`${r.sessionName}: ${text}`);
				keptBecause.set(r, text);
				if (!why) unprotected.push(r);
				continue;
			}
			candidates.push(r);
		}
		const owes = (r: RunningAgent): boolean => {
			try { return this.deps!.owesOwnerThread?.(r.sessionName, r.idleMs) === true; } catch { return false; }
		};
		// An agent that owes the owner is never a victim (not even when the rules
		// relax): the waiter waits for another one. Only critical memory overrides.
		const owing = new Set(ordered.filter(owes));
		for (const r of owing) if (!critical) skipped.push(`${r.sessionName}: it owes the owner an answer or a promised result`);
		const eligible = (list: RunningAgent[]): RunningAgent[] => (critical ? list : list.filter((r) => !owing.has(r)));
		const choose = (list: RunningAgent[]): RunningAgent | undefined => {
			const ok = eligible(list);
			return ok.find((r) => !owing.has(r)) ?? ok[0];
		};
		const victim = choose(candidates);
		if (victim || !relax) return { victim, skipped };
		// Relaxed: only agents kept by nothing but the idle timeout; longest idle
		// first. A protected agent (queued messages, work in hand, an open
		// ticket or delegation) is never stopped: the waiter waits instead.
		const fallback = choose(unprotected);
		return fallback ? { victim: fallback, skipped, relaxedBecause: keptBecause.get(fallback) ?? '' } : { skipped };
	}

	/**
	 * Why stopping this agent for the waiter would thrash, or null when it would not.
	 *
	 * @param candidate - Running agent considered as a victim
	 * @param waiter - First waiting start
	 * @param now - Epoch ms of this pump
	 * @param ownerWaiter - The waiter carries an owner message: the start window and the hysteresis do not apply (waits-on still does)
	 * @returns English reason, or null
	 */
	private async thrashReason(candidate: string, waiter: string, now: number, ownerWaiter = false): Promise<string | null> {
		const started = this.startedAt.get(candidate);
		if (!ownerWaiter && started !== undefined && now - started < RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS) {
			return `started ${Math.round((now - started) / 60000)} min ago, under the ${RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS / 60000} min protection window`;
		}
		const displaced = this.displacedBy.get(waiter);
		if (!ownerWaiter && displaced && displaced.by === candidate && now - displaced.at < RESOURCE_MODE_CONSTANTS.DISPLACED_GUARD_MS) {
			return `it displaced ${waiter} ${Math.round((now - displaced.at) / 60000)} min ago (no ping-pong)`;
		}
		if (waiter && this.deps?.waitsOn) {
			let dependsOn = false;
			try { dependsOn = await this.deps.waitsOn(waiter, candidate); } catch { dependsOn = false; }
			if (dependsOn) return `${waiter} is waiting on its work`;
		}
		return null;
	}

	/** Log why a waiting start got no slot (at most once a minute per agent). */
	private logNoSlot(waiter: string, running: number, cap: number, idleTimeoutMinutes: number, skipped: string[]): void {
		const now = Date.now();
		if (now - (this.lastNoSlotLog.get(waiter) ?? 0) < 60_000) return;
		this.lastNoSlotLog.set(waiter, now);
		this.logger.info('No agent can be stopped for a slot; the start waits', {
			waiter,
			running,
			cap,
			idleTimeoutMinutes,
			kept: skipped.length > 0 ? skipped : ['every other running agent is busy, always-on, holds an owner message or is waiting for a start itself'],
		});
	}

	private release(w: Waiter): void {
		this.waitingSince.delete(w.name);
		clearTimeout(w.timer);
		w.resolve(true);
	}

	private schedulePump(): void {
		const t = setTimeout(() => { void this.pump(); }, 10_000);
		t.unref?.();
	}
}
