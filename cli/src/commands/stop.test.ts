/**
 * Tests for the CLI stop command.
 *
 * Validates that stop drains the Crewly backend on the port (safe restart),
 * force-kills it and its children with --force, reports exactly what it
 * stopped, never claims success when it found nothing (#776), leaves
 * non-Crewly listeners and its own ancestors alone, and cleans up legacy tmux
 * sessions.
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

const mockWaitForPidExit = jest.fn();
jest.mock('../utils/safe-shutdown.js', () => {
	const actual = jest.requireActual('../utils/safe-shutdown.js');
	return {
		...actual,
		waitForPidExit: (...args: unknown[]) => mockWaitForPidExit(...args),
	};
});

import { stopCommand } from './stop.js';

const actualWaitForPidExit = jest.requireActual('../utils/safe-shutdown.js').waitForPidExit;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Backend routes for the axios mock: path → body. */
type Routes = Record<string, unknown>;

/** Serve `routes` from the axios mock; anything else is ECONNREFUSED. */
function mockBackend(routes: Routes): void {
	mockAxiosGet.mockImplementation(async (url: string) => {
		const body = routes[new URL(url).pathname];
		if (body === undefined) throw new Error('connect ECONNREFUSED');
		return { status: 200, data: body };
	});
}

/** A healthy backend with two agents, one mid-turn. */
const HEALTHY: Routes = {
	'/health': { status: 'healthy', version: '1.20.99', uptime: 60 },
	'/api/sessions': {
		sessions: [
			{ sessionName: 'crewly-orc', pid: 5001, cwd: '/p' },
			{ sessionName: 'web-alice-1a2b', pid: 5002, cwd: '/p' },
		],
	},
	'/api/teams': { success: true, data: [{ name: 'Web Team', members: [{ name: 'Alice', sessionName: 'web-alice-1a2b' }] }] },
	'/api/system/restart-readiness': {
		safe: false,
		busyAgents: [{ session: 'web-alice-1a2b', since: '2026-09-23T10:00:00Z', messagePreview: 'Build the login page' }],
		queued: 0,
	},
};

/** Process table: backend 4242 on the port with two agent runtimes under it. */
const BACKEND_TABLE = [
	'4242 1 node /usr/lib/node_modules/crewly/dist/backend/backend/src/index.js',
	'5001 4242 claude --dangerously-skip-permissions',
	'5002 4242 codex --yolo',
].join('\n');

/**
 * Exec mock. `alive` lists pids that `kill -0` reports alive (each entry is
 * consumed per check when given as a count: pid → number of "alive" answers).
 */
function mockExec(options: {
	lsof?: string;
	ps?: string;
	tmux?: string | Error;
	alive?: Record<number, number>;
} = {}): void {
	const alive = { ...(options.alive ?? {}) };
	mockExecAsync.mockImplementation((cmd: string) => {
		if (cmd.includes('lsof')) return options.lsof ?? '';
		if (cmd.includes('ps -A')) return options.ps ?? '';
		if (cmd.includes('tmux list-sessions')) return options.tmux ?? '';
		const zero = cmd.match(/^kill -0 (\d+)$/);
		if (zero) {
			const pid = Number(zero[1]);
			if ((alive[pid] ?? 0) > 0) {
				alive[pid] -= 1;
				return '';
			}
			return new Error('ESRCH');
		}
		return '';
	});
}

/** Commands run through the exec mock, in order. */
function commands(): string[] {
	return mockExecAsync.mock.calls.map((c: unknown[]) => c[0] as string);
}

