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

describe('codex known start-up prompts (2026-09-26: Kai, Nova stuck on the resume directory picker)', () => {
	it('answers "Working directory · resume" with Enter (option 1, the session directory)', async () => {
		const { CODEX_KNOWN_PROMPTS } = await import('./codex-runtime.service.js');
		const screen = `Working directory · resume
  Session = latest cwd recorded in the resumed session
  Current = your current working directory
› 1. Use session directory (/opt/steamfun-src)
  2. Use current directory (/usr/lib/node_modules/crewly)
  enter continue · esc use session · ctrl+c quit`;
		const flat = screen.replace(/\s+/g, '');
		const hit = CODEX_KNOWN_PROMPTS.find((p) => p.match.every((re) => re.test(flat)));
		expect(hit?.id).toBe('codex.resume_working_directory');
		expect(hit?.keys).toEqual(['Enter']);
		const idle = '› Ask Codex to do anything'.replace(/\s+/g, '');
		expect(CODEX_KNOWN_PROMPTS.some((p) => p.match.every((re) => re.test(idle)))).toBe(false);
	});
});

describe('codex 0.158 first-run screens (owner stuck on "Press enter to continue" after codex login)', () => {
	/**
	 * Returns the known prompt a screen matches, the same way
	 * answerKnownPrompt does (whitespace stripped).
	 *
	 * @param screen - Captured screen
	 * @returns Matching prompt id, or undefined
	 */
	async function matchScreen(screen: string): Promise<{ id: string; keys: readonly string[] } | undefined> {
		const { CODEX_KNOWN_PROMPTS } = await import('./codex-runtime.service.js');
		const flat = screen.replace(/\s+/g, '');
		return CODEX_KNOWN_PROMPTS.find((p) => p.match.every((re) => re.test(flat)));
	}

	it('answers the post-sign-in "Before you start … Press enter to continue" notice with Enter', async () => {
		const screen = `  >_ Welcome to Codex, OpenAI's command-line coding agent

  ✓ Signed in with your ChatGPT account

  Before you start:

  Decide how much autonomy you want to grant Codex
  For more details see the Codex docs

  Codex can make mistakes
  Review the code it writes and commands it runs

  Powered by your ChatGPT account
  Uses your plan's rate limits and training data preferences

  Press enter to continue`;
		const hit = await matchScreen(screen);
		expect(hit?.id).toBe('codex.first_run_notice');
		expect(hit?.keys).toEqual(['Enter']);
	});

	it('trusts the agent folder when "Trust and continue" is the highlighted option', async () => {
		const screen = `  Folder access
  /opt/project

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back`;
		const hit = await matchScreen(screen);
		expect(hit?.id).toBe('codex.trust_folder');
		expect(hit?.keys).toEqual(['Enter']);
		// Cursor moved elsewhere: leave it alone rather than pick the wrong one.
		expect(await matchScreen(screen.replace('› 1.', '  1.').replace('  2. Back', '› 2. Back'))).toBeUndefined();
	});

	it('skips (not installs) on the update-available prompt', async () => {
		const screen = `  ✨ Update available! 0.158.0 -> 0.159.0
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue`;
		const hit = await matchScreen(screen);
		expect(hit?.id).toBe('codex.update_available');
		expect(hit?.keys).toEqual(['Down', 'Enter']);
	});

	it('keeps the configured model on the model-migration notice', async () => {
		const screen = `  Codex just got an upgrade. Introducing gpt-6-sol.
  We recommend switching from gpt-5.6-sol to gpt-6-sol.

› 1. Try new model
  2. Use existing model`;
		const hit = await matchScreen(screen);
		expect(hit?.id).toBe('codex.model_migration');
		expect(hit?.keys).toEqual(['Down', 'Enter']);
		expect(await matchScreen(screen.replace('› 1. Try', '  1. Try').replace('  2. Use', '› 2. Use'))).toBeUndefined();
	});

	it('does not fire on the idle prompt or the sign-in screen', async () => {
		expect(await matchScreen('› Ask Codex to do anything\n  model: gpt-6-sol')).toBeUndefined();
		expect(
			await matchScreen(`Welcome to Codex, OpenAI's command-line coding agent
  Sign in with ChatGPT to use Codex as part of your paid plan
› 1. Sign in with ChatGPT
  2. Sign in with Device Code
  Press enter to continue`),
		).toBeUndefined();
	});

	it('answerKnownPrompt sends each key in order', async () => {
		const { CodexRuntimeService } = await import('./codex-runtime.service.js');
		const helper = { sendEnter: jest.fn().mockResolvedValue(undefined), sendKey: jest.fn().mockResolvedValue(undefined) };
		const svc = new CodexRuntimeService(helper as never, '/tmp');
		const answered = await svc.answerKnownPrompt('s', `Update available!\n› 1. Update now (runs x)\n 2. Skip\n 3. Skip until next version`);
		expect(answered).toBe(true);
		expect(helper.sendKey).toHaveBeenCalledWith('s', 'Down');
		expect(helper.sendEnter).toHaveBeenCalledWith('s');
	});
});
