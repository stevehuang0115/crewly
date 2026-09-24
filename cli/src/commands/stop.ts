/**
 * `crewly stop` — stop the backend on this port and its agents, and say
 * exactly what was stopped.
 *
 * Agents run in node-pty sessions (or in-process) owned by the backend. The
 * backend drains in-flight agent turns on SIGTERM and then ends its PTYs, so
 * stopping the backend stops the agents. This command:
 * 1. asks the backend which agents are running and who is mid-turn;
 * 2. SIGTERMs the Crewly backend listening on the port and waits for its drain
 *    (`--force`: SIGKILLs it and its child processes at once);
 * 3. terminates agent processes that outlived the backend;
 * 4. kills legacy `crewly_*` tmux sessions from older versions, if any;
 * 5. prints what it stopped — or that there was nothing to stop. It never
 *    reports success after finding nothing (#776).
 *
 * Only the listener on this port is touched, and only when it is a Crewly
 * backend. The old sweep signalled every process whose command line mentioned
 * "crewly" or "backend", including other projects' servers and this command's
 * own shell.
 *
 * @module cli/commands/stop
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { WEB_CONSTANTS } from '../../../config/index.js';
import { killOrphanedTestProcesses } from '../utils/process-cleanup.js';
import {
	describeReadiness,
	resolveRestartDrainMs,
	resolveShutdownBudgetMs,
	waitForPidExit,
} from '../utils/safe-shutdown.js';
import {
	collectDescendants,
	describeAgent,
	fetchBackendSnapshot,
	findListenerPids,
	isCrewlyBackendCommand,
	readProcessTable,
	type BackendSnapshot,
	type ProcessRow,
	type RunCommand,
} from '../utils/backend-status.js';

const execAsync = promisify(exec);

/** Shell runner (stdout only). */
const run: RunCommand = async (command) => (await execAsync(command)).stdout;

// Computed URLs using constants - allow environment variable override
const BACKEND_PORT = process.env.WEB_PORT || WEB_CONSTANTS.PORTS.BACKEND;

/** How long to wait for a SIGKILLed or SIGTERMed straggler to disappear (ms). */
const STRAGGLER_EXIT_WAIT_MS = 3_000;

/** Longest command excerpt shown for a process. */
const COMMAND_EXCERPT_MAX = 60;

interface StopOptions {
	force?: boolean;
}

/** What this run did, printed at the end. */
interface StopReport {
	/** Things that were running and are now stopped */
	stopped: string[];
	/** Things that are still running (makes the command fail) */
	stillRunning: string[];
	/** Things found but deliberately not touched */
	leftAlone: string[];
}

/**
 * Stop Crewly on the configured port.
 *
 * @param options - `--force` skips the drain and SIGKILLs
 */
export async function stopCommand(options: StopOptions = {}): Promise<void> {
	console.log(chalk.yellow('🛑 Stopping Crewly...'));
	const report: StopReport = { stopped: [], stillRunning: [], leftAlone: [] };

	try {
		// 1. Who is running (skipped with --force: the backend may be wedged)
		const snapshot = options.force ? null : await attemptGracefulShutdown();

		// 2. The backend listening on this port, and its children
		const table = await readProcessTable(run);
		const byPid = new Map(table.map((row) => [row.pid, row]));
		const protectedPids = ancestorsOf(process.pid, byPid);
		const listeners = await findListenerPids(BACKEND_PORT, run);

		for (const pid of listeners) {
			const command = byPid.get(pid)?.command ?? '';
			// A listener that answered /health is a Crewly backend even when its
			// command line is not the usual entrypoint.
			if (!isCrewlyBackendCommand(command) && !snapshot?.health) {
				report.leftAlone.push(`PID ${pid} holds port ${BACKEND_PORT} but is not a Crewly backend (${excerpt(command) || 'unknown command'})`);
				continue;
			}
			const children = collectDescendants(table, pid).filter((row) => !protectedPids.has(row.pid));
			if (options.force) {
				await forceStopBackend(pid, children, report);
			} else {
				await drainBackend(pid, children, snapshot, protectedPids, report);
			}
		}

		// 3. Legacy tmux sessions from older versions (silent when none)
		await killLegacyTmuxSessions(report);

		// 4. Clean up orphaned test processes (vitest workers, etc.)
		killOrphanedTestProcesses(process.pid, (msg) => console.log(chalk.gray(msg)));

		printReport(report);
	} catch (error) {
		console.error(chalk.red('❌ Error stopping Crewly:'), error instanceof Error ? error.message : error);

		if (!options.force) {
			console.log(chalk.yellow('💡 Try running with --force flag for forceful shutdown'));
		}

		process.exit(1);
	}
}

