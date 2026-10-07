/**
 * Scheduled commands runner.
 *
 * Runs host commands listed in `<CREWLY_HOME>/scheduled-commands.json` on an
 * interval. It exists because launchd jobs cannot read ~/Desktop (TCC), while
 * the backend can. Design rules:
 * - The list is read from disk only. There is deliberately no API route or
 *   trigger action that adds an entry: that would be arbitrary shell
 *   execution through the API.
 * - No file = no jobs = feature off.
 * - Each run is spawned DETACHED (own process group, unref'd, output to a log
 *   file) so a Crewly restart cannot kill it mid-way (a rollout cut in half
 *   leaves a mixed fleet).
 * - A run never starts while the previous one is alive: checked by the pid we
 *   spawned and, when `lockFile` is set, by the pid inside the command's own
 *   lock file (a stale pid counts as dead).
 * - Each child gets the scheduler credential in its environment
 *   (`CREWLY_SCHEDULER_CREDENTIAL`, plus `CREWLY_SCHEDULER_NAME`), so a skill it
 *   calls (send-message) can deliver a note to an agent, and nothing else. The
 *   credential is minted in memory per spawn and is never written to a file or
 *   a log.
 * - Every skip is logged at debug; a run is logged at info only when spawned.
 *
 * Config shape: `[{name, cwd, command, args?, intervalMinutes, enabled?, lockFile?}]`.
 *
 * @module services/system/scheduled-commands
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OWNER_AUTH_CONSTANTS, SCHEDULED_COMMANDS } from '../../constants.js';
import { mintInternalCredential } from '../core/owner-auth.service.js';

/** One validated entry from the config file. */
export interface ScheduledCommand {
	/** Unique name (used in the log file name) */
	name: string;
	/** Absolute working directory */
	cwd: string;
	/** Executable, run without a shell */
	command: string;
	/** Arguments */
	args: string[];
	/** Minutes between runs */
	intervalMinutes: number;
	/** Absolute path of the command's own lock file (holds a pid), optional */
	lockFile?: string;
}

/** Result of reading the config file. */
export interface LoadedScheduledCommands {
	/** Enabled, valid entries */
	entries: ScheduledCommand[];
	/** Entries in the file that were valid but disabled */
	disabled: number;
	/** Why the file or an entry was not used (one line each) */
	warnings: string[];
}

/** Minimal logger contract. */
export interface ScheduledCommandsLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

/** Injection points (tests replace the process and filesystem edges). */
export interface ScheduledCommandsDeps {
	/** Path of the config file */
	configPath: string;
	/** Directory for per-command log files */
	logDir: string;
	logger: ScheduledCommandsLogger;
	/** child_process.spawn */
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** True when a process with this pid exists */
	isPidAlive?: (pid: number) => boolean;
	/** Reads a text file; throws when missing */
	readFile?: (file: string) => string;
	/** True when the path exists */
	pathExists?: (file: string) => boolean;
	/** Opens the log file for appending and returns an fd */
	openLog?: (file: string) => number;
	/** Closes an fd */
	closeLog?: (fd: number) => void;
}

/**
 * Expand a leading `~` to the home directory.
 *
 * @param p - Path from the config file
 * @returns Path with `~` expanded
 */
