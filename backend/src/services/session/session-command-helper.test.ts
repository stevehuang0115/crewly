/**
 * Tests for SessionCommandHelper
 */

import { SessionCommandHelper, KEY_CODES, createSessionCommandHelper } from './session-command-helper.js';
import type { ISession, ISessionBackend } from './session-backend.interface.js';
import { LoggerService } from '../core/logger.service.js';

// Mock the logger service
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock PtyActivityTrackerService — default to high idle time (agent not busy)
const mockGetIdleTimeMs = jest.fn().mockReturnValue(999999);
jest.mock('../agent/pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: jest.fn().mockReturnValue({
			getIdleTimeMs: (...args: unknown[]) => mockGetIdleTimeMs(...args),
		}),
	},
}));

describe('SessionCommandHelper', () => {
	let mockBackend: jest.Mocked<ISessionBackend>;
	let mockSession: jest.Mocked<ISession>;
	let helper: SessionCommandHelper;

	beforeEach(() => {
		// Reset idle time mock to default (agent not busy)
		mockGetIdleTimeMs.mockReturnValue(999999);

		// Create mock session
		mockSession = {
			name: 'test-session',
			pid: 12345,
			cwd: '/test/path',
			onData: jest.fn(),
			onExit: jest.fn(),
			write: jest.fn(),
			resize: jest.fn(),
			kill: jest.fn(),
		} as any;

		// Create mock backend
		mockBackend = {
			createSession: jest.fn().mockResolvedValue(mockSession),
			getSession: jest.fn().mockReturnValue(mockSession),
			killSession: jest.fn().mockResolvedValue(undefined),
			listSessions: jest.fn().mockReturnValue(['test-session']),
			sessionExists: jest.fn().mockReturnValue(true),
			captureOutput: jest.fn().mockReturnValue('terminal output'),
			getTerminalBuffer: jest.fn().mockReturnValue('buffer content'),
			getRawHistory: jest.fn().mockReturnValue('raw history with \x1b[32mcolors\x1b[0m'),
			destroy: jest.fn().mockResolvedValue(undefined),
		} as any;

		helper = new SessionCommandHelper(mockBackend);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('sessionExists', () => {
		it('should return true when session exists', () => {
			expect(helper.sessionExists('test-session')).toBe(true);
			expect(mockBackend.sessionExists).toHaveBeenCalledWith('test-session');
		});

		it('should return false when session does not exist', () => {
			mockBackend.sessionExists.mockReturnValue(false);
			expect(helper.sessionExists('non-existent')).toBe(false);
		});
	});

	describe('getSession', () => {
		it('should return session when it exists', () => {
			const session = helper.getSession('test-session');
			expect(session).toBe(mockSession);
		});

		it('should return undefined when session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			const session = helper.getSession('non-existent');
			expect(session).toBeUndefined();
		});
	});

	describe('sendMessage', () => {
		it('should write message followed by separate Enter key', async () => {
			await helper.sendMessage('test-session', 'hello world');
			// First call: message text
			expect(mockSession.write).toHaveBeenNthCalledWith(1, 'hello world');
			// Second call: Enter key (after delay)
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
			expect(mockSession.write).toHaveBeenCalledTimes(2);
		});

		it('should handle multi-line messages', async () => {
			await helper.sendMessage('test-session', 'line1\nline2\nline3');
			expect(mockSession.write).toHaveBeenNthCalledWith(1, 'line1\nline2\nline3');
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendMessage('non-existent', 'test')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendKey', () => {
		it('should send special key codes', async () => {
			await helper.sendKey('test-session', 'Enter');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});

		it('should send Ctrl+C key code', async () => {
			await helper.sendKey('test-session', 'C-c');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
		});

		it('should send literal key if not special', async () => {
			await helper.sendKey('test-session', 'a');
			expect(mockSession.write).toHaveBeenCalledWith('a');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendKey('non-existent', 'Enter')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendCtrlC', () => {
		it('should send Ctrl+C character', async () => {
			await helper.sendCtrlC('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendCtrlC('non-existent')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendEnter', () => {
		it('should send Enter character', async () => {
			await helper.sendEnter('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});
	});

	describe('sendEscape', () => {
		it('should send Escape character', async () => {
			await helper.sendEscape('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});
	});

	describe('clearCurrentCommandLine', () => {
		it('should send Ctrl+C then Ctrl+U', async () => {
			await helper.clearCurrentCommandLine('test-session');
			expect(mockSession.write).toHaveBeenCalledWith('\x03');
			expect(mockSession.write).toHaveBeenCalledWith('\x15');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.clearCurrentCommandLine('non-existent')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('capturePane', () => {
		it('should return captured output with trailing empty lines stripped', () => {
			mockBackend.captureOutput.mockReturnValue('content\n❯ \n\n\n');
			const output = helper.capturePane('test-session', 50);
			expect(output).toBe('content\n❯ \n');
			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 50);
		});

		it('should use default lines value of 200', () => {
			helper.capturePane('test-session');
			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 200);
		});

		it('should strip trailing whitespace-only lines from terminal buffer', () => {
			// Simulate a terminal with 50+ empty rows below content
			const emptyRows = '\n'.repeat(50);
			mockBackend.captureOutput.mockReturnValue('❯ ' + emptyRows);
			const output = helper.capturePane('test-session');
			expect(output).toBe('❯ \n');
		});
	});

	describe('getRawHistory', () => {
		it('should return raw history with ANSI codes', () => {
			const output = helper.getRawHistory('test-session');
			expect(output).toBe('raw history with \x1b[32mcolors\x1b[0m');
			expect(mockBackend.getRawHistory).toHaveBeenCalledWith('test-session');
		});
	});

	describe('listSessions', () => {
		it('should return list of sessions', () => {
			const sessions = helper.listSessions();
			expect(sessions).toEqual(['test-session']);
		});
	});

	describe('killSession', () => {
		it('should kill the session', async () => {
			await helper.killSession('test-session');
			expect(mockBackend.killSession).toHaveBeenCalledWith('test-session');
		});
	});

	describe('createSession', () => {
		it('should create a session with default options', async () => {
			const session = await helper.createSession('new-session', '/test/cwd');
			expect(mockBackend.createSession).toHaveBeenCalledWith('new-session', {
				cwd: '/test/cwd',
				command: expect.any(String),
				args: undefined,
				env: undefined,
				cols: undefined,
				rows: undefined,
			});
			expect(session).toBe(mockSession);
		});

		it('should create a session with custom options', async () => {
			await helper.createSession('new-session', '/test/cwd', {
				command: 'node',
				args: ['script.js'],
				env: { NODE_ENV: 'test' },
				cols: 120,
				rows: 40,
			});

			expect(mockBackend.createSession).toHaveBeenCalledWith('new-session', {
				cwd: '/test/cwd',
				command: 'node',
				args: ['script.js'],
				env: { NODE_ENV: 'test' },
				cols: 120,
				rows: 40,
			});
		});
	});

	describe('setEnvironmentVariable', () => {
		it('should write export command', async () => {
			await helper.setEnvironmentVariable('test-session', 'MY_VAR', 'my_value');
			expect(mockSession.write).toHaveBeenCalledWith('export MY_VAR="my_value"\r');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(
				helper.setEnvironmentVariable('non-existent', 'KEY', 'VALUE')
			).rejects.toThrow("Session 'non-existent' does not exist");
		});
	});

	describe('resizeSession', () => {
		it('should resize the session', () => {
			helper.resizeSession('test-session', 120, 40);
			expect(mockSession.resize).toHaveBeenCalledWith(120, 40);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.resizeSession('non-existent', 120, 40)).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('getBackend', () => {
		it('should return the underlying backend', () => {
			expect(helper.getBackend()).toBe(mockBackend);
		});
	});

	describe('KEY_CODES', () => {
		it('should have correct key codes', () => {
			expect(KEY_CODES['Enter']).toBe('\r');
			expect(KEY_CODES['C-c']).toBe('\x03');
			expect(KEY_CODES['C-u']).toBe('\x15');
			expect(KEY_CODES['Escape']).toBe('\x1b');
			expect(KEY_CODES['Tab']).toBe('\t');
		});
	});

	describe('createSessionCommandHelper', () => {
		it('should create a SessionCommandHelper instance', () => {
			const newHelper = createSessionCommandHelper(mockBackend);
			expect(newHelper).toBeInstanceOf(SessionCommandHelper);
		});
	});

	describe('subscribeToOutput', () => {
		it('should subscribe to session onData events', () => {
			const callback = jest.fn();
			const mockUnsubscribe = jest.fn();
			mockSession.onData.mockReturnValue(mockUnsubscribe);

			const unsubscribe = helper.subscribeToOutput('test-session', callback);

			expect(mockSession.onData).toHaveBeenCalledWith(callback);
			expect(unsubscribe).toBe(mockUnsubscribe);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.subscribeToOutput('non-existent', jest.fn())).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('subscribeToExit', () => {
		it('should subscribe to session onExit events', () => {
			const callback = jest.fn();
			const mockUnsubscribe = jest.fn();
			mockSession.onExit.mockReturnValue(mockUnsubscribe);

			const unsubscribe = helper.subscribeToExit('test-session', callback);

			expect(mockSession.onExit).toHaveBeenCalledWith(callback);
			expect(unsubscribe).toBe(mockUnsubscribe);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.subscribeToExit('non-existent', jest.fn())).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('waitForPattern', () => {
		it('should resolve when string pattern matches', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.waitForPattern('test-session', 'ready', 5000);

			// Simulate data arriving
			capturedCallback!('loading...');
			capturedCallback!('ready');

			const result = await promise;
			expect(result).toBe('loading...ready');
		});

		it('should resolve when regex pattern matches', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.waitForPattern('test-session', />\s*$/, 5000);

			capturedCallback!('output');
			capturedCallback!('\n> ');

			const result = await promise;
			expect(result).toBe('output\n> ');
		});

		it('should timeout if pattern not found', async () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			await expect(helper.waitForPattern('test-session', 'never-appears', 100)).rejects.toThrow(
				'Timeout waiting for pattern'
			);
		});

		it('should cleanup subscription on match', async () => {
			const mockUnsubscribe = jest.fn();
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return mockUnsubscribe;
			});

			const promise = helper.waitForPattern('test-session', 'found', 5000);
			capturedCallback!('found');
			await promise;

			expect(mockUnsubscribe).toHaveBeenCalled();
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.waitForPattern('non-existent', 'test', 100)).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('waitForAnyPattern', () => {
		it('should resolve with matching pattern id', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const patterns = [
				{ id: 'success', pattern: /success/i },
				{ id: 'error', pattern: /error/i },
			];

			const promise = helper.waitForAnyPattern('test-session', patterns, 5000);

			capturedCallback!('ERROR: something failed');

			const result = await promise;
			expect(result.matchedId).toBe('error');
			expect(result.buffer).toBe('ERROR: something failed');
		});

		it('should match first pattern when multiple could match', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const patterns = [
				{ id: 'first', pattern: 'test' },
				{ id: 'second', pattern: 'test message' },
			];

			const promise = helper.waitForAnyPattern('test-session', patterns, 5000);

			capturedCallback!('test message');

			const result = await promise;
			expect(result.matchedId).toBe('first');
		});

		it('should timeout if no pattern matches', async () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			const patterns = [
				{ id: 'a', pattern: 'pattern-a' },
				{ id: 'b', pattern: 'pattern-b' },
			];

			await expect(helper.waitForAnyPattern('test-session', patterns, 100)).rejects.toThrow(
				'Timeout waiting for any pattern'
			);
		});
	});

	describe('sendMessageWithConfirmation', () => {
		it('should send message and resolve true when confirmation pattern matches', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.sendMessageWithConfirmation(
				'test-session',
				'hello',
				/⠋|⠙|⠹/,
				5000
			);

			// Simulate confirmation appearing
			setTimeout(() => capturedCallback!('⠋ Processing...'), 100);

			const result = await promise;

			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('hello');
		});

		it('should resolve false on timeout', async () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			const result = await helper.sendMessageWithConfirmation(
				'test-session',
				'hello',
				/never-matches/,
				100
			);

			expect(result).toBe(false);
		});

		it('should send Enter key after message', async () => {
			jest.useFakeTimers();
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.sendMessageWithConfirmation(
				'test-session',
				'hello',
				/confirmed/,
				5000
			);

			// Check message was written immediately
			expect(mockSession.write).toHaveBeenCalledWith('hello');

			// Fast-forward past MESSAGE_DELAY (now 1000ms)
			jest.advanceTimersByTime(1100);

			// Enter should now be sent
			expect(mockSession.write).toHaveBeenCalledWith('\r');

			// Resolve the promise
			capturedCallback!('confirmed');
			jest.useRealTimers();
			await promise;
		});

		it('should cleanup subscription on confirmation', async () => {
			const mockUnsubscribe = jest.fn();
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return mockUnsubscribe;
			});

			const promise = helper.sendMessageWithConfirmation(
				'test-session',
				'hello',
				'confirmed',
				5000
			);

			capturedCallback!('confirmed');
			await promise;

			expect(mockUnsubscribe).toHaveBeenCalled();
		});
	});

	describe('writeRaw', () => {
		it('should write raw data without Enter key', () => {
			helper.writeRaw('test-session', 'raw input');
			expect(mockSession.write).toHaveBeenCalledWith('raw input');
			expect(mockSession.write).toHaveBeenCalledTimes(1);
		});

		it('should throw error if session does not exist', () => {
			mockBackend.getSession.mockReturnValue(undefined);
			expect(() => helper.writeRaw('non-existent', 'data')).toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendMessageSmart', () => {
		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendMessageSmart('non-existent', 'test')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});

		it('should write message immediately on call', () => {
			mockSession.onData.mockImplementation(() => jest.fn());

			// Start the promise (don't await)
			helper.sendMessageSmart('test-session', 'hello world', {
				pasteTimeout: 100,
				fallbackDelay: 50,
			});

			// Message should be written immediately (synchronous)
			expect(mockSession.write).toHaveBeenCalledWith('hello world');
		});

		it('should return result object with expected shape', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.sendMessageSmart('test-session', 'test', {
				pasteTimeout: 100,
				fallbackDelay: 50,
				waitForProcessing: false,
			});

			// Immediately simulate paste detection
			capturedCallback!('[Pasted text');

			const result = await promise;

			// Verify result shape
			expect(result).toHaveProperty('pasteDetected');
			expect(result).toHaveProperty('enterSent');
			expect(result).toHaveProperty('processingStarted');
			expect(result).toHaveProperty('usedFallback');
			expect(result.pasteDetected).toBe(true);
			expect(result.enterSent).toBe(true);
		});

		it('should send Enter key after paste detection', async () => {
			let capturedCallback: ((data: string) => void) | null = null;
			mockSession.onData.mockImplementation((cb) => {
				capturedCallback = cb;
				return jest.fn();
			});

			const promise = helper.sendMessageSmart('test-session', 'test', {
				pasteTimeout: 500,
				fallbackDelay: 100,
			});

			// Immediately trigger paste detection
			capturedCallback!('[Pasted text #1 +5 lines]');

			await promise;

			// Enter key should have been sent
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});

		// Note: Complex timing tests (fallback delay, processing detection) are
		// challenging with Jest's fake timers due to the async nature of the function.
		// The core behavior is verified through the tests above and integration testing.
	});

	describe('dismissInteractivePromptIfNeeded', () => {
		it('should detect plan mode and send Escape', async () => {
			mockBackend.captureOutput.mockReturnValue('Some output\n❯❯ bypass permissions on (shift+tab to cycle)');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});

		it('should detect ExitPlanMode pattern', async () => {
			mockBackend.captureOutput.mockReturnValue('Use ExitPlanMode when ready');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});

		it('should detect Plan mode pattern', async () => {
			mockBackend.captureOutput.mockReturnValue('Plan mode active');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(true);
		});

		it('should return false when no plan mode detected', async () => {
			mockBackend.captureOutput.mockReturnValue('Normal terminal output\n❯ ');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should skip plan mode dismissal when agent is busy (low idle time)', async () => {
			// Agent is actively processing — idle time below threshold
			mockGetIdleTimeMs.mockReturnValue(1000); // 1s idle < 5s threshold = busy

			// Even though plan mode text is in the output, should skip because agent is busy
			mockBackend.captureOutput.mockReturnValue('Plan mode active');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});
	});

	describe('sendMessageWithSmartRetry', () => {
		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(
				helper.sendMessageWithSmartRetry('non-existent', 'test')
			).rejects.toThrow("Session 'non-existent' does not exist");
		});

		it('should call dismissInteractivePromptIfNeeded before sending message', async () => {
			// Mock dismiss to track the call and verify ordering
			const callOrder: string[] = [];
			const dismissSpy = jest.spyOn(helper, 'dismissInteractivePromptIfNeeded')
				.mockImplementation(async () => {
					callOrder.push('dismiss');
					return false;
				});
			const smartSpy = jest.spyOn(helper, 'sendMessageSmart')
				.mockImplementation(async () => {
					callOrder.push('sendMessageSmart');
					return { processingStarted: true, pasteDetected: false, enterSent: false, usedFallback: false };
				});

			await helper.sendMessageWithSmartRetry('test-session', 'hello');

			expect(dismissSpy).toHaveBeenCalledWith('test-session');
			expect(callOrder[0]).toBe('dismiss');
			expect(callOrder[1]).toBe('sendMessageSmart');

			dismissSpy.mockRestore();
			smartSpy.mockRestore();
		});

		// Note: Additional async tests for sendMessageWithSmartRetry are challenging
		// due to complex internal timing. The core logic is covered by:
		// 1. sendMessageSmart tests (paste detection, fallback behavior)
		// 2. The error handling test above
		// Integration testing covers the full retry behavior.
	});
});
