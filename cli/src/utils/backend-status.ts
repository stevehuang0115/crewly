/**
 * What is actually running: the Crewly backend on a port and its agents.
 *
 * Agents run in node-pty sessions owned by the backend (or in-process, with
 * no PTY), not in tmux. `crewly status` and `crewly stop` used to look only
 * for `crewly_*` tmux sessions, so status listed nothing and stop reported
 * success after examining nothing (#776). The source of truth is the backend
 * API (sessions, teams, restart readiness) plus the process table for the
 * listener pid and its children.
 *
 * @module cli/utils/backend-status
 */

import axios from 'axios';
import { SAFE_RESTART_CONSTANTS, TIMING_CONSTANTS, WEB_CONSTANTS } from '../../../config/index.js';
import { parseReadiness, type RestartReadiness } from './safe-shutdown.js';
import { CREWLY_BACKEND_COMMAND_PATTERN } from './process-cleanup.js';

/** HTTP GET returning the parsed JSON body; throws when the request fails. */
export type HttpGet = (url: string, timeoutMs: number) => Promise<unknown>;

/** Runs a shell command and returns stdout; throws on a non-zero exit. */
export type RunCommand = (command: string) => Promise<string>;

/** Subset of the backend's `/health` body the CLI shows. */
export interface BackendHealth {
	status: string;
	version: string | null;
	uptimeSeconds: number | null;
	mode: string | null;
	/** Orchestrator liveness (`ok` / `degraded`) and why */
	orchestratorStatus: string | null;
	orchestratorReason: string | null;
	/** Team health watchdog status */
	teamHealthStatus: string | null;
}

/** One running agent session. */
export interface RunningAgent {
	sessionName: string;
	/** PTY child pid (absent for in-process agents) */
	pid?: number;
	cwd?: string;
	/** True for in-process (AI SDK) agents, which have no PTY */
	inProcess: boolean;
	/** Mid-turn right now, per restart readiness */
	busy: boolean;
	/** When the current turn started (busy agents only) */
	busySince?: string;
	/** Preview of the message being worked on (busy agents only) */
	busyMessage?: string;
	/** Team member name, when the session belongs to a team member */
	memberName?: string;
	teamName?: string;
	runtimeType?: string;
}

/** Everything the backend reports about itself, each part fail-soft. */
export interface BackendSnapshot {
	url: string;
	/** Null when `/health` does not answer (backend not running or wedged) */
	health: BackendHealth | null;
	/** Null when the session list could not be read */
	agents: RunningAgent[] | null;
	/** Why `agents` is null */
	agentsError?: string;
	/** Null when readiness is unavailable (older backend) — busy flags are then unknown */
	readiness: RestartReadiness | null;
}

/** One row of the process table. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	command: string;
}

/** Timeout for the per-endpoint snapshot requests (ms). */
const SNAPSHOT_REQUEST_TIMEOUT_MS = TIMING_CONSTANTS.TIMEOUTS.HTTP_HEALTH_CHECK;

/**
 * Default HTTP GET (axios).
 *
 * @param url - Absolute URL
 * @param timeoutMs - Request timeout
 * @returns Parsed response body
 */
const defaultHttpGet: HttpGet = async (url, timeoutMs) => (await axios.get(url, { timeout: timeoutMs })).data;

/**
 * Backend base URL for a port. Uses `localhost`, which the API treats as
 * loopback, so no API token is needed.
 *
 * @param port - Backend web port
 * @returns Base URL without a trailing slash
 */
export function backendUrl(port: number | string): string {
	return `http://localhost:${port}`;
}

/**
 * Read a string field, or null.
 *
 * @param value - Candidate
 * @returns The string, or null
 */
function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Narrow an unknown value to a plain object.
 *
 * @param value - Candidate
 * @returns The object, or an empty one
 */
