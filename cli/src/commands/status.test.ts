/**
 * Tests for the CLI status command.
 *
 * Validates the backend block (pid, port, version, health), the agent list
 * from the backend API (busy flags from restart readiness), legacy tmux
 * reporting, verbose process information, and error handling (#776).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy(
		{},
		{
			get: () => {
				const fn = (s: string) => s;
				return new Proxy(fn, {
					get: () => fn,
					apply: (_t: unknown, _this: unknown, args: string[]) => args[0],
				});
			},
		},
	),
}));

const mockExecAsync = jest.fn();
jest.mock('child_process', () => ({
	exec: jest.fn(
		(
			cmd: string,
			cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
		) => {
			const result = mockExecAsync(cmd);
			if (result instanceof Error) {
				cb(result, { stdout: '', stderr: result.message });
			} else {
				cb(null, {
					stdout: typeof result === 'string' ? result : '',
					stderr: '',
				});
			}
		},
	),
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
	__esModule: true,
	default: {
		get: (...args: unknown[]) => mockAxiosGet(...args),
	},
}));

import { statusCommand } from './status.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Backend routes for the axios mock: path → body (an Error rejects). */
type Routes = Record<string, unknown>;

/** Serve `routes` from the axios mock; anything else is ECONNREFUSED. */
function mockBackend(routes: Routes): void {
	mockAxiosGet.mockImplementation(async (url: string) => {
		const body = routes[new URL(url).pathname];
		if (body === undefined) throw new Error('connect ECONNREFUSED');
		if (body instanceof Error) throw body;
		return { status: 200, data: body };
	});
}

/** A healthy backend running two agents, one busy. */
const HEALTHY_ROUTES: Routes = {
	'/health': {
		status: 'healthy',
		uptime: 3725,
		version: '1.20.99',
		mode: 'standard',
		orchestrator: { status: 'ok', reason: null },
		team_health: { status: 'ok' },
	},
	'/api/sessions': {
		sessions: [
			{ sessionName: 'crewly-orc', pid: 5001, cwd: '/proj', status: 'active' },
			{ sessionName: 'web-alice-1a2b', pid: 5002, cwd: '/proj/web', status: 'active' },
		],
	},
	'/api/terminal/sessions': { success: true, data: { sessions: ['crewly-orc', 'web-alice-1a2b', 'assistant'], inProcessSessions: ['assistant'] } },
	'/api/teams': {
		success: true,
		data: [
			{ name: 'Orchestrator', members: [{ name: 'Orchestrator', sessionName: 'crewly-orc', runtimeType: 'claude-code' }] },
			{ name: 'Web Team', members: [{ name: 'Alice', sessionName: 'web-alice-1a2b', runtimeType: 'codex-cli' }] },
		],
	},
	'/api/system/restart-readiness': {
		safe: false,
		busyAgents: [{ session: 'web-alice-1a2b', since: '2026-09-23T10:00:00Z', messagePreview: 'Build the login page' }],
		queued: 0,
		draining: false,
	},
};

/** Exec mock: port 8787 held by pid 4242 (a Crewly backend), no tmux. */
function mockProcesses(extra: Record<string, string | Error> = {}): void {
	mockExecAsync.mockImplementation((cmd: string) => {
		for (const [pattern, response] of Object.entries(extra)) {
			if (cmd.includes(pattern)) return response;
		}
		if (cmd.includes('lsof')) return '4242\n';
		if (cmd.includes('ps -A')) return '4242 1 node /usr/lib/node_modules/crewly/dist/backend/backend/src/index.js\n5001 4242 claude --dangerously-skip-permissions\n';
		return '';
	});
}

