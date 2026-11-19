/**
 * Windows: find and end Crewly agent process trees that outlived their
 * backend.
 *
 * Windows has no process groups and does not re-parent: when a backend dies
 * or restarts, each agent session's `bash.exe` keeps running with a parent
 * pid that no longer exists, and its `claude.exe` with it. `crewly stop`
 * finds processes through the backend's own tree and the port's listeners,
 * so it never saw them (one machine: 20 `claude.exe` ≈ 3.7 GB and 42
 * `bash.exe`, 2026-11-19).
 *
 * They are found by COMMAND LINE, and only by what a Crewly launch alone
 * carries (see {@link isCrewlyAgentCommand}). The user's own Claude Code
 * sessions on the machine never match.
 *
 * @module cli/utils/windows-agent-sweep
 */

import { CONTROL_PLANE_GUARD_CONSTANTS } from '../../../backend/src/constants.js';
import { CREWLY_BACKEND_COMMAND_PATTERN } from './process-cleanup.js';
import type { ProcessRow, RunCommand } from './backend-status.js';

/** One process, with when it started. */
export interface StartedProcessRow extends ProcessRow {
	/** Creation time as a Windows file time (UTC, 100 ns units); 0 when Windows does not tell */
	startedAt: number;
}

/**
 * Lists `pid ppid started command line` per process. The creation time tells
 * a real parent from an unrelated process that was given a dead parent's pid.
 */
export const WINDOWS_AGENT_TABLE_COMMAND =
	'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ForEach-Object { \'{0} {1} {2} {3}\' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.CommandLine }"';

/** Flag every Crewly agent launch of Claude Code carries (the settings flag is only added next to it). */
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * `--settings <CREWLY_HOME>/runtime/control-plane/<session>.settings.json`:
 * the per-session settings file Crewly generates and passes at launch. Either
 * slash is accepted, since the path reaches Windows through Git Bash.
 */
const CONTROL_PLANE_SETTINGS_ARG = new RegExp(
	`${CONTROL_PLANE_GUARD_CONSTANTS.SETTINGS_FLAG}(?:\\s+|=)"?[^"]*[\\\\/]` +
		`${CONTROL_PLANE_GUARD_CONSTANTS.RUNTIME_DIR.split('/').join('[\\\\/]')}[\\\\/][^"\\\\/]+` +
		CONTROL_PLANE_GUARD_CONSTANTS.SETTINGS_FILE_SUFFIX.replace(/\./g, '\\.'),
);

/** A command line whose executable is `bash` or `sh` (quoted, bare, or an unquoted path with spaces). */
const SHELL_COMMAND = /^(?:"[^"]*[\\/](?:bash|sh)(?:\.exe)?"|(?:[^\s"]*[\\/])?(?:bash|sh)(?:\.exe)?(?:\s|$)|[^"]*?[\\/](?:bash|sh)\.exe(?:\s|$))/i;

/** Longest parent chain walked. */
const MAX_ANCESTOR_DEPTH = 16;

/**
 * Parse {@link WINDOWS_AGENT_TABLE_COMMAND} output.
 *
 * @param stdout - `pid ppid started command line` rows (CRLF or LF)
 * @returns Rows
 */
export function parseWindowsAgentTable(stdout: string): StartedProcessRow[] {
	const rows: StartedProcessRow[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: Number(m[3]), command: (m[4] ?? '').trim() });
	}
	return rows;
}

/**
 * Whether a command line is a Claude Code that Crewly launched as an agent.
 *
 * Both markers must be present: `--dangerously-skip-permissions`, and a
 * `--settings` argument pointing at a `runtime/control-plane/*.settings.json`
 * file, which only Crewly generates (under `~/.crewly`). The word `claude`
 * is not looked at: the user's own sessions (`claude`, `claude
 * remote-control`, `claude --dangerously-skip-permissions`) carry no such
 * settings argument and never match.
 *
 * @param command - Full command line
 * @returns True for a Crewly-launched agent runtime
 *
 * @example
 * ```typescript
 * isCrewlyAgentCommand('claude.exe --dangerously-skip-permissions --agent "crewly-orc" --settings "C:/Users/me/.crewly/runtime/control-plane/crewly-orc.settings.json"'); // true
 * isCrewlyAgentCommand('claude.exe remote-control'); // false
 * ```
 */
export function isCrewlyAgentCommand(command: string): boolean {
	return command.includes(SKIP_PERMISSIONS_FLAG) && CONTROL_PLANE_SETTINGS_ARG.test(command);
}

/**
 * Whether a command line runs `bash` or `sh`.
 *
 * @param command - Full command line
 * @returns True for a shell
 */
export function isShellCommand(command: string): boolean {
	return SHELL_COMMAND.test(command);
}