/**
 * Ask the backend what is running and who is mid-turn, and print it.
 *
 * @returns The snapshot (health null when the backend does not answer)
 */
async function attemptGracefulShutdown(): Promise<BackendSnapshot> {
	console.log(chalk.blue('📡 Attempting graceful shutdown...'));
	const snapshot = await fetchBackendSnapshot(BACKEND_PORT);
	if (!snapshot.health) {
		console.log(chalk.gray(`Server not responding on port ${BACKEND_PORT}; stopping any Crewly backend that holds the port`));
		return snapshot;
	}
	console.log(chalk.green(`Server is running (version ${snapshot.health.version ?? 'unknown'}), proceeding with shutdown`));
	if (snapshot.agents) {
		console.log(chalk.gray(`${snapshot.agents.length} agent(s) running${snapshot.agents.length > 0 ? `: ${snapshot.agents.map((a) => a.sessionName).join(', ')}` : ''}`));
	}
	// Tell the operator who is mid-turn; the backend drains them on SIGTERM.
	if (snapshot.readiness) {
		for (const line of describeReadiness(snapshot.readiness, resolveRestartDrainMs(process.env))) {
			console.log(chalk.gray(line));
		}
	}
	return snapshot;
}

/**
 * SIGTERM the backend and wait for it to exit, for up to the drain budget
 * (CREWLY_RESTART_DRAIN_MS + margin): it finishes in-flight agent turns before
 * it ends their PTYs. Then terminate any agent process that outlived it.
 *
 * @param pid - Backend pid
 * @param children - The backend's descendants before the stop
 * @param snapshot - What the backend reported (agents)
 * @param protectedPids - This process and its ancestors, never signalled
 * @param report - Collects the outcome
 */
async function drainBackend(
	pid: number,
	children: ProcessRow[],
	snapshot: BackendSnapshot | null,
	protectedPids: Set<number>,
	report: StopReport,
): Promise<void> {
	const budgetMs = resolveShutdownBudgetMs(process.env);
	console.log(chalk.blue(`⏳ Letting the backend finish in-flight agent turns (up to ${Math.round(budgetMs / 1000)}s)...`));
	await signal(pid, 'TERM');
	const exited = await waitForPidExit(pid, budgetMs, {
		isAlive,
		onProgress: (waitedMs) =>
			console.log(chalk.gray(`  still waiting for PID ${pid} (${Math.round(waitedMs / 1000)}s) — Ctrl+C then \`crewly stop --force\` to stop now`)),
	});
	if (!exited) {
		report.stillRunning.push(`backend PID ${pid} did not exit within ${Math.round(budgetMs / 1000)}s — run \`crewly stop --force\``);
		return;
	}
	report.stopped.push(`backend PID ${pid} (port ${BACKEND_PORT})`);

	const agents = snapshot?.agents ?? [];
	if (agents.length > 0) {
		report.stopped.push(`${agents.length} agent session(s): ${agents.map(describeAgent).join(', ')}`);
	}

	// Agent processes that outlived the backend (children, plus the PTY pids
	// the backend reported in case they were re-parented).
	const candidates = new Map<number, string>();
	for (const row of children) candidates.set(row.pid, row.command);
	for (const agent of agents) {
		if (agent.pid && !candidates.has(agent.pid) && !protectedPids.has(agent.pid)) candidates.set(agent.pid, agent.sessionName);
	}
	for (const [childPid, command] of candidates) {
		if (!(await isAlive(childPid))) continue;
		await signal(childPid, 'TERM');
		const gone = await waitForPidExit(childPid, STRAGGLER_EXIT_WAIT_MS, { isAlive });
		if (gone) {
			report.stopped.push(`PID ${childPid}, left running by the backend (${excerpt(command)})`);
		} else {
			report.stillRunning.push(`PID ${childPid} (${excerpt(command)}) ignored SIGTERM — run \`crewly stop --force\``);
		}
	}
}

/**
 * SIGKILL the backend and every process under it (agent runtimes), without
 * waiting for in-flight turns.
 *
 * @param pid - Backend pid
 * @param children - The backend's descendants
 * @param report - Collects the outcome
 */
