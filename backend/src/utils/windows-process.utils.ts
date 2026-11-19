/**
 * Process and socket lookups on Windows, where `ps`, `pgrep`, `lsof` and `ss`
 * do not exist.
 *
 * The process table comes from one PowerShell `Get-CimInstance Win32_Process`
 * call, printed as `pid ppid command line` — the shape the `ps`-based parsers
 * in this codebase already read. Socket owners come from `netstat -ano`.
 * PowerShell takes several hundred milliseconds to start, so the synchronous
 * reader caches its snapshot briefly.
 *
 * @module utils/windows-process
 */
import { execFile, execFileSync, spawnSync } from 'child_process';

/** Tunables. */
export const WINDOWS_PROCESS_CONSTANTS = {
	/** PowerShell start-up plus the CIM query; far slower than `ps` */
	QUERY_TIMEOUT_MS: 8_000,
	/** `netstat -ano` budget */
	NETSTAT_TIMEOUT_MS: 5_000,
	/** How long a synchronous snapshot is reused */
	SNAPSHOT_TTL_MS: 3_000,
	/** Output cap (a busy machine lists a few hundred KB) */
	MAX_BUFFER_BYTES: 16 * 1024 * 1024,
	/** Longest parent chain walked */
	MAX_DEPTH: 64,
} as const;

/** `powershell.exe` arguments that print one `pid ppid command line` row per process. */
export const WINDOWS_PROCESS_QUERY_ARGS: readonly string[] = [
	'-NoProfile',
	'-NonInteractive',
	'-Command',
	"Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) }",
];

/** One process. */
export interface WindowsProcessRow {
	pid: number;
	ppid: number;
	/** Command line, or the image name when Windows hides the command line */
	command: string;
}

/**
 * Parse the query's output.
 *
 * @param output - `pid ppid command line` rows (CRLF or LF)
 * @returns Rows
 */
export function parseWindowsProcessRows(output: string): WindowsProcessRow[] {
	const rows: WindowsProcessRow[] = [];
	for (const line of output.split(/\r?\n/)) {
		const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: (m[3] ?? '').trim() });
	}
	return rows;
}

/**
 * Read the Windows process table (async).
 *
 * @param timeoutMs - Budget
 * @returns Raw `pid ppid command line` output
 * @throws When PowerShell cannot be run or exceeds the budget
 */
export function queryWindowsProcesses(timeoutMs: number = WINDOWS_PROCESS_CONSTANTS.QUERY_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'powershell.exe',
			[...WINDOWS_PROCESS_QUERY_ARGS],
			{ timeout: timeoutMs, maxBuffer: WINDOWS_PROCESS_CONSTANTS.MAX_BUFFER_BYTES, windowsHide: true },
			(error, stdout) => (error ? reject(error) : resolve(stdout ?? '')),
		);
	});
}

let snapshot: { at: number; rows: WindowsProcessRow[] } | null = null;

/**
 * Read the Windows process table synchronously, reusing a snapshot younger
 * than {@link WINDOWS_PROCESS_CONSTANTS.SNAPSHOT_TTL_MS}.
 *
 * @param now - Clock (tests)
 * @returns Rows; empty when the query fails
 */
export function readWindowsProcessesSync(now: number = Date.now()): WindowsProcessRow[] {
	if (snapshot && now - snapshot.at < WINDOWS_PROCESS_CONSTANTS.SNAPSHOT_TTL_MS) return snapshot.rows;
	let rows: WindowsProcessRow[] = [];
	try {
		const out = execFileSync('powershell.exe', [...WINDOWS_PROCESS_QUERY_ARGS], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: WINDOWS_PROCESS_CONSTANTS.QUERY_TIMEOUT_MS,
			maxBuffer: WINDOWS_PROCESS_CONSTANTS.MAX_BUFFER_BYTES,
			windowsHide: true,
		});
		rows = parseWindowsProcessRows(out);
	} catch {
		rows = [];
	}
	snapshot = { at: now, rows };
	return rows;
}

/** Drop the cached snapshot — test affordance. */
export function _resetWindowsProcessSnapshotForTesting(): void {
	snapshot = null;
}

/** Image name of a shell or its console host: these do not mean "something is running in the session". */
const SHELL_OR_CONSOLE = /(?:^|[\\/"])(?:bash|sh|conhost|OpenConsole)(?:\.exe)?(?:["\s]|$)/i;

