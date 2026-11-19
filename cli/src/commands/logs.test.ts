/**
 * Tests for the CLI logs command.
 *
 * Validates project log display, communication log display,
 * scheduler log display, follow mode, and error handling.
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
// The log reader no longer shells out to `tail`; the same mock stands in for it.
jest.mock('../utils/tail-file.js', () => ({
	tailFile: (file: string, lines: number): string => {
		const result = mockExecAsync(`tail -n ${lines} "${file}"`);
		return typeof result === 'string' ? result : 'No logs';
	},
	followCommand: (files: string[]) => ({ command: 'tail', args: ['-f', ...files] }),
}));
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
	spawn: jest.fn(() => ({
		stdout: { on: jest.fn() },
		stderr: { on: jest.fn() },
		on: jest.fn((event: string, cb: (code: number) => void) => {
			if (event === 'close') {
				// Immediately close to avoid hanging
				setImmediate(() => cb(0));
			}
		}),
		kill: jest.fn(),
	})),
}));

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { logsCommand } from './logs.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('logsCommand', () => {
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
	// Basic log display
	// -----------------------------------------------------------------------

	describe('basic log display', () => {
		it('displays header with default 50 lines', async () => {
			mockExistsSync.mockReturnValue(false);
			mockReadFileSync.mockReturnValue('[]');

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('last 50 lines');
		});

		it('displays header with custom line count', async () => {
			mockExistsSync.mockReturnValue(false);
			mockReadFileSync.mockReturnValue('[]');

			await logsCommand({ lines: '100' });

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('last 100 lines');
		});
	});

	// -----------------------------------------------------------------------
	// Project logs
	// -----------------------------------------------------------------------

	describe('project logs', () => {
		it('shows project communication logs when they exist', async () => {
			// projects.json exists, project path exists, and communication log exists
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return true;
				if (p === '/test/project') return true;
				if (p.includes('communication.log')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify([{ path: '/test/project' }]),
			);

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('tail')) {
					return '[2024-01-01] Agent -> Orchestrator: task done\n';
				}
				return '';
			});

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Project: project');
		});

		it('handles no projects.json file', async () => {
			mockExistsSync.mockReturnValue(false);

			await logsCommand({});

			// Should not crash, just skip project logs
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Crewly Logs');
		});

		it('handles malformed projects.json', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return true;
				return false;
			});

			mockReadFileSync.mockReturnValue('not valid json');

			await logsCommand({});

			// Should handle gracefully
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Crewly Logs');
		});

		it('limits to 3 most recent projects', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return true;
				if (p.includes('communication.log')) return true;
				return true;
			});

			mockReadFileSync.mockReturnValue(
				JSON.stringify([
					{ path: '/test/p1' },
					{ path: '/test/p2' },
					{ path: '/test/p3' },
					{ path: '/test/p4' },
					{ path: '/test/p5' },
				]),
			);

			mockExecAsync.mockReturnValue('');

			await logsCommand({});

			// Should only process first 3
			const projectHeaders = logSpy.mock.calls
				.map((c: unknown[]) => c[0])
				.filter((s: unknown) => typeof s === 'string' && s.includes('Project:'));
			expect(projectHeaders.length).toBeLessThanOrEqual(3);
		});
	});

	// -----------------------------------------------------------------------
	// Communication logs
	// -----------------------------------------------------------------------

	describe('communication logs', () => {
		it('shows global communication logs with color coding', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return false;
				if (p.includes('communication.log')) return true;
				return false;
			});

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('communication.log')) {
					return 'STATUS UPDATE: agent1 is active\nERROR: connection lost\nGeneral log message\n';
				}
				return '';
			});

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Recent Communication');
		});

		it('handles missing global communication log', async () => {
			mockExistsSync.mockReturnValue(false);

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No global communication logs');
		});

		it('handles empty communication log', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return false;
				if (p.includes('communication.log')) return true;
				return false;
			});

			mockExecAsync.mockReturnValue('');

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No communication logs');
		});
	});

	// -----------------------------------------------------------------------
	// Scheduler logs
	// -----------------------------------------------------------------------

	describe('scheduler logs', () => {
		it('shows scheduler logs with color coding', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return false;
				if (p.includes('scheduler.log')) return true;
				return false;
			});

			mockExecAsync.mockImplementation((cmd: string) => {
				if (cmd.includes('scheduler.log')) {
					return 'Scheduled: heartbeat check\nExecuted: daily report\nOther scheduler message\n';
				}
				return '';
			});

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Scheduler Activity');
		});

		it('handles missing scheduler log', async () => {
			mockExistsSync.mockReturnValue(false);

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('No scheduler logs');
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	describe('error handling', () => {
		it('handles errors in showProjectLogs gracefully', async () => {
			// showProjectLogs catches its own errors internally
			mockExistsSync.mockImplementation(() => {
				throw new Error('fs error');
			});

			await logsCommand({});

			// Should still complete — internal catch handles it
			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Crewly Logs');
		});

		it('handles a log read failure gracefully', async () => {
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes('projects.json')) return false;
				if (p.includes('communication.log')) return true;
				return false;
			});

			mockExecAsync.mockImplementation(() => {
				throw new Error('tail failed');
			});

			await logsCommand({});

			const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
			expect(output).toContain('Unable to read communication logs');
		});
	});
});
