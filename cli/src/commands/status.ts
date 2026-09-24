/**
 * `crewly status` — the backend and the agents it is running.
 *
 * Agents run in node-pty sessions (or in-process) owned by the backend, so
 * the list comes from the backend API, not tmux (#776): pid/port from the
 * listening socket, version/uptime/health from `/health`, agents from
 * `/api/sessions` (+ in-process ones), names from `/api/teams`, and busy
 * (mid-turn) agents from `/api/system/restart-readiness`.
 *
 * @module cli/commands/status
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { WEB_CONSTANTS } from '../../../config/index.js';
import {
	describeAgent,
	fetchBackendSnapshot,
	findListenerPids,
	formatUptime,
	readProcessTable,
	type BackendSnapshot,
	type RunCommand,
} from '../utils/backend-status.js';

const execAsync = promisify(exec);

/** Shell runner for status (stdout only). */
const run: RunCommand = async (command) => (await execAsync(command)).stdout;

// Computed URLs using constants - allow environment variable override
const BACKEND_PORT = process.env.WEB_PORT || WEB_CONSTANTS.PORTS.BACKEND;

/** Longest message preview shown for a busy agent. */
const BUSY_PREVIEW_MAX = 60;

interface StatusOptions {
	verbose?: boolean;
}

/**
 * Print the backend's state and its running agents.
 *
 * @param options - `--verbose` adds agent working directories, legacy tmux details and related processes
 */