/**
 * Whether anything other than a shell runs under a session's shell.
 *
 * `pgrep -P <shell pid>` answers this on POSIX. On Windows the session's
 * `Git\bin\bash.exe` is a launcher whose child is the real
 * `Git\usr\bin\bash.exe`, and ConPTY adds a `conhost.exe`: a plain "has a
 * child" is always true. So the whole tree under the pid is walked and shells
 * and console hosts are not counted.
 *
 * @param rows - Process table
 * @param rootPid - The session's shell pid
 * @returns True when a non-shell descendant exists (the runtime, or a command it started)
 *
 * @example
 * ```typescript
 * // bash.exe(10) → bash.exe(11) → node.exe(12)
 * hasNonShellDescendant(rows, 10); // true
 * ```
 */
export function hasNonShellDescendant(rows: readonly WindowsProcessRow[], rootPid: number): boolean {
	const children = new Map<number, WindowsProcessRow[]>();
	for (const row of rows) {
		const list = children.get(row.ppid);
		if (list) list.push(row);
		else children.set(row.ppid, [row]);
	}
	const seen = new Set<number>([rootPid]);
	let frontier = [rootPid];
	for (let depth = 0; depth < WINDOWS_PROCESS_CONSTANTS.MAX_DEPTH && frontier.length > 0; depth++) {
		const next: number[] = [];
		for (const pid of frontier) {
			for (const child of children.get(pid) ?? []) {
				if (seen.has(child.pid)) continue;
				seen.add(child.pid);
				if (!SHELL_OR_CONSOLE.test(child.command)) return true;
				next.push(child.pid);
			}
		}
		frontier = next;
	}
	return false;
}

/**
 * The pid that owns the client end of a local TCP connection, from
 * `netstat -ano` output:
 * `  TCP    127.0.0.1:51000    127.0.0.1:8787    ESTABLISHED    4242`
 * (IPv6 rows read `[::1]:51000`).
 *
 * @param output - netstat output
 * @param clientPort - The client's ephemeral port (local port of its row)
 * @param serverPort - This backend's port (foreign port of its row)
 * @returns pid, or null when no row matches
 */
export function parseNetstatPeer(output: string, clientPort: number, serverPort: number): number | null {
	for (const line of output.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || cols[0] !== 'TCP') continue;
		if (!cols[1].endsWith(`:${clientPort}`) || !cols[2].endsWith(`:${serverPort}`)) continue;
		const pid = Number(cols[cols.length - 1]);
		if (Number.isInteger(pid) && pid > 0) return pid;
	}
	return null;
}

/**
 * Run `netstat -ano` (every TCP row with its owning pid, IPv4 and IPv6).
 *
 * @param timeoutMs - Budget
 * @returns netstat output
 * @throws When netstat cannot be run or exceeds the budget
 */
export function queryNetstat(timeoutMs: number = WINDOWS_PROCESS_CONSTANTS.NETSTAT_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('netstat', ['-ano'], { timeout: timeoutMs, maxBuffer: WINDOWS_PROCESS_CONSTANTS.MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout) =>
			error ? reject(error) : resolve(stdout ?? ''),
		);
	});
}

/** `taskkill` budget (ms). */
export const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * End a process and everything under it on Windows (`taskkill /T /F`).
 *
 * Closing a ConPTY only disconnects the console: the shell and whatever it
 * started (the agent runtime) keep running. Windows has no process groups to
 * signal, so each killed session used to leave a `bash.exe` and a
 * `claude.exe` behind — 20 runtimes and 42 shells after 25 minutes of
 * restarts on the first real Windows machine (2026-11-19). The tree must be
 * ended while its root is still alive: once the root is gone its children
 * can no longer be found from it.
 *
 * @param pid - Root of the tree (a session's shell)
 * @param run - Command runner (tests)
 * @returns True when taskkill ran and reported success
 *
 * @example
 * ```typescript
 * killWindowsProcessTree(session.pid);
 * ```
 */
export function killWindowsProcessTree(
	pid: number,
	run: (file: string, args: string[]) => { status: number | null } = (file, args) =>
		spawnSync(file, args, { stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }),
): boolean {
	// node-pty reports pid 0 until ConPTY has started the process: nothing to end yet.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		return run('taskkill', ['/PID', String(pid), '/T', '/F']).status === 0;
	} catch {
		return false;
	}
}