/**
 * Pick the roots of orphaned Crewly agent trees, so that each agent goes
 * with its session shell.
 *
 * For every Crewly agent process ({@link isCrewlyAgentCommand}) the parent
 * chain is climbed for as long as the parent is its real parent (it exists
 * and started no later than the child: a later one only reuses the pid) and
 * is a shell or another agent process. The result is:
 * - the top-most such ancestor when its own parent is gone — the session's
 *   outer `bash.exe`, or the agent process itself when it has no shell;
 * - nothing when the chain reaches a live Crewly backend (the agent is owned
 *   by a running backend, e.g. one on another port), a protected pid, any
 *   other live process (something else launched it), or a link whose start
 *   times Windows did not report (cannot tell — left alone).
 *
 * @param rows - Process table with start times
 * @param protectedPids - This process and its ancestors: never selected
 * @returns Tree roots to end, in table order, without duplicates
 *
 * @example
 * ```typescript
 * // bash.exe(10, parent 4 gone) → bash.exe(11) → claude.exe(12, Crewly settings)
 * selectOrphanedAgentTreeRoots(rows, new Set()).map((r) => r.pid); // [10]
 * ```
 */
export function selectOrphanedAgentTreeRoots(
	rows: readonly StartedProcessRow[],
	protectedPids: ReadonlySet<number> = new Set(),
): StartedProcessRow[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const roots = new Map<number, StartedProcessRow>();
	for (const row of rows) {
		if (!isCrewlyAgentCommand(row.command) || protectedPids.has(row.pid)) continue;
		let top = row;
		let orphaned = false;
		for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
			const parent = byPid.get(top.ppid);
			if (!parent || parent.pid === top.pid) {
				orphaned = true;
				break;
			}
			if (!top.startedAt || !parent.startedAt) break;
			if (parent.startedAt > top.startedAt) {
				orphaned = true;
				break;
			}
			if (protectedPids.has(parent.pid) || CREWLY_BACKEND_COMMAND_PATTERN.test(parent.command)) break;
			if (!isShellCommand(parent.command) && !isCrewlyAgentCommand(parent.command)) break;
			top = parent;
		}
		if (orphaned) roots.set(top.pid, top);
	}
	return [...roots.values()];
}

/**
 * A root and every process under it, counting a process as a child only when
 * it started no earlier than its parent.
 *
 * `taskkill /T` follows parent pids alone. Windows reuses pids, so an
 * unrelated, older process whose long-dead parent once had the root's pid
 * would be ended with the tree. The start times rule that out.
 *
 * @param rows - Process table with start times
 * @param root - Tree root
 * @returns The root first, then its descendants, parents before children
 */
export function collectStartedTree(rows: readonly StartedProcessRow[], root: StartedProcessRow): StartedProcessRow[] {
	const byParent = new Map<number, StartedProcessRow[]>();
	for (const row of rows) {
		const list = byParent.get(row.ppid) ?? [];
		list.push(row);
		byParent.set(row.ppid, list);
	}
	const tree = [root];
	const seen = new Set<number>([root.pid]);
	for (let i = 0; i < tree.length; i++) {
		const parent = tree[i];
		for (const child of byParent.get(parent.pid) ?? []) {
			if (seen.has(child.pid) || !child.startedAt || !parent.startedAt || child.startedAt < parent.startedAt) continue;
			seen.add(child.pid);
			tree.push(child);
		}
	}
	return tree;
}

/** One orphaned agent tree the sweep handled. */
export interface SweptAgentTree {
	/** The tree's root (the session's outer shell, or the agent process) */
	root: StartedProcessRow;
	/** Processes in the tree, root included */
	processCount: number;
}

/** What the sweep did. */
export interface AgentSweepResult {
	/** Trees that were ended */
	ended: SweptAgentTree[];
	/** Trees with a process that is still running */
	failed: SweptAgentTree[];
}

/** Side effects of the sweep, injectable for tests. */
export interface AgentSweepDeps {
	/** Shell runner (reads the process table) */
	run: RunCommand;
	/** Ends one process at once; a failure means it is already gone */
	kill: (pid: number) => Promise<void>;
	/** Whether a pid still exists */
	isAlive: (pid: number) => Promise<boolean>;
	/** Platform (default: this process's) */
	platform?: NodeJS.Platform;
}

/**
 * End orphaned Crewly agent trees. Does nothing, and runs nothing, on any
 * platform but Windows.
 *
 * @param protectedPids - This process and its ancestors: never ended
 * @param deps - Side effects
 * @returns The trees ended and the trees that survived (both empty when the table cannot be read)
 */
export async function sweepOrphanedWindowsAgents(protectedPids: ReadonlySet<number>, deps: AgentSweepDeps): Promise<AgentSweepResult> {
	const result: AgentSweepResult = { ended: [], failed: [] };
	if ((deps.platform ?? process.platform) !== 'win32') return result;
	let rows: StartedProcessRow[];
	try {
		rows = parseWindowsAgentTable(await deps.run(WINDOWS_AGENT_TABLE_COMMAND));
	} catch {
		return result;
	}
	for (const root of selectOrphanedAgentTreeRoots(rows, protectedPids)) {
		const tree = collectStartedTree(rows, root).filter((row) => !protectedPids.has(row.pid));
		for (const row of tree) await deps.kill(row.pid);
		let survivor = false;
		for (const row of tree) survivor = survivor || (await deps.isAlive(row.pid));
		(survivor ? result.failed : result.ended).push({ root, processCount: tree.length });
	}
	return result;
}
