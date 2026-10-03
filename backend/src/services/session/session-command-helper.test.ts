/**
 * Tests for SessionCommandHelper
 */

import { SessionCommandHelper, KEY_CODES, createSessionCommandHelper } from './session-command-helper.js';
import type { ISession, ISessionBackend } from './session-backend.interface.js';
import { LoggerService } from '../core/logger.service.js';
import * as fs from 'fs';
import * as path from 'path';
import { PtyTerminalBuffer } from './pty/pty-terminal-buffer.js';

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
		it('refuses to type when the input box cannot be read (no styled capture): nothing written', async () => {
			await expect(helper.sendMessage('test-session', 'hello world')).rejects.toMatchObject({ name: 'TuiInputGuardError' });
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('sendShellLine: bracketed paste followed by a separate Enter key (#292, #293)', async () => {
			await helper.sendShellLine('test-session', 'hello world');
			// First call: message text wrapped in bracketed paste markers
			expect(mockSession.write).toHaveBeenNthCalledWith(1, '\x1b[200~hello world\x1b[201~');
			// Second call: Enter key (after delay)
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
			expect(mockSession.write).toHaveBeenCalledTimes(2);
		});

		it('sendShellLine: multi-line text in one bracketed paste', async () => {
			await helper.sendShellLine('test-session', 'line1\nline2\nline3');
			expect(mockSession.write).toHaveBeenNthCalledWith(1, '\x1b[200~line1\nline2\nline3\x1b[201~');
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
		});

		it('should throw error if session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(undefined);
			await expect(helper.sendMessage('non-existent', 'test')).rejects.toThrow(
				"Session 'non-existent' does not exist"
			);
		});
	});

	describe('sendMessage input guard (2026-10-03 phantom owner input), on real TUI captures', () => {
		const FIX = path.join(__dirname, '__fixtures__', 'tui');
		const views = new Map<string, { lines: string[]; cursorRow: number }>();

		/**
		 * Load a recorded frame (Claude Code 2.1.288 / Codex 0.160.0) as the
		 * view the PTY backend would return.
		 */
		async function load(runtime: string, name: string): Promise<{ lines: string[]; cursorRow: number }> {
			const key = `${runtime}/${name}`;
			const cached = views.get(key);
			if (cached) return cached;
			const buffer = new PtyTerminalBuffer(100, 30);
			buffer.write(fs.readFileSync(path.join(FIX, runtime, `${name}.ansi`), 'utf8'));
			await buffer.flush();
			const view = buffer.getInputView();
			buffer.dispose();
			views.set(key, view);
			return view;
		}
		const cc = (n: string) => load('claude-code-2.1.288', n);
		const cx = (n: string) => load('codex-0.160.0', n);
		const gm = (n: string) => load('gemini-0.40.1', n);

		/**
		 * Script the screen: `atStart` until the first write, then each write
		 * of the given kind advances to the next frame (the last repeats).
		 */
		function script(frames: Array<{ lines: string[]; cursorRow: number } | null>, advanceOn: (data: string) => boolean = () => true) {
			let i = 0;
			mockSession.write.mockImplementation((data: string) => {
				if (advanceOn(data) && i < frames.length - 1) i++;
			});
			(mockBackend as any).captureInputView = jest.fn(() => frames[i]);
		}
		const writes = () => mockSession.write.mock.calls.map((c) => c[0] as string);
		const PASTE = (m: string) => `\x1b[200~${m}\x1b[201~`;
		const OURS = '[CHAT:c1] reminder: the owner is waiting';
		const TASK = '## Task\n\nPlease reply.\n> ok go\nthanks';

		it('Claude Code: empty box (placeholder) → paste → exactly ours → one Enter', async () => {
			script([await cc('empty-placeholder'), await cc('typed-single')]);
			await helper.sendMessage('test-session', 'hello world probe');
			expect(writes()).toEqual([PASTE('hello world probe'), '\r']);
		});

		it('Claude Code: the incident — an accepted suggestion in the box: nothing typed, nothing cleared, no Enter', async () => {
			script([await cc('accepted-suggestion')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ name: 'TuiInputGuardError', stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('Claude Code: suggestion + our text in the box after paste → no Enter and the box is NOT cleared', async () => {
			script([await cc('empty-placeholder'), await cc('accepted-suggestion-plus-ours')]);
			await expect(helper.sendMessage('test-session', OURS)).rejects.toMatchObject({ name: 'TuiInputGuardError', stage: 'before-submit' });
			expect(writes()).toEqual([PASTE(OURS)]);
		});

		it('Claude Code: short quoted and multi-line messages are delivered', async () => {
			script([await cc('empty-placeholder'), await cc('pasted-quote-line')]);
			await helper.sendMessage('test-session', '> ok go');
			expect(writes()).toEqual([PASTE('> ok go'), '\r']);
			mockSession.write.mockReset();
			script([await cc('empty-placeholder'), await cc('pasted-5-lines-marker')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('Codex: a multi-line "## Task" message with a quoted line is delivered', async () => {
			script([await cx('empty-placeholder'), await cx('pasted-5-lines')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('Codex: our own leftover copy of the message is cleared with Ctrl+U + Backspace pairs, then sent', async () => {
			const frames = [await cx('pasted-5-lines'), await cx('pair-1'), await cx('pair-1'), await cx('pair-4'), await cx('pair-4'), await cx('pair-5'), await cx('pasted-5-lines')];
			// Advance one frame per pair (on the Backspace) and on the paste.
			script(frames, (d) => d === '\x7f' || d.startsWith('\x1b[200~'));
			await helper.sendMessage('test-session', TASK);
			const w = writes();
			expect(w.filter((x) => x === '\x15')).toHaveLength(5);
			expect(w.filter((x) => x === '\x7f')).toHaveLength(5);
			expect(w.slice(-2)).toEqual([PASTE(TASK), '\r']);
		});

		it('Gemini 0.40.1: delivered into the ▄▄▄/▀▀▀ box', async () => {
			script([await gm('empty-placeholder'), await gm('pasted-5-lines')]);
			await helper.sendMessage('test-session', TASK);
			expect(writes()).toEqual([PASTE(TASK), '\r']);
		});

		it('someone\'s half-typed text is never cleared — nothing typed (Codex race from the review)', async () => {
			script([await cx('typed-single')]);
			await expect(helper.sendMessage('test-session', TASK)).rejects.toMatchObject({ stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('text that rendered only after we read the box empty is left alone: no Enter, no clearing', async () => {
			script([await cx('empty-placeholder'), await cx('after-turn-pasted-5-lines')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).toEqual([PASTE('hello world probe')]);
		});

		it('an unreadable box: nothing typed, no Enter (the API-key dialog / Gemini /ide cases from the review)', async () => {
			script([{ lines: ['│ Paste your API key here │'], cursorRow: 0 }]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-write' });
			expect(writes()).toEqual([]);
		});

		it('a box that becomes unreadable after the paste: no Enter', async () => {
			script([await cc('empty-placeholder'), null]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).not.toContain('\r');
		});

		it('never presses Enter when the paste did not land (box still empty)', async () => {
			script([await cc('empty-placeholder')]);
			await expect(helper.sendMessage('test-session', 'hello world probe')).rejects.toMatchObject({ stage: 'before-submit' });
			expect(writes()).not.toContain('\r');
		});

		it('sendShellLine types a command into a plain shell (paste + Enter) without reading a box', async () => {
			script([{ lines: ['user@host ~ % '], cursorRow: 0 }]);
			await helper.sendShellLine('test-session', 'claude --settings x');
			expect(writes()).toEqual([PASTE('claude --settings x'), '\r']);
		});

		it('a lost Enter after a collapsed paste stays recoverable: the marker seen after our paste is ours later (review #3)', async () => {
			SessionCommandHelper.resetOwnPasteMarkersForTesting();
			const marker = await cc('pasted-5-lines-marker');
			script([await cc('empty-placeholder'), marker]);
			await helper.sendMessage('test-session', TASK); // its Enter "lost": the box still shows the marker
			// Recovery and the retry check both see the marker as ours…
			expect(helper.readInputBox('test-session', TASK, 'recovery').state).toBe('ours');
			expect(helper.readInputBox('test-session', TASK, 'before-write').state).toBe('ours');
			mockSession.write.mockClear();
			expect((await helper.submitIfInputIsOurs('test-session', TASK)).state).toBe('ours');
			expect(writes()).toEqual(['\r']);
			// …but not for another message, nor after the marker is forgotten.
			expect(helper.readInputBox('test-session', 'another message', 'recovery').state).toBe('foreign');
			SessionCommandHelper.resetOwnPasteMarkersForTesting();
			expect(helper.readInputBox('test-session', TASK, 'recovery').state).toBe('foreign');
		});

		it('submitIfInputIsOurs presses Enter only for our own text and reports what it saw', async () => {
			script([await cc('after-turn-empty-box')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('empty');
			script([await cc('accepted-suggestion')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('foreign');
			expect(mockSession.write).not.toHaveBeenCalled();
			script([await cc('typed-single')]);
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('ours');
			expect(mockSession.write).toHaveBeenCalledWith('\r');
		});

		it('submitIfInputIsOurs reports unknown (no Enter) without a styled capture', async () => {
			delete (mockBackend as any).captureInputView;
			expect((await helper.submitIfInputIsOurs('test-session', 'hello world probe')).state).toBe('unknown');
			expect(mockSession.write).not.toHaveBeenCalled();
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
			expect(mockSession.write).toHaveBeenCalledWith(' export MY_VAR="my_value"\r');
		});

		it.each(['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN'])(
			'refuses to type the secret %s into the terminal, and writes nothing',
			async (key) => {
				const fakeSecret = 'AIzaTESTfakeKeyThatMustNeverBeTyped0123';
				await expect(helper.setEnvironmentVariable('test-session', key, fakeSecret)).rejects.toThrow(key);
				expect(mockSession.write).not.toHaveBeenCalled();
			}
		);

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
		it('should have correct key codes for control keys', () => {
			expect(KEY_CODES['Enter']).toBe('\r');
			expect(KEY_CODES['C-c']).toBe('\x03');
			expect(KEY_CODES['C-u']).toBe('\x15');
			expect(KEY_CODES['Escape']).toBe('\x1b');
			expect(KEY_CODES['Tab']).toBe('\t');
		});

		it('should have correct escape sequences for function keys', () => {
			expect(KEY_CODES['F1']).toBe('\x1bOP');
			expect(KEY_CODES['F5']).toBe('\x1b[15~');
			expect(KEY_CODES['F12']).toBe('\x1b[24~');
		});

		it('should send F12 escape sequence (not literal text) to PTY', async () => {
			await helper.sendKey('test-session', 'F12');
			// Must send the escape sequence, NOT the literal string "F12"
			expect(mockSession.write).toHaveBeenCalledWith('\x1b[24~');
			expect(mockSession.write).not.toHaveBeenCalledWith('F12');
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

	describe('dismissInteractivePromptIfNeeded', () => {
		it('should NOT send Escape to an idle Claude screen whose footer says "shift+tab to cycle" (#815)', async () => {
			mockBackend.captureOutput.mockReturnValue('Some output\n❯❯ bypass permissions on (shift+tab to cycle)');
			const result = await helper.dismissInteractivePromptIfNeeded('test-session');
			expect(result).toBe(false);
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should detect the real plan-approval menu and send Escape', async () => {
			mockBackend.captureOutput.mockReturnValue(
				' Claude has written up a plan and is ready to execute. Would you like to proceed?\n ❯ 1. Yes, and use auto mode\n   2. Yes, manually approve edits',
			);
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

});
