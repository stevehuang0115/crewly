/**
 * Which agent PTY a local skill process really belongs to.
 *
 * Skills name their caller with `X-Agent-Session`, read from
 * CREWLY_SESSION_NAME in the shell that ran them. That variable is only as
 * good as the process tree it came from: Codex's shared app-server daemon ran
 * every Codex agent's commands with the orchestrator's environment
 * (2026-09-30), so each of them claimed to be `crewly-orc`.
 *
 * Skills also send `X-Agent-Pid` (the skill shell's own pid). On this machine
 * that pid's parent chain leads to exactly one agent PTY shell — the process
 * Crewly spawned for the session — unless it runs under a shared daemon, in
 * which case it leads to no PTY at all. This service walks that chain.
 *
 * @module services/agent/agent-process-origin.service
 */

import { execFile } from 'child_process';
import { AGENT_ORIGIN_CONSTANTS } from '../../constants.js';

/** One row of the process table. */
export interface ProcessEntry {
	ppid: number;
	/** Full command line (only matched against, never logged) */
	args: string;
}

/** Where a skill process came from. */
export interface ProcessOrigin {
	/** The agent session whose PTY is an ancestor, or null when none is */
	session: string | null;
	/** True when the chain reaches Codex's shared app-server daemon (session is then null) */
	viaSharedDaemon: boolean;
}

/**
 * Walk from `pid` up through its parents until an agent PTY shell is found.
 *
 * A shared Codex daemon ends the walk: it is often still the child of the
 * TUI that started it (the orchestrator's), so walking on would "prove" the
 * very identity that leaked.
 *
 * @param pid - Starting process (the skill shell)
 * @param table - pid → {ppid, args}
 * @param sessionPids - PTY shell pid → session name
 * @returns The owning session (or null) and whether a shared Codex daemon sits in between
 */
export function resolveProcessOrigin(
	pid: number,
	table: ReadonlyMap<number, ProcessEntry>,
	sessionPids: ReadonlyMap<number, string>,
): ProcessOrigin {
	let current = pid;
	const seen = new Set<number>();
	for (let depth = 0; depth < AGENT_ORIGIN_CONSTANTS.MAX_ANCESTRY_DEPTH && current > 1 && !seen.has(current); depth++) {
		seen.add(current);
		const session = sessionPids.get(current);
		if (session) return { session, viaSharedDaemon: false };
		const entry = table.get(current);
		if (!entry) break;
		if (AGENT_ORIGIN_CONSTANTS.SHARED_DAEMON_ARGS_RE.test(entry.args)) return { session: null, viaSharedDaemon: true };
		current = entry.ppid;
	}
	return { session: null, viaSharedDaemon: false };
}

/**
 * Parse `ps -Ao pid=,ppid=,args=` output.
 *
 * @param output - Raw ps output
 * @returns pid → entry
 */
export function parseProcessTable(output: string): Map<number, ProcessEntry> {
	const table = new Map<number, ProcessEntry>();
	for (const line of output.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
		if (!match) continue;
		table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] ?? '' });
	}
	return table;
}

/**
 * Read the process table with one `ps` call (same flags on Linux and macOS).
 *
 * @returns pid → entry
 */
export function readProcessTable(): Promise<Map<number, ProcessEntry>> {
	return new Promise((resolve, reject) => {
		execFile(
			'ps',
			['-Ao', 'pid=,ppid=,args='],
			{ timeout: AGENT_ORIGIN_CONSTANTS.LOOKUP_TIMEOUT_MS, maxBuffer: AGENT_ORIGIN_CONSTANTS.PS_MAX_BUFFER_BYTES },
			(error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout))),
		);
	});
}

/** Injectable pieces (tests). */
export interface AgentProcessOriginDeps {
	readTable?: () => Promise<Map<number, ProcessEntry>>;
	/** PTY shell pid → session name for the live agent sessions */
	listSessionPids?: () => Map<number, string>;
	now?: () => number;
}

/**
 * Resolves skill pids to agent sessions, caching per pid for a short while
 * (one skill run makes several API calls from the same shell).
 */
export class AgentProcessOriginService {
	private readonly cache = new Map<number, { origin: ProcessOrigin; at: number }>();
	private readonly readTable: () => Promise<Map<number, ProcessEntry>>;
	private readonly listSessionPids: () => Map<number, string>;
	private readonly now: () => number;

	/**
	 * @param deps - Injectable dependencies
	 */
	constructor(deps: AgentProcessOriginDeps & { listSessionPids: () => Map<number, string> }) {
		this.readTable = deps.readTable ?? readProcessTable;
		this.listSessionPids = deps.listSessionPids;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Where a local skill process came from.
	 *
	 * @param pid - The skill shell's pid (from X-Agent-Pid)
	 * @returns The origin; `{session: null}` when there are no agent sessions
	 */
	async resolve(pid: number): Promise<ProcessOrigin> {
		const hit = this.cache.get(pid);
		if (hit && this.now() - hit.at < AGENT_ORIGIN_CONSTANTS.RESULT_CACHE_TTL_MS) return hit.origin;
		const sessionPids = this.listSessionPids();
		const origin = sessionPids.size === 0
			? { session: null, viaSharedDaemon: false }
			: resolveProcessOrigin(pid, await this.readTable(), sessionPids);
		if (this.cache.size >= AGENT_ORIGIN_CONSTANTS.RESULT_CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(pid, { origin, at: this.now() });
		return origin;
	}
}
