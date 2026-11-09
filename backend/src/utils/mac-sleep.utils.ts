/**
 * When this Mac last slept and woke, from the kernel (`kern.sleeptime` /
 * `kern.waketime`).
 *
 * Why: Node's monotonic clock (`performance.now()`, `process.hrtime`) is
 * built on `mach_continuous_time()` on macOS, so it keeps running while the
 * computer sleeps. A gap in timer ticks therefore cannot tell sleep from a
 * blocked event loop by comparing clocks. On 2026-11-05 every Mac sleep over
 * ten minutes was reported to the owner as "Crewly was stuck" plus a "lost
 * its connection to Crewly Cloud" notice. The kernel's last sleep/wake
 * times answer the question directly.
 *
 * @module utils/mac-sleep.utils
 */

import { execFileSync } from 'child_process';

/** One sleep of the computer (epoch ms). */
export interface SleepWindow {
	/** When it went to sleep */
	sleptAt: number;
	/** When it woke up */
	wokeAt: number;
}

/** Longest the `sysctl` read may take before it is given up (ms). */
const SYSCTL_TIMEOUT_MS = 2_000;

/**
 * Parse one `sysctl` timeval line, e.g.
 * `{ sec = 1793934047, usec = 606277 } Thu Nov  5 22:00:47 2026`.
 *
 * @param line - The value as `sysctl -n` prints it
 * @returns Epoch ms, or null when the line does not hold a non-zero timeval
 */
export function parseSysctlTimeval(line: string): number | null {
	const m = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(line);
	if (!m) return null;
	const ms = Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000);
	return ms > 0 ? ms : null;
}

/**
 * The last sleep of this Mac, or null (not macOS, never slept since boot,
 * still asleep by the kernel's account, or `sysctl` failed).
 *
 * @param platform - Platform (tests); default `process.platform`
 * @param run - Runs `sysctl -n kern.sleeptime kern.waketime` (tests)
 * @returns The sleep window, or null
 */
export function readMacLastSleep(
	platform: NodeJS.Platform = process.platform,
	run: () => string = () =>
		execFileSync('sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { encoding: 'utf8', timeout: SYSCTL_TIMEOUT_MS }),
): SleepWindow | null {
	if (platform !== 'darwin') return null;
	try {
		const [sleepLine = '', wakeLine = ''] = run().split('\n');
		const sleptAt = parseSysctlTimeval(sleepLine);
		const wokeAt = parseSysctlTimeval(wakeLine);
		if (sleptAt === null || wokeAt === null || wokeAt < sleptAt) return null;
		return { sleptAt, wokeAt };
	} catch {
		return null;
	}
}

/**
 * Whether a gap with no sign of life (from → to) is explained by a sleep:
 * the sleep overlaps the gap and the awake part of the gap is at most
 * `maxAwakeMs`.
 *
 * @param gap - The gap (epoch ms)
 * @param sleep - The last sleep, or null
 * @param maxAwakeMs - Awake time inside the gap that still counts as "slept"
 * @returns True when the computer was asleep for the gap
 */
export function gapExplainedBySleep(gap: { from: number; to: number }, sleep: SleepWindow | null, maxAwakeMs: number): boolean {
	if (!sleep) return false;
	if (sleep.wokeAt <= gap.from || sleep.sleptAt >= gap.to) return false;
	const awake = Math.max(0, sleep.sleptAt - gap.from) + Math.max(0, gap.to - sleep.wokeAt);
	return awake <= maxAwakeMs;
}
