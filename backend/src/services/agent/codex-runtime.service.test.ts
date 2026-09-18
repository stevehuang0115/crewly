import { CodexRuntimeService } from './codex-runtime.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES } from '../../constants.js';

describe('CodexRuntimeService', () => {
	let service: CodexRuntimeService;
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;

	beforeEach(() => {
		mockSessionHelper = {
			capturePane: jest.fn().mockReturnValue(''),
			sendKey: jest.fn().mockResolvedValue(undefined),
			sendEnter: jest.fn().mockResolvedValue(undefined),
			sendCtrlC: jest.fn().mockResolvedValue(undefined),
			sendMessage: jest.fn().mockResolvedValue(undefined),
			sendEscape: jest.fn().mockResolvedValue(undefined),
			clearCurrentCommandLine: jest.fn().mockResolvedValue(undefined),
			sessionExists: jest.fn().mockReturnValue(true),
			createSession: jest.fn().mockResolvedValue({ pid: 123, cwd: '/test' }),
			killSession: jest.fn().mockResolvedValue(undefined),
			setEnvironmentVariable: jest.fn().mockResolvedValue(undefined),
			writeRaw: jest.fn(),
			getSession: jest.fn(),
			getRawHistory: jest.fn(),
			getTerminalBuffer: jest.fn(),
			backend: {},
		} as any;

		service = new CodexRuntimeService(mockSessionHelper, '/test/project');
	});

	describe('getRuntimeType', () => {
		it('should return CODEX_CLI runtime type', () => {
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.CODEX_CLI);
		});
	});

	describe('detectRuntimeSpecific', () => {
		it('should detect Codex when ready pattern is present in output', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce('OpenAI Codex\nmodel: gpt-5');

			const result = await service['detectRuntimeSpecific']('test-session');

			expect(result).toBe(true);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledWith('test-session', 120);
			expect(mockSessionHelper.clearCurrentCommandLine).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();
		});

		it('should not detect Codex when no ready pattern is present', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce('testuser@macbookpro crewly %');

			const result = await service['detectRuntimeSpecific']('test-session');

			expect(result).toBe(false);
		});
	});

	describe('getRuntimeReadyPatterns', () => {
		it('should return Codex-specific ready patterns', () => {
			const patterns = service['getRuntimeReadyPatterns']();

			expect(patterns).toContain('codex>');
			expect(patterns).toContain('OpenAI Codex');
			expect(patterns).toContain('Connected to OpenAI');
		});
	});

	describe('getRuntimeErrorPatterns', () => {
		it('should return Codex-specific error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();

			expect(patterns).toContain('command not found: codex');
			expect(patterns).toContain('Authentication failed');
			expect(patterns).toContain('Rate limit exceeded');
		});
	});

	describe('getRuntimeExitPatterns', () => {
		it('should return Codex-specific exit patterns', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns).toHaveLength(3);
			expect(patterns[0].test('codex exited')).toBe(true);
			expect(patterns[0].test('Codex CLI exited')).toBe(true);
			expect(patterns[1].test('Session ended')).toBe(true);
			expect(patterns[2].test('Conversation interrupted')).toBe(true);
		});

		it('should not match unrelated text', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns.some(p => p.test('Ready for commands'))).toBe(false);
		});
	});

	describe('getExitPatterns', () => {
		it('should expose exit patterns via public accessor', () => {
			const patterns = service.getExitPatterns();
			expect(patterns).toHaveLength(3);
		});
	});

	describe('checkCodexInstallation', () => {
		it('should report Codex CLI as available', async () => {
			const result = await service.checkCodexInstallation();
			expect(result.isInstalled).toBe(true);
			expect(result.message).toBe('OpenAI Codex CLI is available');
		});
	});

	describe('initializeCodexInSession', () => {
		it('should call executeRuntimeInitScript', async () => {
			const spy = jest.spyOn(service, 'executeRuntimeInitScript').mockResolvedValue(undefined);

			const result = await service.initializeCodexInSession('test-session');

			expect(result.success).toBe(true);
			expect(spy).toHaveBeenCalledWith('test-session');
		});

		it('should handle initialization errors gracefully', async () => {
			jest.spyOn(service, 'executeRuntimeInitScript').mockRejectedValue(
				new Error('Init failed')
			);

			const result = await service.initializeCodexInSession('test-session');

			expect(result.success).toBe(false);
			expect(result.message).toBe('Init failed');
		});
	});

	describe('isReadyForInput', () => {
		const CODEX_IDLE_SCREEN = [
			'╭──────────────────────────────────────────────────────────╮',
			'│ >_ OpenAI Codex (v0.50.0)                                  │',
			'│                                                            │',
			'│ model:     gpt-5-codex   /model to change                  │',
			'│ directory: /root/.crewly                                   │',
			'╰──────────────────────────────────────────────────────────╯',
			'',
			'  Tip: Use /status to see your session details.',
			'',
			'› Ask Codex to do anything',
			'',
			'  ? for shortcuts                       gpt-5-codex · /root/.crewly',
		].join('\n');

		const CODEX_BOOTING_SCREEN = [
			'╭──────────────────────────────────────────────────────────╮',
			'│ >_ OpenAI Codex (v0.50.0)                                  │',
			'│                                                            │',
			'│ model:     loading                                         │',
			'│ directory: /root/.crewly                                   │',
			'╰──────────────────────────────────────────────────────────╯',
			'',
			'› Ask Codex to do anything',
			'',
			'  ? for shortcuts',
		].join('\n');

		const CODEX_WORKING_SCREEN = [
			'› Read the file at /root/.crewly/prompts/crewly-orc-init.md and follow all instructions in it.',
			'',
			'⠋ Working (3s · esc to interrupt)',
			'',
			'  ? for shortcuts                       gpt-5-codex · /root/.crewly',
		].join('\n');

		const CODEX_SIGNIN_SCREEN = [
			'  Welcome to Codex, OpenAI\'s command-line coding agent',
			'',
			'  Sign in with ChatGPT to use Codex as part of your paid ChatGPT plan',
			'',
			'› 1. Sign in with ChatGPT',
			'  2. Provide your own API key',
			'',
			'  Press Enter to continue',
		].join('\n');

		it('is ready when the idle prompt and status line are showing', () => {
			expect(service.isReadyForInput(CODEX_IDLE_SCREEN)).toBe(true);
		});

		it('is NOT ready while the header still says model: loading (prompt glyph already painted)', () => {
			expect(service.isReadyForInput(CODEX_BOOTING_SCREEN)).toBe(false);
		});

		it('is NOT ready while a spinner / esc-to-interrupt is showing', () => {
			expect(service.isReadyForInput(CODEX_WORKING_SCREEN)).toBe(false);
		});

		it('is NOT ready on the sign-in screen', () => {
			expect(service.isReadyForInput(CODEX_SIGNIN_SCREEN)).toBe(false);
		});

		it('is NOT ready on a bare shell prompt (runtime not launched yet)', () => {
			expect(service.isReadyForInput('root@server:~# ')).toBe(false);
		});

		it('is NOT ready on an empty capture', () => {
			expect(service.isReadyForInput('')).toBe(false);
		});

		it('tolerates ANSI escape codes in the capture', () => {
			const withAnsi = CODEX_IDLE_SCREEN.replace('› Ask Codex', '\u001b[36m› \u001b[0mAsk Codex');
			expect(service.isReadyForInput(withAnsi)).toBe(true);
		});

		it('matches model: loading regardless of column alignment whitespace', () => {
			const spaced = CODEX_IDLE_SCREEN.replace('model:     gpt-5-codex   /model to change', 'model:\t\t  loading');
			expect(service.isReadyForInput(spaced)).toBe(false);
		});
	});
});
