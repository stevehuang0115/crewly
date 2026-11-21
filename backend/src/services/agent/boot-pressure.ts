/**
 * Memory-aware boot (crewly#1353): the snapshot the boot restore and the boot
 * maintenance passes read, the gate that holds a maintenance pass until the
 * restore queue is drained and the machine is calm, the pacer that spaces
 * launches across the restore queue and the deferred-start retry, and the
 * one-line owner note when boot restores were held back for long.
 *
 * Pressure mode (ResourceModeService) needs two tight 30 s samples before it
 * engages; the first minute after a boot is exactly when everything starts at
 * once, so the boot reads the raw memory reading as well.
 *
 * @module services/agent/boot-pressure
 */

import { BOOT_PRESSURE_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { ResourceModeService, osPressureCounts } from './resource-mode.service.js';

/** What the boot looks at before a launch or a maintenance pass. */
export interface BootPressureSnapshot {
	usedPercent: number;
	freeMB: number;
	/** Physical memory; scales the free floor on small machines (0 or absent: not scaled) */
	totalMB?: number;
	swapUsedPercent: number;
	osPressure: boolean;
	/** The OS reports its critical level (counts whatever is free) */
	osPressureCritical?: boolean;
	/** ResourceModeService is in pressure mode */
	pressureMode: boolean;
}

/** Thresholds, with the optional env overrides applied. */
export interface BootPressureThresholds {
	swapUsedPercent: number;
	minFreeMB: number;
	launchSpacingMs: number;
}

/**
 * Positive integer from an env var, or the fallback.
 *
 * @param raw - Env value
 * @param fallback - Default
 * @returns The parsed value or the fallback
 */
function envInt(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Thresholds from the constants block, with env overrides.
 *
 * @param env - Environment (tests inject one)
 * @returns Effective thresholds
 */
export function bootPressureThresholds(env: NodeJS.ProcessEnv = process.env): BootPressureThresholds {
	return {
		swapUsedPercent: envInt(env[BOOT_PRESSURE_CONSTANTS.ENV_SWAP_PERCENT], BOOT_PRESSURE_CONSTANTS.SWAP_USED_PERCENT),
		minFreeMB: envInt(env[BOOT_PRESSURE_CONSTANTS.ENV_MIN_FREE_MB], BOOT_PRESSURE_CONSTANTS.MIN_FREE_MB),
		launchSpacingMs: envInt(env[BOOT_PRESSURE_CONSTANTS.ENV_LAUNCH_SPACING_MS], BOOT_PRESSURE_CONSTANTS.MIN_LAUNCH_SPACING_MS),
	};
}

/**
 * The free-memory floor for this machine: the configured floor, capped at
 * MIN_FREE_FRACTION of physical memory. A fixed 3 GB floor reads an 8 GB
 * laptop as tight on every boot (2026-10-17: the Air held Fern back while
 * its own health check said memory was fine).
 *
 * @param snapshot - Reading (its totalMB scales the floor)
 * @param thresholds - Effective thresholds
 * @returns Floor in MB
 */
export function effectiveMinFreeMB(snapshot: BootPressureSnapshot, thresholds: BootPressureThresholds): number {
	if (!snapshot.totalMB || snapshot.totalMB <= 0) return thresholds.minFreeMB;
	return Math.min(thresholds.minFreeMB, Math.round(snapshot.totalMB * BOOT_PRESSURE_CONSTANTS.MIN_FREE_FRACTION));
}

/**
 * Why the snapshot is tight for the boot, or null when it is calm. Tight:
 * pressure mode, the OS pressure flag (its warn level only while little
 * memory is available, see `osPressureCounts`), free memory under the floor, or swap
 * at or above the threshold while free memory is also under twice the
 * floor. Swap fill alone does not count: macOS grows its swap file on
 * demand, so a small swap file sits near full on a healthy machine. An
 * unreadable snapshot (null) is calm: a boot must not stall on a reading
 * that failed.
 *
 * @param snapshot - Reading, or null when unavailable
 * @param thresholds - Effective thresholds
 * @returns One-line reason, or null
 */
export function bootPressureReason(
	snapshot: BootPressureSnapshot | null,
	thresholds: BootPressureThresholds = bootPressureThresholds(),
): string | null {
	if (!snapshot) return null;
	const floor = effectiveMinFreeMB(snapshot, thresholds);
	const why: string[] = [];
	if (snapshot.pressureMode) why.push('pressure mode');
	if (osPressureCounts({ freeMB: snapshot.freeMB, totalMB: snapshot.totalMB, pressureElevated: snapshot.osPressure, pressureCritical: snapshot.osPressureCritical })) why.push('OS memory pressure');
	if (snapshot.freeMB < floor) why.push(`free ${snapshot.freeMB}MB < ${floor}MB`);
	else if (snapshot.swapUsedPercent >= thresholds.swapUsedPercent && snapshot.freeMB < floor * 2) {
		why.push(`swap ${snapshot.swapUsedPercent}% >= ${thresholds.swapUsedPercent}% with free ${snapshot.freeMB}MB < ${floor * 2}MB`);
	}
	if (why.length === 0) return null;
	return `${why.join(', ')} (used=${snapshot.usedPercent}% free=${snapshot.freeMB}MB swap=${snapshot.swapUsedPercent}% osPressure=${snapshot.osPressure})`;
}

/**
 * The live snapshot: ResourceModeService's memory reading and mode. Null when
 * the reading throws or memory is unknown (totalMB 0).
 *
 * @returns Snapshot, or null
 */
export function readBootPressureSnapshot(): BootPressureSnapshot | null {
	try {
		const rm = ResourceModeService.getInstance();
		const mem = rm.memoryStats();
		if (!mem.totalMB) return null;
		return {
			usedPercent: mem.usedPercent,
			freeMB: mem.freeMB,
			totalMB: mem.totalMB,
			swapUsedPercent: mem.swapUsedPercent ?? 0,
			osPressure: mem.pressureElevated === true,
			osPressureCritical: mem.pressureCritical === true,
			pressureMode: rm.getMode() === 'pressure',
		};
	} catch {
		return null;
	}
}

/**
 * Remembers when the last boot launch began, so the restore queue and the
 * deferred-start retry keep the launch spacing between them.
 */
export class BootLaunchPacer {
	private lastAt: number | null = null;

	constructor(private readonly now: () => number = Date.now) {}

	/** A launch began now. */
	note(): void {
		this.lastAt = this.now();
	}

	/** Milliseconds since the last launch began (Infinity when none yet). */
	msSinceLast(): number {
		return this.lastAt === null ? Infinity : this.now() - this.lastAt;
	}
}

let pacer: BootLaunchPacer | null = null;

/** The process-wide pacer. */
export function getBootLaunchPacer(): BootLaunchPacer {
	return (pacer ??= new BootLaunchPacer());
}

/** Test hook: drop the pacer. */
export function resetBootLaunchPacer(): void {
	pacer = null;
}

/** What {@link bootLaunchHoldReason} looks at. */
export interface BootLaunchHoldDeps {
	snapshot: () => BootPressureSnapshot | null;
	/** The restore queue is still launching agents */
	restoreRunning: () => boolean;
	pacer: BootLaunchPacer;
	/** Epoch ms of the boot */
	bootAt: number;
	thresholds?: BootPressureThresholds;
	now?: () => number;
	holdMaxMs?: number;
}

/**
 * Why a boot launch outside the restore queue (the deferred-start retry) must
 * wait this round: memory is tight (only within `holdMaxMs` of the boot), the
 * restore queue is still launching, or another boot launch began less than
 * the launch spacing ago. Null = go.
 *
 * @param deps - Snapshot, restore state, pacer, boot time
 * @returns Reason to hold, or null
 */
export function bootLaunchHoldReason(deps: BootLaunchHoldDeps): string | null {
	const now = deps.now ?? Date.now;
	const thresholds = deps.thresholds ?? bootPressureThresholds();
	const holdMaxMs = deps.holdMaxMs ?? BOOT_PRESSURE_CONSTANTS.RETRY_HOLD_MAX_MS;
	if (now() - deps.bootAt < holdMaxMs) {
		const tight = bootPressureReason(deps.snapshot(), thresholds);
		if (tight) return `memory tight: ${tight}`;
	}
	if (deps.restoreRunning()) return 'boot restore queue still launching';
	const since = deps.pacer.msSinceLast();
	if (since < thresholds.launchSpacingMs) return `a boot launch began ${Math.round(since / 1000)} s ago`;
	return null;
}

/** What {@link waitForBootQuiet} needs. */
export interface BootQuietGateDeps {
	/** The boot restore is over (queue drained, or there was nothing to restore). */
	restoreDone: () => boolean;
	/** Current reading (default: the live one). */
	snapshot?: () => BootPressureSnapshot | null;
	thresholds?: BootPressureThresholds;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	pollMs?: number;
	maxWaitMs?: number;
}

/** Outcome of the gate. */
export interface BootQuietGateResult {
	waitedMs: number;
	/** The gate gave up waiting; the pass should run reduced. */
	reduced: boolean;
	/** Why it was still waiting when it gave up */
	reason?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * Hold a boot maintenance pass until the restore queue is drained and the
 * machine is not tight, polling every `pollMs`. After `maxWaitMs` it gives
 * up and returns `reduced: true` so the pass runs with a smaller batch.
 *
 * @param deps - Restore state, snapshot, clock
 * @returns How long it waited and whether the pass should run reduced
 */
export async function waitForBootQuiet(deps: BootQuietGateDeps): Promise<BootQuietGateResult> {
	const snapshot = deps.snapshot ?? readBootPressureSnapshot;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? Date.now;
	const pollMs = deps.pollMs ?? BOOT_PRESSURE_CONSTANTS.MAINTENANCE_POLL_MS;
	const maxWaitMs = deps.maxWaitMs ?? BOOT_PRESSURE_CONSTANTS.MAINTENANCE_WAIT_MAX_MS;
	const started = now();
	for (;;) {
		const tight = bootPressureReason(snapshot(), deps.thresholds);
		const reason = !deps.restoreDone() ? `restore queue still running${tight ? `; ${tight}` : ''}` : tight;
		if (!reason) return { waitedMs: now() - started, reduced: false };
		if (now() - started >= maxWaitMs) return { waitedMs: now() - started, reduced: true, reason };
		await sleep(pollMs);
	}
}

/**
 * Names as a sentence fragment: "Ella", "Ella and Pia", "Ella, Pia and Owen".
 *
 * @param names - Agent names
 * @returns Joined names
 */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What {@link scheduleHeldBackNotice} needs. */
export interface HeldBackNoticeDeps {
	/** Agents held back by the boot that are still not running */
	stillHeld: () => Promise<string[]>;
	/** Sends one line to the owner; false when nothing is connected */
	notify: (line: string) => Promise<boolean>;
	afterMs?: number;
	setTimer?: (fn: () => void, ms: number) => void;
}

/**
 * One line to the owner, once, if agents the boot held back for memory are
 * still down `afterMs` later. Nothing is sent when they came back in time.
 * The line names the agents and says they will return; no mechanics.
 *
 * @param deps - Held-back check and notifier
 * @returns Resolves when the check ran (tests); callers do not await it
 */
export function scheduleHeldBackNotice(deps: HeldBackNoticeDeps): Promise<void> {
	const logger = LoggerService.getInstance().createComponentLogger('BootPressure');
	const afterMs = deps.afterMs ?? BOOT_PRESSURE_CONSTANTS.OWNER_NOTE_AFTER_MS;
	const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); });
	return new Promise<void>((resolve) => {
		setTimer(() => {
			void (async () => {
				try {
					const held = await deps.stillHeld();
					if (held.length === 0) return;
					const line = `Memory is tight on this machine, so ${joinNames(held)} ${held.length === 1 ? 'has' : 'have'} not been brought back yet; ${held.length === 1 ? 'it' : 'they'} will start as soon as it eases.`;
					const sent = await deps.notify(line);
					logger.info('Told the owner about boot restores held back for memory', { held, sent });
				} catch (err) {
					logger.warn('Could not tell the owner about held-back boot restores', { error: err instanceof Error ? err.message : String(err) });
				} finally {
					resolve();
				}
			})();
		}, afterMs);
	});
}