/** Everything printed via console.log. */
function printed(spy: jest.SpyInstance): string {
	return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

describe('statusCommand', () => {
	let logSpy: jest.SpyInstance;
	let errorSpy: jest.SpyInstance;
	let exitSpy: jest.SpyInstance;

	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation();
		errorSpy = jest.spyOn(console, 'error').mockImplementation();
		exitSpy = jest
			.spyOn(process, 'exit')
			.mockImplementation(() => undefined as never);
		jest.clearAllMocks();
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Backend and agents (#776: status listed nothing — it looked at tmux)
	// -----------------------------------------------------------------------

	describe('backend and agents', () => {
		it('lists the backend (pid, port, version, uptime, health) and the running agents with busy state', async () => {
			mockBackend(HEALTHY_ROUTES);
			mockProcesses();

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Backend: running');
			expect(output).toContain('PID: 4242');
			expect(output).toContain('Port: 8787');
			expect(output).toContain('Version: 1.20.99');
			expect(output).toContain('Uptime: 1h 2m');
			expect(output).toContain('Health: healthy, orchestrator ok, team health ok');
			expect(output).toContain('Agents: 3 running, 1 busy');
			expect(output).toMatch(/crewly-orc \(Orchestrator, Orchestrator, claude-code\)\s+PID 5001\s+idle/);
			expect(output).toMatch(/web-alice-1a2b \(Alice, Web Team, codex-cli\)\s+PID 5002\s+busy since 2026-09-23T10:00:00Z — Build the login page/);
			expect(output).toMatch(/assistant\s+in-process\s+idle/);
			expect(output).not.toMatch(/tmux/i);
		});

		it('says "none running" when the backend has no agents', async () => {
			mockBackend({ ...HEALTHY_ROUTES, '/api/sessions': { sessions: [] }, '/api/terminal/sessions': { success: true, data: { sessions: [], inProcessSessions: [] } }, '/api/system/restart-readiness': { safe: true, busyAgents: [], queued: 0 } });
			mockProcesses();

			await statusCommand({});

			expect(printed(logSpy)).toContain('Agents: none running');
		});

		it('reports when the session list cannot be read instead of claiming there are no agents', async () => {
			mockBackend({ ...HEALTHY_ROUTES, '/api/sessions': new Error('Request failed with status code 500') });
			mockProcesses();

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('could not list them');
			expect(output).toContain('/api/sessions failed');
			expect(output).not.toContain('none running');
		});

		it('says busy state is unknown on a backend without restart readiness', async () => {
			const { ['/api/system/restart-readiness']: _omit, ...routes } = HEALTHY_ROUTES;
			mockBackend(routes);
			mockProcesses();

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Agents: 3 running, busy state unknown');
			expect(output).not.toContain('idle');
		});

		it('flags a degraded orchestrator with its reason', async () => {
			mockBackend({
				...HEALTHY_ROUTES,
				'/health': { status: 'healthy', version: '1.20.99', uptime: 5, orchestrator: { status: 'degraded', reason: 'orchestrator session is hung' } },
			});
			mockProcesses();

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('orchestrator degraded');
			expect(output).toContain('orchestrator session is hung');
		});

		it('shows not running when nothing listens on the port', async () => {
			mockBackend({});
			mockProcesses({ lsof: '' });

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Backend: not running (nothing listening on port 8787)');
			expect(output).toContain('crewly start');
			expect(output).not.toContain('Agents');
		});

		it('shows a wedged backend: port held but /health does not answer', async () => {
			mockBackend({});
			mockProcesses();

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Backend: not answering');
			expect(output).toContain('held by PID 4242');
			expect(output).toContain('crewly stop');
		});

		it('shows agent working directories in verbose mode', async () => {
			mockBackend(HEALTHY_ROUTES);
			mockProcesses();

			await statusCommand({ verbose: true });

			expect(printed(logSpy)).toContain('cwd: /proj/web');
		});
	});

	describe('tmux sessions', () => {
		it('reports legacy crewly_ tmux sessions when they exist, without counting unrelated ones', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return 'crewly_agent1:0:1700000000\nother-session:1:1700000001\n';
				}
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Legacy tmux sessions (crewly_*): 1');
			expect(output).not.toContain('total sessions');
		});

		it('fresh install: prints no tmux reference (the real command returns empty output, it does not throw)', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));
			// Model the real shell: `tmux list-sessions … 2>/dev/null || echo ""`
			// prints an empty line when tmux is absent or has no sessions.
			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions') && cmd.includes('|| echo ""')) return '\n';
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
			expect(output).not.toMatch(/tmux/i);
		});

		it('prints no tmux reference when only unrelated tmux sessions exist', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));
			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) return 'work:1:1700000000\nnotes:0:1700000001\n';
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
			expect(output).not.toMatch(/tmux/i);
		});

		it('prints no tmux reference when the tmux command fails', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux')) {
					throw new Error('tmux not found');
				}
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			// tmux is not used (node-pty backend): no warning, no install advice.
			expect(output).not.toMatch(/tmux/i);
		});

		it('shows session details in verbose mode', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return 'crewly_agent1:0:1700000000\n';
				}
				if (cmd.includes('tmux capture-pane')) {
					return 'agent is working on task\n';
				}
				return '';
			});

			await statusCommand({ verbose: true });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('crewly_agent1');
			expect(output).toContain('Attached: No');
		});

		it('handles capture-pane failure in verbose mode', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return 'crewly_agent1:1:1700000000\n';
				}
				if (cmd.includes('tmux capture-pane')) {
					throw new Error('pane error');
				}
				return '';
			});

			await statusCommand({ verbose: true });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Unable to capture');
		});
	});

	// -----------------------------------------------------------------------
	// Verbose process information
	// -----------------------------------------------------------------------

	describe('verbose process check', () => {
		it('shows the backend process and its children in verbose mode', async () => {
			mockBackend(HEALTHY_ROUTES);
			mockProcesses();

			await statusCommand({ verbose: true });

			const output = printed(logSpy);
			expect(output).toContain('PID 4242 (listening on 8787)');
			expect(output).toContain('└ PID 5001 claude');
		});

		it('does not show processes in non-verbose mode', async () => {
			mockBackend(HEALTHY_ROUTES);
			mockProcesses();

			await statusCommand({});

			expect(printed(logSpy)).not.toContain('Processes:');
		});

		it('says nothing is listening in verbose mode when the port is free', async () => {
			mockBackend({});
			mockProcesses({ lsof: '' });

			await statusCommand({ verbose: true });

			expect(printed(logSpy)).toContain('Nothing is listening on port 8787');
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe('error handling', () => {
		it('completes when every call fails', async () => {
			mockAxiosGet.mockRejectedValue(new Error('unexpected'));
			mockExecAsync.mockImplementation(() => {
				throw new Error('unexpected');
			});

			await statusCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Backend: not running');
			// tmux is not used: its failure is silent
			expect(output).not.toMatch(/tmux/i);
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});
});