async function forceStopBackend(pid: number, children: ProcessRow[], report: StopReport): Promise<void> {
	console.log(chalk.blue(`🔧 Force-stopping backend PID ${pid} and ${children.length} process(es) under it...`));
	for (const target of [pid, ...children.map((row) => row.pid)]) {
		await signal(target, 'KILL');
	}
	const backendGone = await waitForPidExit(pid, STRAGGLER_EXIT_WAIT_MS, { isAlive });
	if (backendGone) {
		report.stopped.push(`backend PID ${pid} (port ${BACKEND_PORT}, SIGKILL)`);
	} else {
		report.stillRunning.push(`backend PID ${pid} survived SIGKILL`);
	}
	const killed: string[] = [];
	for (const row of children) {
		if (await isAlive(row.pid)) {
			report.stillRunning.push(`PID ${row.pid} (${excerpt(row.command)}) survived SIGKILL`);
		} else {
			killed.push(`${row.pid} ${excerpt(row.command)}`);
		}
	}
	if (killed.length > 0) {
		report.stopped.push(`${killed.length} process(es) under the backend: ${killed.join('; ')}`);
	}
}

/**
 * Kill `crewly_*` tmux sessions left by older Crewly versions. Silent when
 * tmux is absent or there are none (tmux is not used any more).
 *
 * @param report - Collects the outcome
 */
async function killLegacyTmuxSessions(report: StopReport): Promise<void> {
	let sessions: string[] = [];
	try {
		const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null || echo ""');
		sessions = stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('crewly_'));
	} catch {
		return;
	}
	for (const session of sessions) {
		try {
			await execAsync(`tmux kill-session -t "${session}"`);
			report.stopped.push(`legacy tmux session ${session}`);
		} catch {
			// Ended between list and kill: nothing to report.
		}
	}
}

/**
 * Print the outcome. Fails (exit code 1) when something is still running.
 *
 * @param report - What happened
 */
function printReport(report: StopReport): void {
	console.log('');
	for (const item of report.leftAlone) {
		console.log(chalk.yellow(`⚠️  Left alone: ${item}`));
	}
	if (report.stopped.length > 0) {
		console.log(chalk.green('Stopped:'));
		for (const item of report.stopped) console.log(chalk.green(`   ✓ ${item}`));
	}
	if (report.stillRunning.length > 0) {
		console.log(chalk.red('Still running:'));
		for (const item of report.stillRunning) console.log(chalk.red(`   ✗ ${item}`));
		process.exitCode = 1;
		return;
	}
	if (report.stopped.length === 0) {
		console.log(chalk.yellow(`Nothing to stop: no Crewly backend is listening on port ${BACKEND_PORT}, and no legacy crewly_* tmux sessions exist.`));
		console.log(chalk.gray('   If Crewly runs as a background service, check it with `crewly service status` and stop it with `crewly service stop`.'));
		console.log(chalk.gray('   A backend on another port: WEB_PORT=<port> crewly stop'));
		return;
	}
	console.log(chalk.green('✅ Crewly stopped'));
}

/**
 * Send a signal via the shell. A failure means the process is already gone.
 *
 * @param pid - Target
 * @param sig - Signal name without the SIG prefix
 */
async function signal(pid: number, sig: 'TERM' | 'KILL'): Promise<void> {
	try {
		await execAsync(`kill -${sig} ${pid}`);
	} catch {
		// Already gone.
	}
}

/**
 * Liveness via `kill -0`.
 *
 * @param pid - Process id
 * @returns True if it exists
 */
async function isAlive(pid: number): Promise<boolean> {
	try {
		await execAsync(`kill -0 ${pid}`);
		return true;
	} catch {
		return false;
	}
}

/**
 * This process and its ancestors: never signalled, even when `crewly stop`
 * runs inside an agent's shell under the backend.
 *
 * @param pid - Starting pid (this process)
 * @param byPid - Process table by pid
 * @returns The pid chain up to init
 */
function ancestorsOf(pid: number, byPid: Map<number, ProcessRow>): Set<number> {
	const chain = new Set<number>([pid]);
	let current = byPid.get(pid);
	while (current && current.ppid > 1 && !chain.has(current.ppid)) {
		chain.add(current.ppid);
		current = byPid.get(current.ppid);
	}
	return chain;
}

/**
 * Shorten a command line for display.
 *
 * @param command - Command line
 * @returns At most COMMAND_EXCERPT_MAX characters
 */
function excerpt(command: string): string {
	const trimmed = command.trim();
	return trimmed.length > COMMAND_EXCERPT_MAX ? `${trimmed.slice(0, COMMAND_EXCERPT_MAX)}...` : trimmed;
}