function expandHome(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * True when a process with this pid exists (signal 0 probe).
 *
 * @param pid - Process id
 * @returns Whether it is alive
 */
export function defaultIsPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = exists but not ours: still alive.
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Parse and validate the config text.
 *
 * Invalid input never throws: it yields zero entries and a warning.
 *
 * @param text - File contents
 * @returns Entries, disabled count and warnings
 */
export function parseScheduledCommands(text: string): LoadedScheduledCommands {
	const out: LoadedScheduledCommands = { entries: [], disabled: 0, warnings: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		out.warnings.push(`config is not valid JSON (${err instanceof Error ? err.message : String(err)}); 0 jobs`);
		return out;
	}
	if (!Array.isArray(raw)) {
		out.warnings.push('config must be a JSON array; 0 jobs');
		return out;
	}
	const seen = new Set<string>();
	raw.forEach((item, i) => {
		const label = `entry ${i}`;
		if (!item || typeof item !== 'object') {
			out.warnings.push(`${label}: not an object; skipped`);
			return;
		}
		const e = item as Record<string, unknown>;
		if (typeof e.name !== 'string' || !SCHEDULED_COMMANDS.NAME_PATTERN.test(e.name)) {
			out.warnings.push(`${label}: name must match ${SCHEDULED_COMMANDS.NAME_PATTERN}; skipped`);
			return;
		}
		if (seen.has(e.name)) {
			out.warnings.push(`${label} (${e.name}): duplicate name; skipped`);
			return;
		}
		if (typeof e.command !== 'string' || e.command.trim() === '') {
			out.warnings.push(`${label} (${e.name}): command is required; skipped`);
			return;
		}
		if (typeof e.cwd !== 'string' || !path.isAbsolute(expandHome(e.cwd))) {
			out.warnings.push(`${label} (${e.name}): cwd must be an absolute path; skipped`);
			return;
		}
		if (e.args !== undefined && (!Array.isArray(e.args) || e.args.some((a) => typeof a !== 'string'))) {
			out.warnings.push(`${label} (${e.name}): args must be an array of strings; skipped`);
			return;
		}
		if (
			typeof e.intervalMinutes !== 'number' ||
			!Number.isFinite(e.intervalMinutes) ||
			e.intervalMinutes < SCHEDULED_COMMANDS.MIN_INTERVAL_MINUTES
		) {
			out.warnings.push(
				`${label} (${e.name}): intervalMinutes must be a number >= ${SCHEDULED_COMMANDS.MIN_INTERVAL_MINUTES}; skipped`,
			);
			return;
		}
		if (e.lockFile !== undefined && (typeof e.lockFile !== 'string' || !path.isAbsolute(expandHome(e.lockFile)))) {
			out.warnings.push(`${label} (${e.name}): lockFile must be an absolute path; skipped`);
			return;
		}
		seen.add(e.name);
		if (e.enabled === false) {
			out.disabled++;
			return;
		}
		out.entries.push({
			name: e.name,
			cwd: expandHome(e.cwd),
			command: e.command,
			args: (e.args as string[] | undefined) ?? [],
			intervalMinutes: e.intervalMinutes,
			lockFile: typeof e.lockFile === 'string' ? expandHome(e.lockFile) : undefined,
		});
	});
	return out;
}

/** Outcome of one tick for one entry (also returned to tests). */
export type RunOutcome = 'spawned' | 'skipped-running' | 'skipped-lock' | 'skipped-no-cwd' | 'spawn-failed';

/**
 * Interval runner for owner-configured host commands.
 */
export class ScheduledCommandsService {
	private readonly deps: Required<ScheduledCommandsDeps>;
	private entries: ScheduledCommand[] = [];
	private timers: NodeJS.Timeout[] = [];
	/** Last spawned pid per entry name */
	private readonly lastPid = new Map<string, number>();

	/**
	 * @param deps - Paths, logger and optional process/filesystem overrides
	 */
	constructor(deps: ScheduledCommandsDeps) {
		this.deps = {
			spawn: nodeSpawn as unknown as Required<ScheduledCommandsDeps>['spawn'],
			isPidAlive: defaultIsPidAlive,
			readFile: (f) => readFileSync(f, 'utf-8'),
			pathExists: existsSync,
			openLog: (f) => {
				mkdirSync(path.dirname(f), { recursive: true });
				return openSync(f, 'a');
			},
			closeLog: closeSync,
			...deps,
		};
	}

	/**
	 * Load the config and schedule every enabled entry.
	 *
	 * Logs "N scheduled command(s) loaded" every time, including 0.
	 * A missing file is the normal off state (info); an unreadable or
	 * invalid file logs one warn line.
	 *
	 * @returns Number of jobs scheduled
	 */
	start(): number {
		this.stop();
		let text: string;
		try {
			text = this.deps.readFile(this.deps.configPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				this.deps.logger.info('0 scheduled command(s) loaded (no config file)', { path: this.deps.configPath });
			} else {
				this.deps.logger.warn('0 scheduled command(s) loaded: config unreadable', {
					path: this.deps.configPath,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			return 0;
		}
		const loaded = parseScheduledCommands(text);
		loaded.warnings.forEach((w) => this.deps.logger.warn(`scheduled-commands: ${w}`));
		this.entries = loaded.entries;
		this.deps.logger.info(`${loaded.entries.length} scheduled command(s) loaded`, {
			disabled: loaded.disabled,
			invalid: loaded.warnings.length,
			names: loaded.entries.map((e) => e.name),
		});
		for (const entry of this.entries) {
			const every = entry.intervalMinutes * SCHEDULED_COMMANDS.MS_PER_MINUTE;
			const first = setTimeout(() => this.runEntry(entry), SCHEDULED_COMMANDS.INITIAL_DELAY_MS);
			const repeat = setInterval(() => this.runEntry(entry), every);
			first.unref();
			repeat.unref();
			this.timers.push(first, repeat);
		}
		return this.entries.length;
	}

	/** Cancel all timers. Spawned children are NOT touched (they are detached). */
	stop(): void {
		for (const t of this.timers) {
			clearTimeout(t);
			clearInterval(t);
		}
		this.timers = [];
		this.entries = [];
	}

	/**
	 * Try to run one entry now.
	 *
	 * Skips (debug log) when the previous run or the command's own lock holder
	 * is alive, or the cwd is missing (warn). Never claims a run happened
	 * when it was skipped.
	 *
	 * @param entry - Entry to run
	 * @returns What happened
	 */
	runEntry(entry: ScheduledCommand): RunOutcome {
		const { logger, isPidAlive } = this.deps;
		const prev = this.lastPid.get(entry.name);
		if (prev !== undefined && isPidAlive(prev)) {
			logger.debug(`scheduled-commands: ${entry.name} skipped, previous run pid ${prev} still alive`);
			return 'skipped-running';
		}
		if (entry.lockFile) {
			let holder = NaN;
			try {
				holder = parseInt(this.deps.readFile(entry.lockFile).trim(), 10);
			} catch {
				// No lock file = nobody holds it.
			}
			if (Number.isInteger(holder) && isPidAlive(holder)) {
				logger.debug(`scheduled-commands: ${entry.name} skipped, lock held by pid ${holder}`);
				return 'skipped-lock';
			}
		}
		if (!this.deps.pathExists(entry.cwd)) {
			logger.warn(`scheduled-commands: ${entry.name} not run, cwd missing`, { cwd: entry.cwd });
			return 'skipped-no-cwd';
		}
		let fd = -1;
		try {
			const logFile = path.join(
				this.deps.logDir,
				SCHEDULED_COMMANDS.LOG_FILE_TEMPLATE.replace('{name}', entry.name),
			);
			fd = this.deps.openLog(logFile);
			const child = this.deps.spawn(entry.command, entry.args, {
				cwd: entry.cwd,
				detached: true,
				stdio: ['ignore', fd, fd],
				env: {
					...process.env,
					[OWNER_AUTH_CONSTANTS.SCHEDULER_CREDENTIAL_ENV]: mintInternalCredential('scheduler'),
					[OWNER_AUTH_CONSTANTS.SCHEDULER_NAME_ENV]: entry.name,
				},
			});
			child.on('error', (err) =>
				logger.error(`scheduled-commands: ${entry.name} failed to start`, { error: err.message }),
			);
			child.unref();
			if (child.pid === undefined) {
				logger.error(`scheduled-commands: ${entry.name} did not start (no pid)`);
				return 'spawn-failed';
			}
			this.lastPid.set(entry.name, child.pid);
			logger.info(`scheduled-commands: ${entry.name} started`, { pid: child.pid, cwd: entry.cwd });
			return 'spawned';
		} catch (err) {
			logger.error(`scheduled-commands: ${entry.name} spawn threw`, {
				error: err instanceof Error ? err.message : String(err),
			});
			return 'spawn-failed';
		} finally {
			if (fd >= 0) {
				try {
					this.deps.closeLog(fd);
				} catch {
					// Already closed.
				}
			}
		}
	}
}
