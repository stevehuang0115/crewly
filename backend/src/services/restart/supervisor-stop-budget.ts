/**
 * Supervisor stop budget.
 *
 * Under systemd, the unit's `TimeoutStopSec` decides when a stopping service
 * is SIGKILLed, whatever the backend's own drain cap says. The unit is
 * written at install time, so a unit from before the 10-minute background
 * drain (steamfun-ops: 150 s) would SIGKILL the backend mid-drain and
 * `saveInterruptedTurns` would never run (PR #1013 review). The backend
 * therefore reads the live `TimeoutStopUSec` and caps its drain to it minus
 * the shutdown margin.
 *
 * @module services/restart/supervisor-stop-budget
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

/** Dependencies (injectable for tests). */
export interface SupervisorBudgetDeps {
	/** Environment */
	env: NodeJS.ProcessEnv;
	/** Read a file (the process's cgroup) */
	readFile: (path: string) => string;
	/** Run systemctl and return stdout */
	systemctl: (args: string[]) => string;
}

const UNITS_MS: Record<string, number> = {
	us: 0.001,
	usec: 0.001,
	ms: 1,
	msec: 1,
	s: 1000,
	sec: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/**
 * Parse a systemd time span ("2min 30s", "150s", "500ms", "infinity").
 *
 * @param text - systemctl output value
 * @returns Milliseconds; null for infinity or unparseable text
 *
 * @example
 * ```typescript
 * parseSystemdTimespanMs('2min 30s'); // 150000
 * ```
 */
export function parseSystemdTimespanMs(text: string): number | null {
	const s = text.trim().toLowerCase();
	if (!s || s === 'infinity') return null;
	if (/^\d+$/.test(s)) return Number(s) * 1000;
	let total = 0;
	let matched = '';
	for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
		const unit = UNITS_MS[m[2]];
		if (unit === undefined) return null;
		total += Number(m[1]) * unit;
		matched += m[0];
	}
	if (matched.replace(/\s+/g, '') !== s.replace(/\s+/g, '')) return null;
	return Math.floor(total);
}

/**
 * The systemd unit a process runs in, from its /proc/self/cgroup.
 *
 * @param cgroup - File content
 * @returns `{ unit, user }`, or null when not in a .service unit
 */
export function systemdUnitFromCgroup(cgroup: string): { unit: string; user: boolean } | null {
	for (const line of cgroup.split('\n')) {
		const path = line.split(':').slice(2).join(':');
		const parts = path.split('/').filter(Boolean);
		const unit = [...parts].reverse().find((p) => p.endsWith('.service'));
		if (!unit) continue;
		const userManager = /^user@\d+\.service$/;
		// Only the user manager itself (a login shell, not a unit of ours).
		if (userManager.test(unit)) return null;
		return { unit, user: parts.some((p) => userManager.test(p)) };
	}
	return null;
}

/**
 * How long the supervisor waits after SIGTERM before SIGKILL, when known.
 *
 * @param deps - Environment, file reader, systemctl runner
 * @returns Milliseconds, or null when not under systemd, unlimited, or unreadable
 */
export function resolveSupervisorStopBudgetMs(deps?: Partial<SupervisorBudgetDeps>): number | null {
	const env = deps?.env ?? process.env;
	// systemd sets INVOCATION_ID for every unit it starts.
	if (!env.INVOCATION_ID) return null;
	const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
	const systemctl =
		deps?.systemctl ?? ((args: string[]) => execFileSync('systemctl', args, { encoding: 'utf-8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }));
	try {
		const where = systemdUnitFromCgroup(readFile('/proc/self/cgroup'));
		if (!where) return null;
		const out = systemctl([...(where.user ? ['--user'] : []), 'show', '-p', 'TimeoutStopUSec', '--value', where.unit]);
		return parseSystemdTimespanMs(out);
	} catch {
		return null;
	}
}

/**
 * Cap a drain so it ends before the supervisor SIGKILLs, leaving the margin
 * for the rest of shutdown (persisting interrupted turns, PTY teardown).
 *
 * @param drainMs - Drain cap the backend wants
 * @param budgetMs - Supervisor stop budget, or null when unlimited / unknown
 * @param marginMs - Time needed after the drain
 * @returns The cap to use (never negative)
 */
export function capDrainToSupervisor(drainMs: number, budgetMs: number | null, marginMs: number): number {
	if (budgetMs === null) return drainMs;
	return Math.max(0, Math.min(drainMs, budgetMs - marginMs));
}