/** Everything printed via console.log. */
function printed(spy: jest.SpyInstance): string {
	return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stopCommand', () => {
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
		// Real polling, but fast: poll every 1ms.
		mockWaitForPidExit.mockImplementation((pid: number, timeoutMs: number, deps: Record<string, unknown>) =>
			actualWaitForPidExit(pid, timeoutMs, { ...deps, pollMs: 1 }),
		);
		process.exitCode = 0;
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
		process.exitCode = 0;
	});

	describe('graceful stop (safe-restart drain kept)', () => {
		it('lists the agents and who is mid-turn, SIGTERMs the backend alone, waits for it, and reports what it stopped', async () => {
			mockBackend(HEALTHY);
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE, alive: { 4242: 1 } });

			await stopCommand({});

			const cmds = commands();
			const term = cmds.indexOf('kill -TERM 4242');
			expect(term).toBeGreaterThanOrEqual(0);
			expect(cmds.lastIndexOf('kill -0 4242')).toBeGreaterThan(term);
			// The agents ended with the backend: never signalled individually
			expect(cmds).not.toContain('kill -TERM 5001');
			expect(cmds.some((c) => c.startsWith('kill -KILL'))).toBe(false);

			const output = printed(logSpy);
			expect(output).toContain('2 agent(s) running: crewly-orc, web-alice-1a2b');
			expect(output).toContain('1 agent(s) are mid-turn');
			expect(output).toContain('web-alice-1a2b (since 2026-09-23T10:00:00Z): Build the login page');
			expect(output).toContain('finish in-flight agent turns');
			expect(output).toContain('✓ backend PID 4242 (port 8787)');
			expect(output).toContain('✓ 2 agent session(s): crewly-orc, web-alice-1a2b (Alice, Web Team)');
			expect(output).toContain('Crewly stopped');
			expect(process.exitCode).toBe(0);
		});

		it('terminates an agent process that outlived the backend and reports it', async () => {
			mockBackend(HEALTHY);
			// 5001 is alive once (after the backend exited), then gone after SIGTERM
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE, alive: { 5001: 1 } });

			await stopCommand({});

			expect(commands()).toContain('kill -TERM 5001');
			expect(printed(logSpy)).toContain('✓ PID 5001, left running by the backend (claude --dangerously-skip-permissions)');
		});

		it('fails, and does not claim success, when the backend does not exit within the drain budget', async () => {
			mockBackend(HEALTHY);
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });
			mockWaitForPidExit.mockResolvedValueOnce(false);

			await stopCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Still running:');
			expect(output).toContain('backend PID 4242 did not exit within');
			expect(output).toContain('crewly stop --force');
			expect(output).not.toContain('Crewly stopped');
			expect(process.exitCode).toBe(1);
		});

		it('still stops a wedged Crewly backend that holds the port but does not answer /health', async () => {
			mockBackend({});
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });

			await stopCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Server not responding on port 8787');
			expect(commands()).toContain('kill -TERM 4242');
			expect(output).toContain('✓ backend PID 4242 (port 8787)');
		});
	});

	describe('nothing to stop (#776: never report success after finding nothing)', () => {
		it('says there was nothing to stop, and not "stopped"', async () => {
			mockBackend({});
			mockExec({ lsof: '' });

			await stopCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Nothing to stop: no Crewly backend is listening on port 8787');
			expect(output).toContain('crewly service stop');
			expect(output).not.toContain('Crewly stopped');
			expect(output).not.toContain('Stopped:');
			expect(commands().some((c) => c.startsWith('kill -TERM') || c.startsWith('kill -KILL'))).toBe(false);
		});

		it('leaves a non-Crewly process on the port alone and says so', async () => {
			mockBackend({});
			mockExec({ lsof: '777\n', ps: '777 1 python3 -m http.server 8787' });

			await stopCommand({});

			const output = printed(logSpy);
			expect(output).toContain('Left alone: PID 777 holds port 8787 but is not a Crewly backend (python3 -m http.server 8787)');
			expect(output).toContain('Nothing to stop');
			expect(commands()).not.toContain('kill -TERM 777');
		});

		it('never runs the old machine-wide `ps aux | grep crewly|backend` sweep', async () => {
			mockBackend(HEALTHY);
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });

			await stopCommand({});

			expect(commands().some((c) => c.includes('ps aux'))).toBe(false);
		});
	});

	describe('--force', () => {
		it('skips the API and the drain, SIGKILLs the backend and every process under it, and lists them', async () => {
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });

			await stopCommand({ force: true });

			expect(mockAxiosGet).not.toHaveBeenCalled();
			const cmds = commands();
			expect(cmds).toEqual(expect.arrayContaining(['kill -KILL 4242', 'kill -KILL 5001', 'kill -KILL 5002']));
			expect(cmds).not.toContain('kill -TERM 4242');
			const output = printed(logSpy);
			expect(output).not.toContain('Attempting graceful shutdown');
			expect(output).toContain('✓ backend PID 4242 (port 8787, SIGKILL)');
			expect(output).toContain('✓ 2 process(es) under the backend: 5001 claude --dangerously-skip-permissions; 5002 codex --yolo');
			expect(output).toContain('Crewly stopped');
		});

		it('reports a process that survived SIGKILL and fails', async () => {
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE, alive: { 5002: 99 } });

			await stopCommand({ force: true });

			expect(printed(logSpy)).toContain('✗ PID 5002 (codex --yolo) survived SIGKILL');
			expect(process.exitCode).toBe(1);
		});

		it('never signals itself or its ancestors (stop run from an agent shell under the backend)', async () => {
			const me = process.pid;
			const table = [
				'4242 1 node /x/dist/backend/backend/src/index.js',
				'5001 4242 /bin/zsh',
				`${me} 5001 node crewly stop --force`,
				'5002 4242 codex --yolo',
			].join('\n');
			mockExec({ lsof: '4242\n', ps: table });

			await stopCommand({ force: true });

			const cmds = commands();
			expect(cmds).toContain('kill -KILL 5002');
			expect(cmds).not.toContain('kill -KILL 5001');
			expect(cmds).not.toContain(`kill -KILL ${me}`);
		});
	});

	describe('legacy tmux sessions', () => {
		it('kills crewly_* sessions and reports each one', async () => {
			mockBackend({});
			mockExec({ tmux: 'crewly_agent1\ncrewly_agent2\nother-session\n' });

			await stopCommand({});

			const cmds = commands();
			expect(cmds).toContain('tmux kill-session -t "crewly_agent1"');
			expect(cmds).not.toContain('tmux kill-session -t "other-session"');
			const output = printed(logSpy);
			expect(output).toContain('✓ legacy tmux session crewly_agent1');
			expect(output).toContain('✓ legacy tmux session crewly_agent2');
			expect(output).toContain('Crewly stopped');
		});

		it('says nothing about tmux when it is absent', async () => {
			mockBackend({});
			mockExec({ tmux: new Error('tmux: command not found') });

			await stopCommand({});

			expect(printed(logSpy)).not.toMatch(/tmux:/);
		});
	});

	describe('error handling', () => {
		it('exits 1 and suggests --force on an unexpected error', async () => {
			mockBackend(HEALTHY);
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });
			mockWaitForPidExit.mockRejectedValueOnce(new Error('catastrophic failure'));

			await stopCommand({});

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n')).toContain('Error stopping Crewly');
			expect(printed(logSpy)).toContain('--force');
		});

		it('does not suggest --force when already using force', async () => {
			mockExec({ lsof: '4242\n', ps: BACKEND_TABLE });
			mockWaitForPidExit.mockRejectedValueOnce(new Error('catastrophic failure'));

			await stopCommand({ force: true });

			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(printed(logSpy)).not.toContain('--force');
		});
	});
});
