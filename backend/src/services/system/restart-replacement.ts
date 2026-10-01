/**
 * Detached replacement launcher for a restart nobody else will relaunch.
 *
 * When the backend runs without `crewly start` above it (or we cannot tell),
 * the owner's Restart / Upgrade must still bring it back. Right before the
 * graceful shutdown, the backend starts a small detached `node -e` launcher.
 * The launcher:
 *
 * 1. waits until the old backend process is gone (capped);
 * 2. waits a short grace period and checks the port — if something already
 *    answers there, a supervisor brought Crewly back and it does nothing;
 * 3. otherwise starts the backend again with the same node, flags, script and
 *    arguments, detached, logging to `<crewlyHome>/logs/restart-replacement.log`.
 *
 * The environment is inherited through `spawn` (never put on the command
 * line, where `ps` would show secrets).
 *
 * @module services/system/restart-replacement
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';

/** Everything the launcher needs (passed as one JSON argument). */
export interface ReplacementPlan {
	/** Node binary to run the backend with */
	execPath: string;
	/** Arguments: node flags, then the entry script and its arguments */
	args: string[];
	/** Working directory for the new backend */
	cwd: string;
	/** The backend that is about to exit */
	oldPid: number;
	/** Port the backend serves on (the "already back" check) */
	port: number;
	/** Wait this long after the old process exits before checking the port (ms) */
	portGraceMs: number;
	/** Give up waiting for the old process after this long (ms) */
	maxWaitMs: number;
	/** Poll interval for the old process (ms) */
	pollMs: number;
	/** Launcher log */
	logFile: string;
}

/** Inputs for {@link buildReplacementPlan}. */
export interface ReplacementPlanInput {
	execPath: string;
	execArgv: string[];
	argv: string[];
	cwd: string;
	pid: number;
	port: number;
	crewlyHome: string;
	/** True when a supervisor might relaunch us first (longer grace before the port check) */
	supervisorUnknown: boolean;
}

/**
 * Build the launcher plan for the running process.
 *
 * @param input - Process facts
 * @returns The plan
 */
export function buildReplacementPlan(input: ReplacementPlanInput): ReplacementPlan {
	return {
		execPath: input.execPath,
		args: [...input.execArgv, ...input.argv.slice(1)],
		cwd: input.cwd,
		oldPid: input.pid,
		port: input.port,
		portGraceMs: input.supervisorUnknown
			? SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_PORT_GRACE_UNKNOWN_MS
			: SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_PORT_GRACE_MS,
		maxWaitMs: SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_MAX_WAIT_MS,
		pollMs: SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_PID_POLL_MS,
		logFile: path.join(input.crewlyHome, 'logs', SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_LOG_FILE),
	};
}

/**
 * The launcher program (CommonJS, run with `node -e`). Reads the plan from
 * `process.argv[1]`.
 */
export const REPLACEMENT_LAUNCHER_SCRIPT = `
const fs = require('fs');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const p = JSON.parse(process.argv[1]);
const log = (m) => { try { fs.appendFileSync(p.logFile, new Date().toISOString() + ' ' + m + '\\n'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (process.platform === 'win32') return true;
  try { return !/Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' })); } catch (e) { return false; }
};
const answers = () => new Promise((resolve) => {
  const s = net.connect({ port: p.port, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); resolve(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(2000, () => done(false));
});
(async () => {
  const started = Date.now();
  while (alive(p.oldPid)) {
    if (Date.now() - started > p.maxWaitMs) { log('Old Crewly process ' + p.oldPid + ' is still running after ' + p.maxWaitMs + ' ms; not starting a second copy'); return; }
    await sleep(p.pollMs);
  }
  log('Old Crewly process ' + p.oldPid + ' exited');
  await sleep(p.portGraceMs);
  if (await answers()) { log('Port ' + p.port + ' already answers; Crewly was brought back by something else'); return; }
  const fd = fs.openSync(p.logFile, 'a');
  const child = spawn(p.execPath, p.args, { cwd: fs.existsSync(p.cwd) ? p.cwd : undefined, env: process.env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', (e) => log('Could not start Crewly: ' + e.message));
  log('Started Crewly again (pid ' + child.pid + '): ' + p.execPath + ' ' + p.args.join(' '));
  child.unref();
})();
`;

/** Spawn function (tests inject a fake). */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'pid' | 'unref'>;

/**
 * Start the detached launcher. It outlives this process.
 *
 * @param plan - Launcher plan
 * @param launcherCwd - Directory the launcher itself runs in (must outlive an upgrade)
 * @param env - Environment handed to the launcher and, through it, to the new backend
 * @param spawnFn - Spawn (tests)
 * @returns The launcher pid, when known
 */
export function spawnReplacementLauncher(
	plan: ReplacementPlan,
	launcherCwd: string,
	env: NodeJS.ProcessEnv = process.env,
	spawnFn: SpawnFn = spawn,
): number | undefined {
	try {
		fs.mkdirSync(path.dirname(plan.logFile), { recursive: true });
	} catch {
		// The launcher logs best-effort
	}
	const child = spawnFn(plan.execPath, ['-e', REPLACEMENT_LAUNCHER_SCRIPT, JSON.stringify(plan)], {
		cwd: launcherCwd,
		env,
		detached: true,
		stdio: 'ignore',
	});
	child.unref();
	return child.pid;
}
