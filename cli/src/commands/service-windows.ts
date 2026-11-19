/**
 * `crewly service` on Windows: start Crewly at sign-in and keep it running,
 * without administrator rights.
 *
 * Three pieces, all per-user:
 * - a **supervisor** (`~/.crewly/crewly-supervisor.cjs`): a small Node script
 *   that runs `crewly start`, relaunches it when it exits, and stays down
 *   after a deliberate stop (the shutdown marker `crewly stop` writes);
 * - a **Run entry** (`HKCU\…\CurrentVersion\Run`) that starts the supervisor
 *   at sign-in;
 * - a **scheduled task** every few minutes that starts the supervisor again
 *   when it is gone (it does nothing while Crewly runs or was stopped on
 *   purpose).
 *
 * Both entries go through a one-line `.vbs` launcher so no console window
 * appears. Nothing runs before the user signs in: agents need the user's
 * session (their sign-ins live there).
 *
 * @module cli/commands/service-windows
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import chalk from 'chalk';
import { SAFE_RESTART_CONSTANTS, SERVER_CONSTANTS } from '../../../config/index.js';
import { resolveCrewlyHome } from '../utils/backend-respawn.js';
import { resolvePackageRoot } from '../utils/package-root.js';
import { writeShutdownMarker } from '../utils/shutdown-marker.js';

/** Names and timings of the Windows service pieces. */
export const WINDOWS_SERVICE = {
	/** Per-user programs started at sign-in */
	RUN_KEY: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
	/** Value name under RUN_KEY */
	RUN_VALUE: 'CrewlyBackend',
	/** Scheduled task that restarts a missing supervisor */
	TASK_NAME: 'CrewlyWatchdog',
	/** Minutes between runs of the task */
	WATCHDOG_MINUTES: 5,
	/** Supervisor script, in the Crewly home */
	SUPERVISOR_FILE: 'crewly-supervisor.cjs',
	/** Windowless launcher, in the Crewly home */
	LAUNCHER_FILE: 'crewly-start.vbs',
	/** The running supervisor's pid, refreshed while it lives */
	LOCK_FILE: 'crewly-supervisor.pid',
	/** Argument that marks a run started by the scheduled task */
	WATCHDOG_ARG: 'watchdog',
	/** How often the supervisor refreshes its lock (ms) */
	LOCK_REFRESH_MS: 60_000,
	/** A lock not refreshed for this long belongs to a dead supervisor (ms) */
	LOCK_STALE_MS: 180_000,
	/** How long a port check may take (ms) */
	PORT_CHECK_TIMEOUT_MS: 2_000,
	/** Port Crewly listens on unless CREWLY_WEB_PORT says otherwise */
	DEFAULT_PORT: 8787,
	/** CLI entry inside the package */
	CLI_ENTRY: 'dist/cli/cli/src/index.js',
	/** Shared service log, in `<crewlyHome>/logs` */
	LOG_FILE: 'service.log',
	/** Backend pid file other commands read */
	PID_FILE: 'crewly.pid',
	/** How long a registry / scheduler command may take (ms) */
	COMMAND_TIMEOUT_MS: 15_000,
} as const;

/** Result of one external command. */
export interface WindowsCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Runs `reg.exe` / `schtasks.exe` (injected in tests). */
export type WindowsCommandRunner = (file: string, args: readonly string[]) => Promise<WindowsCommandResult>;

/** What the service commands touch; injected in tests. */
export interface WindowsServiceDeps {
	run?: WindowsCommandRunner;
	crewlyHome?: string;
	projectRoot?: string | null;
	nodePath?: string;
	/** Print one line */
	print?: (line: string) => void;
	/** Start the launcher without waiting for it */
	launch?: (launcherPath: string) => void;
	/** Whether something listens on the Crewly port */
	isPortBusy?: (port: number) => Promise<boolean>;
	now?: () => number;
}

/** Paths of the generated files. */
export interface WindowsServicePaths {
	supervisor: string;
	launcher: string;
	lock: string;
	log: string;
}