export async function statusCommand(options: StatusOptions = {}): Promise<void> {
	console.log(chalk.blue('🔍 Crewly Status'));
	console.log(chalk.gray('='.repeat(50)));

	try {
		const snapshot = await fetchBackendSnapshot(BACKEND_PORT);
		const listenerPids = await findListenerPids(BACKEND_PORT, run);

		printBackend(snapshot, listenerPids);
		if (snapshot.health) {
			printAgents(snapshot, options.verbose === true);
		}

		// Legacy tmux sessions from older Crewly versions (silent when none)
		await checkTmuxSessions(options.verbose);

		if (options.verbose) {
			await checkRunningProcesses();
		}
	} catch (error) {
		console.error(chalk.red('❌ Error checking status:'), error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

/**
 * Print the backend block.
 *
 * @param snapshot - Backend snapshot
 * @param listenerPids - Pids listening on the backend port
 */
function printBackend(snapshot: BackendSnapshot, listenerPids: number[]): void {
	const health = snapshot.health;
	if (!health) {
		if (listenerPids.length > 0) {
			console.log(chalk.red(`❌ Backend: not answering — port ${BACKEND_PORT} is held by PID ${listenerPids.join(', ')}, but ${snapshot.url}${WEB_CONSTANTS.ENDPOINTS.HEALTH} does not respond`));
			console.log(chalk.gray('   Stop it with "crewly stop" (or "crewly stop --force"), then "crewly start"'));
		} else {
			console.log(chalk.red(`❌ Backend: not running (nothing listening on port ${BACKEND_PORT})`));
			console.log(chalk.gray('   Run "crewly start" to start it'));
		}
		return;
	}

	console.log(chalk.green('✅ Backend: running'));
	console.log(chalk.gray(`   PID: ${listenerPids.length > 0 ? listenerPids.join(', ') : 'unknown'}`));
	console.log(chalk.gray(`   Port: ${BACKEND_PORT}  (${snapshot.url})`));
	console.log(chalk.gray(`   Version: ${health.version ?? 'unknown'}`));
	if (health.uptimeSeconds !== null) {
		console.log(chalk.gray(`   Uptime: ${formatUptime(health.uptimeSeconds)}`));
	}
	const parts = [health.status];
	if (health.orchestratorStatus) parts.push(`orchestrator ${health.orchestratorStatus}`);
	if (health.teamHealthStatus) parts.push(`team health ${health.teamHealthStatus}`);
	const degraded = health.status !== 'healthy' || health.orchestratorStatus === 'degraded';
	const healthLine = `   Health: ${parts.join(', ')}`;
	console.log(degraded ? chalk.yellow(healthLine) : chalk.gray(healthLine));
	if (health.orchestratorReason) {
		console.log(chalk.yellow(`   ⚠️  ${health.orchestratorReason}`));
	}
}

/**
 * Print the running agents.
 *
 * @param snapshot - Backend snapshot (health answered)
 * @param verbose - Also print each agent's working directory
 */
function printAgents(snapshot: BackendSnapshot, verbose: boolean): void {
	console.log('');
	if (!snapshot.agents) {
		console.log(chalk.yellow(`⚠️  Agents: could not list them (${snapshot.agentsError ?? 'unknown error'})`));
		return;
	}
	const agents = snapshot.agents;
	if (agents.length === 0) {
		console.log(chalk.gray('Agents: none running'));
		return;
	}
	const busyCount = agents.filter((a) => a.busy).length;
	const busyText = snapshot.readiness ? `${busyCount} busy` : 'busy state unknown (backend has no restart-readiness endpoint)';
	console.log(chalk.blue(`🤖 Agents: ${agents.length} running, ${busyText}`));
	for (const agent of agents) {
		const where = agent.inProcess ? 'in-process' : `PID ${agent.pid ?? '?'}`;
		let state = snapshot.readiness ? 'idle' : '';
		if (agent.busy) {
			const preview = (agent.busyMessage ?? '').replace(/\s+/g, ' ').trim();
			const clipped = preview.length > BUSY_PREVIEW_MAX ? `${preview.slice(0, BUSY_PREVIEW_MAX)}...` : preview;
			state = `busy since ${agent.busySince ?? '?'}${clipped ? ` — ${clipped}` : ''}`;
		}
		const line = `   • ${describeAgent(agent)}  ${where}${state ? `  ${state}` : ''}`;
		console.log(agent.busy ? chalk.yellow(line) : chalk.gray(line));
		if (verbose && agent.cwd) {
			console.log(chalk.gray(`     cwd: ${agent.cwd}`));
		}
	}
}

/**
 * Report legacy tmux sessions left by older Crewly versions.
 *
 * Agent sessions run on the built-in node-pty backend, so tmux is not part of
 * a normal install. This prints nothing unless `crewly_*` tmux sessions
 * actually exist. Note the command's `|| echo ""`: when tmux is absent or has
 * no sessions it yields empty output rather than throwing, so the empty case
 * must stay silent too.
 *
 * @param verbose - Also print per-session details
 */
async function checkTmuxSessions(verbose: boolean = false): Promise<void> {
	try {
		const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}:#{session_attached}:#{session_created}" 2>/dev/null || echo ""');

		const sessions = stdout.trim() ? stdout.trim().split('\n') : [];
		const agentMuxSessions = sessions.filter(s => s.includes('crewly_'));

		// No Crewly tmux sessions (the normal case): say nothing about tmux.
		if (agentMuxSessions.length === 0) {
			return;
		}

		console.log(chalk.gray(`\n   Legacy tmux sessions (crewly_*): ${agentMuxSessions.length}`));

		if (verbose && agentMuxSessions.length > 0) {
			console.log(chalk.gray('\n   Crewly Sessions:'));

			for (const session of agentMuxSessions) {
				const [name, attached, created] = session.split(':');
				const createdDate = new Date(parseInt(created) * 1000);

				console.log(chalk.gray(`   • ${name}`));
				console.log(chalk.gray(`     Attached: ${attached === '1' ? 'Yes' : 'No'}`));
				console.log(chalk.gray(`     Created: ${createdDate.toLocaleString()}`));

				// Try to capture recent output
				try {
					const { stdout: output } = await execAsync(`tmux capture-pane -t "${name}:0" -p -S -5 2>/dev/null || echo "No output"`);
					const lastLine = output.trim().split('\n').pop() || 'No recent activity';
					console.log(chalk.gray(`     Last: ${lastLine.slice(0, 60)}${lastLine.length > 60 ? '...' : ''}`));
				} catch (error) {
					console.log(chalk.gray('     Last: Unable to capture'));
				}

				console.log('');
			}
		}

	} catch {
		// tmux absent or failing: it is not used (node-pty backend), so say nothing.
	}
}

/**
 * Print the backend process and its children (agent runtimes) from the
 * process table (verbose only).
 */
async function checkRunningProcesses(): Promise<void> {
	try {
		console.log(chalk.blue('\n🔍 Processes:'));
		const listenerPids = await findListenerPids(BACKEND_PORT, run);
		if (listenerPids.length === 0) {
			console.log(chalk.gray(`   Nothing is listening on port ${BACKEND_PORT}`));
			return;
		}
		const table = await readProcessTable(run);
		const byPid = new Map(table.map((row) => [row.pid, row]));
		for (const pid of listenerPids) {
			const command = byPid.get(pid)?.command ?? '';
			console.log(chalk.gray(`   • PID ${pid} (listening on ${BACKEND_PORT}) ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}`));
			for (const child of table.filter((row) => row.ppid === pid)) {
				console.log(chalk.gray(`     └ PID ${child.pid} ${child.command.slice(0, 76)}${child.command.length > 76 ? '...' : ''}`));
			}
		}
	} catch (error) {
		console.log(chalk.yellow('⚠️  Unable to check running processes'));
	}
}
