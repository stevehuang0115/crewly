/**
 * Tests for the CLI status command.
 *
 * Validates backend health checking, tmux session listing,
 * verbose process information, and error handling.
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
	// Backend status check
	// -----------------------------------------------------------------------

	describe('backend status', () => {
		it('shows running status when backend responds', async () => {
			mockAxiosGet
				.mockResolvedValueOnce({
					status: 200,
					data: { uptime: 3600, version: '1.0.5' },
				})
				.mockResolvedValueOnce({
					data: { success: true, data: [{ name: 'team1' }] },
				});

			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Backend Server: Running');
			expect(output).toContain('3600');
			expect(output).toContain('1.0.5');
			expect(output).toContain('Active Teams: 1');
		});

		it('shows not running when backend is unreachable', async () => {
			mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'));
			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Backend Server: Not Running');
			expect(output).toContain('npx crewly start');
		});

		it('handles teams API failure gracefully', async () => {
			mockAxiosGet
				.mockResolvedValueOnce({
					status: 200,
					data: { uptime: 100, version: '1.0.0' },
				})
				.mockRejectedValueOnce(new Error('API error'));

			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Backend Server: Running');
			expect(output).toContain('API not fully available');
		});

		it('handles missing uptime and version in response', async () => {
			mockAxiosGet
				.mockResolvedValueOnce({
					status: 200,
					data: {},
				})
				.mockResolvedValueOnce({
					data: { success: true, data: [] },
				});

			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Backend Server: Running');
			expect(output).toContain('0s');
			expect(output).toContain('unknown');
		});
	});

	// -----------------------------------------------------------------------
	// Tmux session listing
	// -----------------------------------------------------------------------

	describe('tmux sessions', () => {
		it('shows session count when tmux has sessions', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return 'crewly_agent1:0:1700000000\nother-session:1:1700000001\n';
				}
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('2 total sessions');
			expect(output).toContain('Crewly sessions: 1');
		});

		it('shows no sessions when tmux returns empty', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));
			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No sessions running');
		});

		it('shows tmux not available when command fails', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux')) {
					throw new Error('tmux not found');
				}
				return '';
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Tmux: Not available');
			// tmux is optional (node-pty backend): status must not tell users to install it.
			expect(output).not.toContain('Install tmux');
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
		it('shows running processes in verbose mode', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tmux list-sessions')) {
					return '';
				}
				if (cmd.includes('ps aux')) {
					return 'user  1234  2.5  1.0  0  0  ??  S  10:00AM  0:05.00  node backend/dist/index.js\n';
				}
				if (cmd.includes('lsof')) {
					return 'node  1234  user  3u  IPv4  0x1234  0t0  TCP *:3000 (LISTEN)\n';
				}
				return '';
			});

			await statusCommand({ verbose: true });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Running Processes');
			expect(output).toContain('PID 1234');
			expect(output).toContain('Port Usage');
		});

		it('does not show processes in non-verbose mode', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));
			mockExecAsync.mockReturnValue('');

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).not.toContain('Running Processes');
		});

		it('handles no processes found in verbose mode', async () => {
			mockAxiosGet.mockRejectedValue(new Error('not running'));

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('lsof')) return '';
				return '';
			});

			await statusCommand({ verbose: true });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No Crewly processes found');
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe('error handling', () => {
		it('reports errors when they occur', async () => {
			// The status command catches most errors internally per-section.
			// Backend failure is handled, tmux failure is handled, so we just
			// verify the command completes without crashing.
			mockAxiosGet.mockRejectedValue(new Error('unexpected'));

			mockExecAsync.mockImplementation(() => {
				throw new Error('unexpected');
			});

			await statusCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			// Backend should show not running
			expect(output).toContain('Backend Server: Not Running');
			// Tmux should show not available
			expect(output).toContain('Tmux: Not available');
		});
	});
});