/**
 * Run a command without a shell and collect its output. Never rejects.
 *
 * @param file - Executable
 * @param args - Arguments
 * @returns Whether it exited 0, and its output
 */
const defaultRun: WindowsCommandRunner = (file, args) =>
	new Promise((resolve) => {
		execFile(file, [...args], { timeout: WINDOWS_SERVICE.COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});

/**
 * Whether something accepts connections on a local port.
 *
 * @param port - TCP port
 * @returns True when a connection opens
 */
export function isLocalPortBusy(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: '127.0.0.1' });
		const done = (busy: boolean): void => {
			socket.destroy();
			resolve(busy);
		};
		socket.setTimeout(WINDOWS_SERVICE.PORT_CHECK_TIMEOUT_MS, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/**
 * Where the generated files live.
 *
 * @param crewlyHome - Crewly home
 * @returns Absolute paths
 */
export function windowsServicePaths(crewlyHome: string = resolveCrewlyHome()): WindowsServicePaths {
	return {
		supervisor: path.join(crewlyHome, WINDOWS_SERVICE.SUPERVISOR_FILE),
		launcher: path.join(crewlyHome, WINDOWS_SERVICE.LAUNCHER_FILE),
		lock: path.join(crewlyHome, WINDOWS_SERVICE.LOCK_FILE),
		log: path.join(crewlyHome, 'logs', WINDOWS_SERVICE.LOG_FILE),
	};
}

/**
 * The supervisor script: a self-contained CommonJS file (no dependencies,
 * so it survives a package upgrade in place).
 *
 * One supervisor at a time (pid lock, refreshed while it lives). It does
 * nothing when Crewly already listens on the port. A run started by the
 * scheduled task also does nothing after a deliberate stop; a run started
 * at sign-in or by `crewly service start` is a deliberate start and clears
 * that marker. The relaunch wait doubles up to a cap and resets after a
 * run that stayed up.
 *
 * @param projectRoot - Crewly package root
 * @param nodePath - Node executable to run Crewly with
 * @returns Script source
 *
 * @example
 * ```ts
 * fs.writeFileSync(paths.supervisor, generateWindowsSupervisor('C:\\npm\\node_modules\\crewly', process.execPath));
 * ```
 */
export function generateWindowsSupervisor(projectRoot: string, nodePath: string): string {
	const S = SERVER_CONSTANTS;
	const W = WINDOWS_SERVICE;
	return `'use strict';
// Crewly supervisor (generated by \`crewly service install\`; do not edit).
// Runs \`crewly start\`, relaunches it when it exits, stays down after a
// deliberate stop.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = ${JSON.stringify(projectRoot)};
const NODE = ${JSON.stringify(nodePath)};
const HOME = process.env.CREWLY_HOME || path.join(os.homedir(), '.crewly');
const LOG = path.join(HOME, 'logs', ${JSON.stringify(W.LOG_FILE)});
const LOCK = path.join(HOME, ${JSON.stringify(W.LOCK_FILE)});
const PIDFILE = path.join(HOME, ${JSON.stringify(W.PID_FILE)});
const MARKER = path.join(HOME, ${JSON.stringify(SAFE_RESTART_CONSTANTS.SHUTDOWN_MARKER_DIR)}, ${JSON.stringify(SAFE_RESTART_CONSTANTS.SHUTDOWN_MARKER_FILE)});
const PORT = Number(process.env.CREWLY_WEB_PORT) || ${W.DEFAULT_PORT};
const WATCHDOG = process.argv.includes(${JSON.stringify(W.WATCHDOG_ARG)});
const num = (name, fallback) => (Number(process.env[name]) >= 0 && process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);
const DELAY_MIN_S = num(${JSON.stringify(S.SUPERVISOR_RESTART_DELAY_MIN_ENV)}, ${S.SUPERVISOR_RESTART_DELAY_MIN_S});
const DELAY_MAX_S = num(${JSON.stringify(S.SUPERVISOR_RESTART_DELAY_MAX_ENV)}, ${S.SUPERVISOR_RESTART_DELAY_MAX_S});
const STABLE_RUN_S = num(${JSON.stringify(S.SUPERVISOR_STABLE_RUN_ENV)}, ${S.SUPERVISOR_STABLE_RUN_S});

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString() + ': [supervisor] ' + line + '\\n');
  } catch (_) {
    // the log is best-effort; the loop must go on
  }
}

function portBusy() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (busy) => { socket.destroy(); resolve(busy); };
    socket.setTimeout(${W.PORT_CHECK_TIMEOUT_MS}, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Another supervisor is alive when its lock was refreshed recently and its
// process exists (the refresh time guards against a reused pid).
function otherSupervisorAlive() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf-8').trim(), 10);
    if (!pid || pid === process.pid) return false;
    if (Date.now() - fs.statSync(LOCK).mtimeMs > ${W.LOCK_STALE_MS}) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  } catch (_) {
    return false;
  }
}

function writeLock() {
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(LOCK, String(process.pid)); } catch (_) { /* best-effort */ }
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf-8').trim(), 10) === process.pid) fs.rmSync(LOCK, { force: true });
  } catch (_) { /* already gone */ }
}

function runCrewly() {
  return new Promise((resolve) => {
    let out = 'ignore';
    try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); out = fs.openSync(LOG, 'a'); } catch (_) { /* run without a log */ }
    let child;
    try {
      child = spawn(NODE, [path.join(ROOT, ${JSON.stringify(W.CLI_ENTRY)}), 'start', '--no-browser'], {
        cwd: ROOT,
        stdio: ['ignore', out, out],
        windowsHide: true,
        env: Object.assign({}, process.env, { NODE_ENV: process.env.NODE_ENV || 'development' }),
      });
    } catch (error) {
      if (typeof out === 'number') fs.closeSync(out);
      resolve('spawn failed: ' + error.message);
      return;
    }
    try { fs.writeFileSync(PIDFILE, String(child.pid)); } catch (_) { /* best-effort */ }
    const finish = (how) => {
      if (typeof out === 'number') { try { fs.closeSync(out); } catch (_) { /* closed */ } out = 'ignore'; }
      resolve(how);
    };
    child.once('error', (error) => finish('could not start: ' + error.message));
    child.once('exit', (code, signal) => finish('code ' + (code === null ? signal : code)));
  });
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function main() {
  if (otherSupervisorAlive()) return;
  if (WATCHDOG && fs.existsSync(MARKER)) return;
  if (await portBusy()) return;
  if (!WATCHDOG) { try { fs.rmSync(MARKER, { force: true }); } catch (_) { /* absent */ } }
  writeLock();
  const refresh = setInterval(writeLock, ${W.LOCK_REFRESH_MS});
  log('started (pid ' + process.pid + (WATCHDOG ? ', by the watchdog task' : '') + ')');
  let delay = DELAY_MIN_S;
  try {
    for (;;) {
      if (await portBusy()) { log('port ' + PORT + ' is already in use: another Crewly is running. Supervisor exits.'); break; }
      const startedAt = Date.now();
      const how = await runCrewly();
      try { fs.rmSync(PIDFILE, { force: true }); } catch (_) { /* absent */ }
      if (fs.existsSync(MARKER)) { log('Crewly exited (' + how + ') after a stop request: not restarting.'); break; }
      if ((Date.now() - startedAt) / 1000 >= STABLE_RUN_S) delay = DELAY_MIN_S;
      log('Crewly exited (' + how + '), restarting in ' + delay + 's...');
      await sleep(delay);
      delay = Math.min(Math.max(delay * 2, 1), DELAY_MAX_S);
    }
  } finally {
    clearInterval(refresh);
    releaseLock();
  }
}

process.on('uncaughtException', (error) => log('error: ' + (error && error.stack ? error.stack : error)));
process.on('unhandledRejection', (error) => log('error: ' + (error && error.stack ? error.stack : error)));
main().catch((error) => { log('supervisor failed: ' + (error && error.stack ? error.stack : error)); releaseLock(); });
`;
}

/**
 * The launcher: starts the supervisor with no console window and passes its
 * first argument on (the scheduled task passes `watchdog`).
 *
 * @param nodePath - Node executable
 * @param supervisorPath - Supervisor script
 * @returns VBScript source
 */
export function generateWindowsLauncher(nodePath: string, supervisorPath: string): string {
	const quoted = (value: string): string => `""${value.replace(/"/g, '')}""`;
	return [
		"' Crewly launcher (generated by `crewly service install`; do not edit).",
		"' Starts the supervisor without a console window.",
		'Dim extra',
		'extra = ""',
		'If WScript.Arguments.Count > 0 Then extra = " " & WScript.Arguments(0)',
		`CreateObject("WScript.Shell").Run "${quoted(nodePath)} ${quoted(supervisorPath)}" & extra, 0, False`,
		'',
	].join('\r\n');
}

/**
 * The command line Windows runs for the launcher.
 *
 * @param launcherPath - Launcher script
 * @param watchdog - True for the scheduled task's run
 * @returns Command line
 *
 * @example
 * ```ts
 * launcherCommand('C:\\Users\\me\\.crewly\\crewly-start.vbs', true);
 * // 'wscript.exe "C:\\Users\\me\\.crewly\\crewly-start.vbs" watchdog'
 * ```
 */
export function launcherCommand(launcherPath: string, watchdog = false): string {
	return `wscript.exe "${launcherPath}"${watchdog ? ` ${WINDOWS_SERVICE.WATCHDOG_ARG}` : ''}`;
}

/**
 * Fill in the defaults of the injectable pieces.
 *
 * @param deps - Overrides
 * @returns Everything the commands use
 */
function resolveDeps(deps: WindowsServiceDeps): Required<Omit<WindowsServiceDeps, 'projectRoot'>> & { projectRoot: string | null } {
	return {
		run: deps.run ?? defaultRun,
		crewlyHome: deps.crewlyHome ?? resolveCrewlyHome(),
		projectRoot: deps.projectRoot === undefined ? resolvePackageRoot() : deps.projectRoot,
		nodePath: deps.nodePath ?? process.execPath,
		print: deps.print ?? ((line: string): void => console.log(line)),
		launch:
			deps.launch ??
			((launcherPath: string): void => {
				spawn('wscript.exe', [launcherPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
			}),
		isPortBusy: deps.isPortBusy ?? isLocalPortBusy,
		now: deps.now ?? Date.now,
	};
}

/**
 * The Crewly port (CREWLY_WEB_PORT, else the default).
 *
 * @returns Port number
 */
function crewlyPort(): number {
	return Number(process.env.CREWLY_WEB_PORT) || WINDOWS_SERVICE.DEFAULT_PORT;
}

/**
 * The pid of a live supervisor, read from its lock.
 *
 * @param lockPath - Lock file
 * @param now - Current time (ms)
 * @returns Pid, or null when none is running
 */
export function readSupervisorPid(lockPath: string, now: number = Date.now()): number | null {
	try {
		const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
		if (!pid) return null;
		if (now - fs.statSync(lockPath).mtimeMs > WINDOWS_SERVICE.LOCK_STALE_MS) return null;
		try {
			process.kill(pid, 0);
			return pid;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
		}
	} catch {
		return null;
	}
}

/**
 * Install: write the supervisor and launcher, register the sign-in entry and
 * the watchdog task, and start Crewly when it is not running.
 *
 * @param deps - Injectable pieces
 * @returns True when both registrations succeeded
 */
export async function installWindowsService(deps: WindowsServiceDeps = {}): Promise<boolean> {
	const d = resolveDeps(deps);
	if (!d.projectRoot) {
		d.print(chalk.red('Could not find the Crewly package root from the CLI location, the entry script, or the current directory.'));
		return false;
	}
	const paths = windowsServicePaths(d.crewlyHome);
	fs.mkdirSync(path.dirname(paths.log), { recursive: true });
	fs.writeFileSync(paths.supervisor, generateWindowsSupervisor(d.projectRoot, d.nodePath), 'utf-8');
	fs.writeFileSync(paths.launcher, generateWindowsLauncher(d.nodePath, paths.supervisor), 'utf-8');
	d.print(chalk.green(`  Supervisor written: ${paths.supervisor}`));

	const runEntry = await d.run('reg.exe', [
		'add',
		WINDOWS_SERVICE.RUN_KEY,
		'/v',
		WINDOWS_SERVICE.RUN_VALUE,
		'/t',
		'REG_SZ',
		'/d',
		launcherCommand(paths.launcher),
		'/f',
	]);
	d.print(runEntry.ok ? chalk.green('  Starts at sign-in (per-user Run entry)') : chalk.red(`  Could not register the sign-in entry: ${runEntry.stderr.trim()}`));

	const task = await d.run('schtasks.exe', [
		'/Create',
		'/F',
		'/SC',
		'MINUTE',
		'/MO',
		String(WINDOWS_SERVICE.WATCHDOG_MINUTES),
		'/TN',
		WINDOWS_SERVICE.TASK_NAME,
		'/TR',
		launcherCommand(paths.launcher, true),
	]);
	d.print(
		task.ok
			? chalk.green(`  Watchdog task every ${WINDOWS_SERVICE.WATCHDOG_MINUTES} minutes (${WINDOWS_SERVICE.TASK_NAME})`)
			: chalk.red(`  Could not create the watchdog task: ${task.stderr.trim()}`),
	);

	if (await d.isPortBusy(crewlyPort())) {
		d.print(chalk.gray('  Crewly is already running; the supervisor takes over the next time it starts (sign-in, or after `crewly stop` and `crewly service start`).'));
	} else {
		d.launch(paths.launcher);
		d.print(chalk.green('  Crewly is starting in the background.'));
	}
	d.print(chalk.gray(`  Log: ${paths.log}`));
	d.print(chalk.gray('  Nothing runs before you sign in to Windows. `crewly stop` keeps it stopped until `crewly service start` or the next sign-in.'));
	return runEntry.ok && task.ok;
}

/**
 * Uninstall: remove the registrations and the generated files and end the
 * supervisor. A running Crewly is left running (`crewly stop` ends it).
 *
 * @param deps - Injectable pieces
 */
export async function uninstallWindowsService(deps: WindowsServiceDeps = {}): Promise<void> {
	const d = resolveDeps(deps);
	const paths = windowsServicePaths(d.crewlyHome);
	const runEntry = await d.run('reg.exe', ['delete', WINDOWS_SERVICE.RUN_KEY, '/v', WINDOWS_SERVICE.RUN_VALUE, '/f']);
	d.print(runEntry.ok ? chalk.green('  Removed the sign-in entry') : chalk.gray('  No sign-in entry found'));
	const task = await d.run('schtasks.exe', ['/Delete', '/F', '/TN', WINDOWS_SERVICE.TASK_NAME]);
	d.print(task.ok ? chalk.green('  Removed the watchdog task') : chalk.gray('  No watchdog task found'));
	const supervisorPid = readSupervisorPid(paths.lock, d.now());
	if (supervisorPid) {
		try {
			process.kill(supervisorPid);
			d.print(chalk.green(`  Stopped the supervisor (PID ${supervisorPid})`));
		} catch {
			d.print(chalk.gray('  The supervisor was already gone'));
		}
	}
	for (const file of [paths.supervisor, paths.launcher, paths.lock]) fs.rmSync(file, { force: true });
	d.print(chalk.green('Crewly service uninstalled.'));
	if (await d.isPortBusy(crewlyPort())) d.print(chalk.gray('  Crewly is still running; `crewly stop` ends it.'));
}

/**
 * Print what is installed and what is running.
 *
 * @param deps - Injectable pieces
 */
export async function windowsServiceStatus(deps: WindowsServiceDeps = {}): Promise<void> {
	const d = resolveDeps(deps);
	const paths = windowsServicePaths(d.crewlyHome);
	const yes = (text: string): string => chalk.green(text);
	const no = (text: string): string => chalk.yellow(text);
	const runEntry = await d.run('reg.exe', ['query', WINDOWS_SERVICE.RUN_KEY, '/v', WINDOWS_SERVICE.RUN_VALUE]);
	const task = await d.run('schtasks.exe', ['/Query', '/TN', WINDOWS_SERVICE.TASK_NAME]);
	const supervisorPid = readSupervisorPid(paths.lock, d.now());
	const running = await d.isPortBusy(crewlyPort());
	d.print(`  Supervisor script: ${fs.existsSync(paths.supervisor) ? yes('installed') : no('not installed')}`);
	d.print(`  Starts at sign-in: ${runEntry.ok ? yes('yes') : no('no')}`);
	d.print(`  Watchdog task:     ${task.ok ? yes(`yes (every ${WINDOWS_SERVICE.WATCHDOG_MINUTES} min)`) : no('no')}`);
	d.print(`  Supervisor:        ${supervisorPid ? yes(`running (PID ${supervisorPid})`) : no('not running')}`);
	d.print(`  Crewly:            ${running ? yes(`running on port ${crewlyPort()}`) : no('not running')}`);
	if (running && !supervisorPid) d.print(chalk.gray('  Crewly was started by hand: nothing restarts it if it exits.'));
	d.print(chalk.gray(`  Log: ${paths.log}`));
}

/**
 * Start Crewly through the supervisor (a deliberate start: it clears an
 * earlier stop).
 *
 * @param deps - Injectable pieces
 * @returns True when a start was requested or Crewly already runs
 */
export async function startWindowsService(deps: WindowsServiceDeps = {}): Promise<boolean> {
	const d = resolveDeps(deps);
	const paths = windowsServicePaths(d.crewlyHome);
	if (!fs.existsSync(paths.launcher) || !fs.existsSync(paths.supervisor)) {
		d.print(chalk.red('Service is not installed. Run "crewly service install" first.'));
		return false;
	}
	if (await d.isPortBusy(crewlyPort())) {
		d.print(chalk.yellow('Crewly is already running.'));
		return true;
	}
	d.launch(paths.launcher);
	d.print(chalk.green('Crewly is starting in the background.'));
	d.print(chalk.gray(`  Log: ${paths.log}`));
	return true;
}

/**
 * `crewly service <action>` on Windows.
 *
 * @param action - install | uninstall | status | start | stop | …
 * @param deps - Injectable pieces
 * @returns Process exit code
 *
 * @example
 * ```ts
 * process.exitCode = await windowsServiceCommand('install');
 * ```
 */
export async function windowsServiceCommand(action: string, deps: WindowsServiceDeps = {}): Promise<number> {
	const print = deps.print ?? ((line: string): void => console.log(line));
	switch (action) {
		case 'install':
			print(chalk.blue('Installing Crewly as a background service...'));
			return (await installWindowsService(deps)) ? 0 : 1;
		case 'uninstall':
			print(chalk.blue('Uninstalling Crewly service...'));
			await uninstallWindowsService(deps);
			return 0;
		case 'status':
			print(chalk.blue('Crewly Service Status'));
			print(chalk.gray('='.repeat(40)));
			await windowsServiceStatus(deps);
			return 0;
		case 'start':
			return (await startWindowsService(deps)) ? 0 : 1;
		case 'stop':
			// The marker keeps the supervisor and the watchdog task from bringing it back.
			writeShutdownMarker(deps.crewlyHome, 'crewly service stop');
			print(chalk.gray('Marked as stopped on purpose. Run `crewly stop` to end the running Crewly; `crewly service start` brings it back.'));
			return 0;
		default:
			print(chalk.red(`"crewly service ${action}" is not available on Windows yet.`));
			print(chalk.gray('Available: install, uninstall, status, start, stop. To restart: `crewly stop`, then `crewly service start`.'));
			return 1;
	}
}
