/**
 * Tests for the backend/agents snapshot used by `crewly status` and `crewly stop`.
 */

import {
	backendUrl,
	buildAgentList,
	collectDescendants,
	describeAgent,
	fetchBackendSnapshot,
	findListenerPids,
	formatUptime,
	isCrewlyBackendCommand,
	parseHealth,
	parsePidLines,
	parseProcessTable,
	parseTeamMembers,
	readProcessTable,
	type HttpGet,
} from './backend-status.js';

/** HTTP stub serving path → body; missing paths reject; Error bodies reject. */
function httpOf(routes: Record<string, unknown>): HttpGet & jest.Mock {
	return jest.fn(async (url: string) => {
		const body = routes[new URL(url).pathname];
		if (body === undefined) throw new Error('connect ECONNREFUSED');
		if (body instanceof Error) throw body;
		return body;
	});
}

describe('parseHealth', () => {
	it('reads version, uptime, mode and the orchestrator / team-health blocks', () => {
		expect(
			parseHealth({
				status: 'healthy',
				version: '1.2.3',
				uptime: 12.5,
				mode: 'headless',
				orchestrator: { status: 'degraded', reason: 'hung' },
				team_health: { status: 'ok' },
			}),
		).toEqual({
			status: 'healthy',
			version: '1.2.3',
			uptimeSeconds: 12.5,
			mode: 'headless',
			orchestratorStatus: 'degraded',
			orchestratorReason: 'hung',
			teamHealthStatus: 'ok',
		});
	});

	it('tolerates an old or odd body', () => {
		expect(parseHealth(null)).toMatchObject({ status: 'unknown', version: null, uptimeSeconds: null, orchestratorStatus: null });
		expect(parseHealth({ status: 'healthy', uptime: 'x' }).uptimeSeconds).toBeNull();
	});
});

describe('parseTeamMembers', () => {
	it('maps session names to member, team and runtime', () => {
		const map = parseTeamMembers({
			success: true,
			data: [
				{ name: 'Web', members: [{ name: 'Alice', sessionName: 'web-alice', runtimeType: 'codex-cli' }, { name: 'NoSession' }] },
				{ id: 'team-2', members: 'not-an-array' },
			],
		});
		expect(map.get('web-alice')).toEqual({ memberName: 'Alice', teamName: 'Web', runtimeType: 'codex-cli' });
		expect(map.size).toBe(1);
	});

	it('returns an empty map for a malformed body', () => {
		expect(parseTeamMembers({ data: null }).size).toBe(0);
		expect(parseTeamMembers(undefined).size).toBe(0);
	});
});

describe('buildAgentList', () => {
	it('merges PTY sessions, in-process agents, busy flags and member names, sorted by name', () => {
		const agents = buildAgentList(
			{ sessions: [{ sessionName: 'b-agent', pid: 11, cwd: '/b' }, { sessionName: 'a-orc', pid: 10 }, { bogus: true }] },
			{ data: { inProcessSessions: ['c-assistant', 'a-orc', 42] } },
			{ safe: false, busyAgents: [{ session: 'b-agent', since: 'T1', messagePreview: 'do it' }], queued: 0 },
			new Map([['b-agent', { memberName: 'Bob', teamName: 'T', runtimeType: 'claude-code' }]]),
		);
		expect(agents.map((a) => a.sessionName)).toEqual(['a-orc', 'b-agent', 'c-assistant']);
		expect(agents[0]).toMatchObject({ pid: 10, inProcess: true, busy: false });
		expect(agents[1]).toMatchObject({ pid: 11, cwd: '/b', busy: true, busySince: 'T1', busyMessage: 'do it', memberName: 'Bob' });
		expect(agents[2]).toMatchObject({ inProcess: true, busy: false });
	});

	it('includes a busy agent that is missing from the session list', () => {
		const agents = buildAgentList({ sessions: [] }, null, { safe: false, busyAgents: [{ session: 'ghost', since: 'T', messagePreview: '' }], queued: 0 }, new Map());
		expect(agents).toEqual([expect.objectContaining({ sessionName: 'ghost', busy: true })]);
	});
});

