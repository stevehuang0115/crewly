/**
 * Tests for the CLI stop command.
 *
 * Validates graceful shutdown, force shutdown, tmux session cleanup,
 * and backend process termination.
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

import { stopCommand } from './stop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure mockExecAsync to return specific results based on command pattern. */
function setupExecMock(
	responses: Record<string, string | Error>,
): void {
	mockExecAsync.mockImplementation((cmd: string) => {
		for (const [pattern, response] of Object.entries(responses)) {
			if (cmd.includes(pattern)) {
				return response;
			}
		}
		return '';
	});
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
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Graceful shutdown flow (non-force)
	// -----------------------------------------------------------------------

	describe('graceful shutdown', () => {
		it('attempts graceful shutdown, kills sessions, and kills backend processes', async () => {
			// Server health check succeeds
			mockAxiosGet.mockResolvedValue({ status: 200 });

			setupExecMock({
				'tmux list-sessions': 'crewly_agent1\ncrewly_agent2\n',
				'tmux kill-session': '',
				'ps aux': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Attempting graceful shutdown');
			expect(output).toContain('Crewly stopped successfully');
		});

		it('SIGTERMs the backend alone first and waits for it to drain before the sweep', async () => {
			mockAxiosGet.mockResolvedValue({ status: 200 });
			setupExecMock({
				'lsof -iTCP': '4242\n',
				'kill -0 4242': new Error('ESRCH'),
				'tmux list-sessions': '',
				'ps aux': '',
			});

			await stopCommand({});

			const cmds = mockExecAsync.mock.calls.map((c: unknown[]) => c[0] as string);
			const term = cmds.indexOf('kill -TERM 4242');
			expect(term).toBeGreaterThanOrEqual(0);
			expect(cmds.indexOf('kill -0 4242')).toBeGreaterThan(term);
			expect(cmds.findIndex((c) => c.includes('ps aux'))).toBeGreaterThan(term);
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('finish in-flight agent turns');
		});

		it('does not look for a backend to drain with --force', async () => {
			setupExecMock({ 'tmux list-sessions': '', 'ps aux': '' });
			await stopCommand({ force: true });
			const cmds = mockExecAsync.mock.calls.map((c: unknown[]) => c[0] as string);
			expect(cmds.some((c) => c.includes('lsof -iTCP'))).toBe(false);
		});

		it('proceeds when server is not responding during graceful shutdown', async () => {
			mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));

			setupExecMock({
				'tmux list-sessions': '',
				'ps aux': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Server not responding');
			expect(output).toContain('Crewly stopped successfully');
		});
	});

	// -----------------------------------------------------------------------
	// Force shutdown
	// -----------------------------------------------------------------------

	describe('force shutdown', () => {
		it('skips graceful shutdown when force is true', async () => {
			setupExecMock({
				'tmux list-sessions': '',
				'ps aux': '',
			});

			await stopCommand({ force: true });

			expect(mockAxiosGet).not.toHaveBeenCalled();
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).not.toContain('Attempting graceful shutdown');
			expect(output).toContain('Crewly stopped successfully');
		});

		it('uses SIGKILL when force is true for backend processes', async () => {
			setupExecMock({
				'tmux list-sessions': '',
				'ps aux': 'user 1234 0.0 0.0 crewly-backend\n',
				'kill': '',
			});

			await stopCommand({ force: true });

			expect(mockExecAsync).toHaveBeenCalledWith(
				expect.stringContaining('SIGKILL'),
			);
		});
	});

	// -----------------------------------------------------------------------
	// Session cleanup
	// -----------------------------------------------------------------------

	describe('tmux session cleanup', () => {
		it('kills all crewly_ prefixed sessions', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			setupExecMock({
				'tmux list-sessions':
					'crewly_agent1\ncrewly_agent2\nother-session\n',
				'tmux kill-session': '',
				'ps aux': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Found 2 Crewly sessions');
		});

		it('handles no crewly sessions found', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			setupExecMock({
				'tmux list-sessions': 'other-session\n',
				'ps aux': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No Crewly sessions found');
		});

		it('handles tmux not available', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux')) {
					throw new Error('tmux not found');
				}
				return '';
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('tmux not available');
		});

		it('handles individual session kill failure gracefully', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			let killCallCount = 0;
			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return 'crewly_agent1\ncrewly_agent2\n';
				}
				if (cmd.includes('tmux kill-session')) {
					killCallCount++;
					if (killCallCount === 1) {
						throw new Error('session gone');
					}
					return '';
				}
				if (cmd.includes('ps aux')) {
					return '';
				}
				return '';
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('already terminated');
		});
	});

	// -----------------------------------------------------------------------
	// Backend process cleanup
	// -----------------------------------------------------------------------

	describe('backend process cleanup', () => {
		it('finds and kills backend processes with SIGTERM', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			setupExecMock({
				'tmux list-sessions': '',
				'ps aux':
					'user  5678  0.0  0.0 ... crewly-backend\nuser  9012  0.0  0.0 ... backend/dist\n',
				'kill': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Found 2 backend processes');
		});

		it('handles no backend processes found', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			setupExecMock({
				'tmux list-sessions': '',
				'ps aux': '',
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No backend processes found');
		});

		it('handles backend kill error and throws', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux')) return '';
				if (cmd.includes('ps aux')) {
					throw new Error('permission denied');
				}
				return '';
			});

			await stopCommand({});

			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe('error handling', () => {
		it('exits with code 1 on unexpected error', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation(() => {
				throw new Error('catastrophic failure');
			});

			await stopCommand({});

			expect(exitSpy).toHaveBeenCalledWith(1);
			const output = errorSpy.mock.calls
				.map((c: unknown[]) => c[0])
				.join('\n');
			expect(output).toContain('Error stopping Crewly');
		});

		it('suggests --force flag on non-force failure', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation(() => {
				throw new Error('unexpected error');
			});

			await stopCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('--force');
		});

		it('does not suggest --force when already using force', async () => {
			mockExecAsync.mockImplementation(() => {
				throw new Error('unexpected error');
			});

			await stopCommand({ force: true });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).not.toContain('--force');
		});

		it('handles non-Error objects in catch block', async () => {
			mockAxiosGet.mockRejectedValue('string error');

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux')) return '';
				if (cmd.includes('ps aux')) {
					throw 'raw string error';
				}
				return '';
			});

			await stopCommand({});

			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});
