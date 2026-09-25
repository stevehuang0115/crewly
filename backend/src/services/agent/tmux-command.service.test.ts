import { TmuxCommandService } from './tmux-command.service.js';
import { LoggerService } from '../core/logger.service.js';

// Mock LoggerService and its methods
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock child_process spawn
jest.mock('child_process', () => ({
	spawn: jest.fn(),
}));

/**
 * Helper to create a mock spawn process that resolves with given output
 */
function createMockProcess(stdout: string, exitCode: number = 0, stderr: string = '') {
	return {
		stdout: {
			on: jest.fn().mockImplementation((event: string, callback: (data: string) => void) => {
				if (event === 'data' && stdout) {
					callback(stdout);
				}
			}),
		},
		stderr: {
			on: jest.fn().mockImplementation((event: string, callback: (data: string) => void) => {
				if (event === 'data' && stderr) {
					callback(stderr);
				}
			}),
		},
		on: jest.fn().mockImplementation((event: string, callback: (code: number) => void) => {
			if (event === 'close') {
				callback(exitCode);
			}
		}),
		unref: jest.fn(),
	};
}

describe('TmuxCommandService', () => {
	let service: TmuxCommandService;
	let mockSpawn: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
		service = new TmuxCommandService();
		mockSpawn = require('child_process').spawn;
	});

	describe('constructor', () => {
		it('should create logger instance', () => {
			expect(LoggerService.getInstance).toHaveBeenCalled();
		});
	});

	describe('sessionExists (dormant - tmux disabled)', () => {
		it('should return false when tmux is disabled', async () => {
			// tmuxDisabled = true, so sessionExists always returns false
			const result = await service.sessionExists('test-session');
			expect(result).toBe(false);
		});

		it('should return false for any session name', async () => {
			const result = await service.sessionExists('nonexistent-session');
			expect(result).toBe(false);
		});
	});

	describe('sendKey', () => {
		it('should send key successfully via executeTmuxCommand', async () => {
			mockSpawn.mockImplementation(() => createMockProcess('', 0));

			await expect(service.sendKey('test-session', 'Enter')).resolves.not.toThrow();
		});

		it('should handle errors when sending key fails', async () => {
			mockSpawn.mockImplementation(() => createMockProcess('', 1, 'Error message'));

			await expect(service.sendKey('test-session', 'Enter')).rejects.toThrow();
		});
	});

	describe('capturePane (dormant - tmux disabled)', () => {
		it('should return empty string because tmux is disabled (sessionExists returns false)', async () => {
			// capturePane calls sessionExists first, which returns false when tmux is disabled
			const result = await service.capturePane('test-session', 10);
			expect(result).toBe('');
		});

		it('should return empty string for non-existent session', async () => {
			const result = await service.capturePane('nonexistent-session', 10);
			expect(result).toBe('');
		});
	});

	describe('createSession', () => {
		it('should create session successfully', async () => {
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'new-session') {
					return createMockProcess('', 0);
				}
				if (args[0] === 'list-sessions') {
					return createMockProcess('test-session\n');
				}
				if (args[0] === 'capture-pane') {
					return createMockProcess('pane content\n');
				}
				return createMockProcess('', 0);
			});

			await expect(
				service.createSession('test-session', '/tmp', 'test-window')
			).resolves.not.toThrow();
		});

		it('should include configured shell in tmux command', async () => {
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'list-sessions') {
					return createMockProcess('test-session\n');
				}
				if (args[0] === 'capture-pane') {
					return createMockProcess('pane content\n');
				}
				return createMockProcess('', 0);
			});

			await service.createSession('test-session', '/tmp');

			// Verify tmux was called with the new-session args
			expect(mockSpawn).toHaveBeenCalledWith('tmux', expect.arrayContaining([
				'new-session',
				'-d',
				'-s',
				'test-session',
				'-c',
				'/tmp',
			]));
		});
	});

	describe('setEnvironmentVariable (dormant - tmux robosend removed)', () => {
		it('should throw because tmux_robosend.sh has been removed', async () => {
			await expect(
				service.setEnvironmentVariable('test-session', 'TEST_VAR', 'test-value')
			).rejects.toThrow('tmux_robosend.sh has been removed');
		});

		it('refuses a secret before anything is typed, naming the variable but not the value', async () => {
			const fakeKey = 'AIzaTESTtmuxGeminiKey0123456789abcdef';
			const attempt = service.setEnvironmentVariable('test-session', 'GEMINI_API_KEY', fakeKey);
			await expect(attempt).rejects.toThrow(/Refusing to type secret environment variable GEMINI_API_KEY/);
			await expect(attempt).rejects.not.toThrow(fakeKey);
			expect(mockSpawn).not.toHaveBeenCalled();
		});
	});

	describe('validateSessionReady', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'test';
		});

		afterEach(() => {
			delete process.env.NODE_ENV;
		});

		it('should return true when session is ready', async () => {
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'list-sessions') {
					return createMockProcess('test-session\n');
				} else if (args[0] === 'capture-pane') {
					return createMockProcess('pane content\n');
				}
				return createMockProcess('', 0);
			});

			const result = await service.validateSessionReady('test-session');
			expect(result).toBe(true);
		});

		it('should return false when session is not found', async () => {
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'list-sessions') {
					return createMockProcess('other-session\n');
				}
				return createMockProcess('', 0);
			});

			const result = await service.validateSessionReady('test-session');
			expect(result).toBe(false);
		});

		it('should retry on failure and eventually return false', async () => {
			let callCount = 0;
			mockSpawn.mockImplementation(() => {
				callCount++;
				return createMockProcess('', 1, 'error');
			});

			const result = await service.validateSessionReady('test-session');
			expect(result).toBe(false);
			expect(callCount).toBeGreaterThan(1);
		});

		it('should succeed on retry after initial failure', async () => {
			let callCount = 0;
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				callCount++;
				if (callCount === 1) {
					return createMockProcess('', 1, 'error');
				}
				if (args[0] === 'list-sessions') {
					return createMockProcess('test-session\n');
				} else if (args[0] === 'capture-pane') {
					return createMockProcess('pane content\n');
				}
				return createMockProcess('', 0);
			});

			const result = await service.validateSessionReady('test-session');
			expect(result).toBe(true);
			expect(callCount).toBeGreaterThan(1);
		});
	});

	describe('createSession with race condition fixes', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'test';
		});

		afterEach(() => {
			delete process.env.NODE_ENV;
		});

		it('should include timing delay and validation in session creation', async () => {
			const startTime = Date.now();
			let validationCalled = false;

			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'list-sessions') {
					validationCalled = true;
					return createMockProcess('test-session\n');
				} else if (args[0] === 'capture-pane') {
					return createMockProcess('pane content\n');
				}
				return createMockProcess('', 0);
			});

			await service.createSession('test-session', '/tmp');

			const endTime = Date.now();
			const duration = endTime - startTime;

			expect(duration).toBeGreaterThanOrEqual(500);
			expect(validationCalled).toBe(true);
		});

		it('should handle validation failure gracefully', async () => {
			mockSpawn.mockImplementation((_command: string, args: string[]) => {
				if (args[0] === 'new-session') {
					return createMockProcess('', 0);
				}
				return createMockProcess('', 1, 'error');
			});

			await expect(
				service.createSession('test-session', '/tmp')
			).resolves.not.toThrow();
		});
	});

	describe('listSessions (dormant - tmux disabled)', () => {
		it('should return empty array when tmux is disabled', async () => {
			const result = await service.listSessions();
			expect(result).toEqual([]);
		});
	});

	describe('executeTmuxCommand', () => {
		it('should execute tmux command and return output', async () => {
			mockSpawn.mockImplementation(() => createMockProcess('command output', 0));

			const result = await service.executeTmuxCommand(['display-message', '-p', 'test']);
			expect(result).toBe('command output');
			expect(mockSpawn).toHaveBeenCalledWith('tmux', ['display-message', '-p', 'test']);
		});

		it('should reject on non-zero exit code', async () => {
			mockSpawn.mockImplementation(() => createMockProcess('', 1, 'tmux error'));

			await expect(
				service.executeTmuxCommand(['invalid-command'])
			).rejects.toThrow('tmux command failed');
		});
	});
});