describe('fetchBackendSnapshot', () => {
	it('returns health, agents and readiness from a running backend', async () => {
		const http = httpOf({
			'/health': { status: 'healthy', version: '9.9.9' },
			'/api/sessions': { sessions: [{ sessionName: 'crewly-orc', pid: 7 }] },
			'/api/terminal/sessions': { data: { inProcessSessions: [] } },
			'/api/teams': { data: [] },
			'/api/system/restart-readiness': { safe: true, busyAgents: [], queued: 2 },
		});
		const snap = await fetchBackendSnapshot(8787, http);
		expect(snap.url).toBe('http://localhost:8787');
		expect(snap.health?.version).toBe('9.9.9');
		expect(snap.agents).toEqual([expect.objectContaining({ sessionName: 'crewly-orc', pid: 7, busy: false })]);
		expect(snap.readiness).toMatchObject({ safe: true, queued: 2 });
	});

	it('does not query anything else when /health does not answer', async () => {
		const http = httpOf({});
		const snap = await fetchBackendSnapshot(8787, http);
		expect(snap).toMatchObject({ health: null, agents: null, readiness: null });
		expect(http).toHaveBeenCalledTimes(1);
	});

	it('reports a failed session list as unknown, not as zero agents', async () => {
		const http = httpOf({ '/health': { status: 'healthy' }, '/api/sessions': new Error('status code 500') });
		const snap = await fetchBackendSnapshot(8787, http);
		expect(snap.agents).toBeNull();
		expect(snap.agentsError).toContain('/api/sessions failed: status code 500');
	});

	it('keeps agents when teams, terminal sessions and readiness are unavailable (older backend)', async () => {
		const http = httpOf({ '/health': { status: 'healthy' }, '/api/sessions': { sessions: [{ sessionName: 's1', pid: 1 }] } });
		const snap = await fetchBackendSnapshot('9000', http);
		expect(snap.url).toBe('http://localhost:9000');
		expect(snap.agents).toHaveLength(1);
		expect(snap.readiness).toBeNull();
	});
});

describe('process helpers', () => {
	it('parsePidLines drops blanks, junk, duplicates and the excluded pid', () => {
		expect(parsePidLines('12\n\n12\nabc\n0\n34\n', 34)).toEqual([12]);
	});

	it('findListenerPids asks lsof for LISTEN sockets only, and returns [] when the command fails', async () => {
		const run = jest.fn(async (_command: string) => '4242\n');
		expect(await findListenerPids(8787, run)).toEqual([4242]);
		expect(run.mock.calls[0][0]).toContain('-sTCP:LISTEN');
		expect(await findListenerPids(8787, async () => { throw new Error('no lsof'); })).toEqual([]);
	});

	it('parseProcessTable reads pid, ppid and the full command', () => {
		expect(parseProcessTable('  10     1 node a b\n 11 10 claude --x\nbad line\n')).toEqual([
			{ pid: 10, ppid: 1, command: 'node a b' },
			{ pid: 11, ppid: 10, command: 'claude --x' },
		]);
	});

	it('readProcessTable returns [] when ps fails', async () => {
		expect(await readProcessTable(async () => { throw new Error('no ps'); })).toEqual([]);
	});

	it('collectDescendants walks the whole tree below a pid, and only that tree', () => {
		const rows = parseProcessTable('1 0 init\n10 1 backend\n11 10 pty\n12 11 claude\n20 1 other\n21 20 other-child');
		expect(collectDescendants(rows, 10).map((r) => r.pid)).toEqual([11, 12]);
		expect(collectDescendants(rows, 99)).toEqual([]);
	});

	it('isCrewlyBackendCommand matches the compiled and dev entrypoints only', () => {
		expect(isCrewlyBackendCommand('node /usr/lib/node_modules/crewly/dist/backend/backend/src/index.js')).toBe(true);
		expect(isCrewlyBackendCommand('tsx backend/src/index.ts')).toBe(true);
		expect(isCrewlyBackendCommand('node my-backend/server.js')).toBe(false);
	});
});

describe('formatting', () => {
	it('backendUrl uses localhost (loopback: no API token needed)', () => {
		expect(backendUrl(8787)).toBe('http://localhost:8787');
	});

	it('formatUptime picks the two largest units', () => {
		expect(formatUptime(42)).toBe('42s');
		expect(formatUptime(125)).toBe('2m 5s');
		expect(formatUptime(3725)).toBe('1h 2m');
		expect(formatUptime(90_000)).toBe('1d 1h');
		expect(formatUptime(-5)).toBe('0s');
	});

	it('describeAgent adds member, team and runtime when known', () => {
		expect(describeAgent({ sessionName: 's', inProcess: false, busy: false })).toBe('s');
		expect(describeAgent({ sessionName: 's', inProcess: false, busy: false, memberName: 'A', teamName: 'T', runtimeType: 'codex-cli' })).toBe('s (A, T, codex-cli)');
	});
});