function obj(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Parse the backend's `/health` body.
 *
 * @param body - Parsed JSON
 * @returns Health summary
 */
export function parseHealth(body: unknown): BackendHealth {
	const b = obj(body);
	const orchestrator = obj(b.orchestrator);
	const teamHealth = obj(b.team_health);
	return {
		status: str(b.status) ?? 'unknown',
		version: str(b.version),
		uptimeSeconds: typeof b.uptime === 'number' ? b.uptime : null,
		mode: str(b.mode),
		orchestratorStatus: str(orchestrator.status),
		orchestratorReason: str(orchestrator.reason),
		teamHealthStatus: str(teamHealth.status),
	};
}

/** Team-member identity keyed by session name. */
interface MemberInfo {
	memberName: string;
	teamName: string;
	runtimeType?: string;
}

/**
 * Map session names to team members from a `GET /api/teams` body.
 *
 * @param body - Parsed JSON (`{ success, data: Team[] }`)
 * @returns Session name → member info
 */
export function parseTeamMembers(body: unknown): Map<string, MemberInfo> {
	const result = new Map<string, MemberInfo>();
	const teams = obj(body).data;
	if (!Array.isArray(teams)) return result;
	for (const team of teams) {
		const t = obj(team);
		const teamName = str(t.name) ?? str(t.id) ?? 'team';
		if (!Array.isArray(t.members)) continue;
		for (const member of t.members) {
			const m = obj(member);
			const sessionName = str(m.sessionName);
			if (!sessionName) continue;
			result.set(sessionName, {
				memberName: str(m.name) ?? sessionName,
				teamName,
				runtimeType: str(m.runtimeType) ?? undefined,
			});
		}
	}
	return result;
}

/**
 * Build the running-agent list from the session endpoints.
 *
 * @param sessionsBody - `GET /api/sessions` body (`{ sessions: [{ sessionName, pid, cwd }] }`)
 * @param terminalBody - `GET /api/terminal/sessions` body, or null (adds in-process agents)
 * @param readiness - Restart readiness, or null (busy flags then stay false)
 * @param members - Session name → member info
 * @returns Agents sorted by name
 */
export function buildAgentList(
	sessionsBody: unknown,
	terminalBody: unknown,
	readiness: RestartReadiness | null,
	members: Map<string, MemberInfo>,
): RunningAgent[] {
	const agents = new Map<string, RunningAgent>();
	const sessions = obj(sessionsBody).sessions;
	if (Array.isArray(sessions)) {
		for (const entry of sessions) {
			const e = obj(entry);
			const sessionName = str(e.sessionName);
			if (!sessionName) continue;
			agents.set(sessionName, {
				sessionName,
				pid: typeof e.pid === 'number' ? e.pid : undefined,
				cwd: str(e.cwd) ?? undefined,
				inProcess: false,
				busy: false,
			});
		}
	}
	const inProcess = obj(obj(terminalBody).data).inProcessSessions;
	if (Array.isArray(inProcess)) {
		for (const name of inProcess) {
			if (typeof name !== 'string' || name.length === 0) continue;
			const existing = agents.get(name);
			if (existing) existing.inProcess = true;
			else agents.set(name, { sessionName: name, inProcess: true, busy: false });
		}
	}
	for (const busy of readiness?.busyAgents ?? []) {
		const agent = agents.get(busy.session) ?? { sessionName: busy.session, inProcess: false, busy: false };
		agent.busy = true;
		agent.busySince = busy.since;
		agent.busyMessage = busy.messagePreview;
		agents.set(busy.session, agent);
	}
	for (const agent of agents.values()) {
		const member = members.get(agent.sessionName);
		if (member) {
			agent.memberName = member.memberName;
			agent.teamName = member.teamName;
			agent.runtimeType = member.runtimeType;
		}
	}
	return [...agents.values()].sort((a, b) => a.sessionName.localeCompare(b.sessionName));
}

/**
 * Ask the backend on `port` what is running. Never throws: each part is
 * null when its endpoint does not answer.
 *
 * @param port - Backend web port
 * @param httpGet - HTTP GET (injectable for tests)
 * @returns Snapshot
 */
export async function fetchBackendSnapshot(port: number | string, httpGet: HttpGet = defaultHttpGet): Promise<BackendSnapshot> {
	const url = backendUrl(port);
	let health: BackendHealth | null = null;
	try {
		health = parseHealth(await httpGet(`${url}${WEB_CONSTANTS.ENDPOINTS.HEALTH}`, SNAPSHOT_REQUEST_TIMEOUT_MS));
	} catch {
		return { url, health: null, agents: null, agentsError: 'backend is not answering', readiness: null };
	}

	const get = (path: string): Promise<unknown> => httpGet(`${url}${path}`, SNAPSHOT_REQUEST_TIMEOUT_MS);
	const [sessions, terminal, teams, readinessBody] = await Promise.allSettled([
		get(WEB_CONSTANTS.ENDPOINTS.SESSIONS),
		get(WEB_CONSTANTS.ENDPOINTS.TERMINAL_SESSIONS),
		get(WEB_CONSTANTS.ENDPOINTS.TEAMS),
		get(SAFE_RESTART_CONSTANTS.READINESS_ENDPOINT),
	]);
	const readiness = readinessBody.status === 'fulfilled' ? parseReadiness(readinessBody.value) : null;
	if (sessions.status === 'rejected') {
		const reason = sessions.reason instanceof Error ? sessions.reason.message : String(sessions.reason);
		return { url, health, agents: null, agentsError: `GET ${WEB_CONSTANTS.ENDPOINTS.SESSIONS} failed: ${reason}`, readiness };
	}
	const members = teams.status === 'fulfilled' ? parseTeamMembers(teams.value) : new Map<string, MemberInfo>();
	const agents = buildAgentList(sessions.value, terminal.status === 'fulfilled' ? terminal.value : null, readiness, members);
	return { url, health, agents, readiness };
}

/**
 * Parse pid lines (one per line, as printed by `lsof -t`).
 *
 * @param stdout - Command output
 * @param excludePid - A pid to leave out (this CLI process)
 * @returns Unique positive pids
 */
export function parsePidLines(stdout: string, excludePid: number = process.pid): number[] {
	const pids = stdout
		.split('\n')
		.map((line) => parseInt(line.trim(), 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== excludePid);
	return [...new Set(pids)];
}

/**
 * Pids LISTENING on a TCP port (never clients connected to it).
 *
 * @param port - TCP port
 * @param run - Shell runner
 * @returns Listener pids (empty when none, or when lsof is unavailable)
 */
export async function findListenerPids(port: number | string, run: RunCommand): Promise<number[]> {
	try {
		return parsePidLines(await run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`));
	} catch {
		return [];
	}
}

/**
 * Parse `ps -A -o pid=,ppid=,command=` output.
 *
 * @param stdout - Command output
 * @returns Rows
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of stdout.split('\n')) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
		if (!match) continue;
		rows.push({ pid: parseInt(match[1], 10), ppid: parseInt(match[2], 10), command: match[3] ?? '' });
	}
	return rows;
}

/**
 * Read the process table.
 *
 * @param run - Shell runner
 * @returns Rows (empty when `ps` fails)
 */
export async function readProcessTable(run: RunCommand): Promise<ProcessRow[]> {
	try {
		return parseProcessTable(await run('ps -A -o pid=,ppid=,command='));
	} catch {
		return [];
	}
}

/**
 * Every descendant of `rootPid` (children, grandchildren, ...), e.g. the
 * agent runtimes node-pty spawned under the backend.
 *
 * @param rows - Process table
 * @param rootPid - Ancestor pid
 * @returns Descendant rows, parents before children
 */
export function collectDescendants(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const list = byParent.get(row.ppid) ?? [];
		list.push(row);
		byParent.set(row.ppid, list);
	}
	const result: ProcessRow[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		const parent = queue.shift() as number;
		for (const child of byParent.get(parent) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			result.push(child);
			queue.push(child.pid);
		}
	}
	return result;
}

/**
 * Whether a command line is a Crewly backend entrypoint.
 *
 * @param command - Full command line
 * @returns True for `backend/src/index.(js|ts)`
 */
export function isCrewlyBackendCommand(command: string): boolean {
	return CREWLY_BACKEND_COMMAND_PATTERN.test(command);
}

/**
 * Human-readable duration, e.g. `3h 2m`, `45s`.
 *
 * @param seconds - Duration in seconds
 * @returns Short string
 */
export function formatUptime(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const d = Math.floor(total / 86_400);
	const h = Math.floor((total % 86_400) / 3_600);
	const m = Math.floor((total % 3_600) / 60);
	const s = total % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/**
 * Label for an agent: `session (Member, Team, runtime)`.
 *
 * @param agent - Agent
 * @returns Label
 */
export function describeAgent(agent: RunningAgent): string {
	const who = [agent.memberName, agent.teamName, agent.runtimeType].filter(Boolean).join(', ');
	return who ? `${agent.sessionName} (${who})` : agent.sessionName;
}
