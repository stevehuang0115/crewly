import {
	AntigravityRuntimeService,
	antigravityScreenIncludes,
	detectAntigravityStartupBlocker,
	getAntigravityInputBoxText,
	isAntigravityAccountSession,
	isAntigravityTrustPrompt,
	isTextInAntigravityInputBox,
	resolveAntigravityApiKey,
} from './antigravity-runtime.service.js';
import { RuntimeStartupBlockedError } from './runtime-startup-blocked.error.js';
import { SessionCommandHelper } from '../session/index.js';
import { ANTIGRAVITY_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import * as settingsServiceModule from '../settings/settings.service.js';
import * as credentialsModule from '../harness/harness-credentials.store.js';
import { getDefaultSettings } from '../../types/settings.types.js';

/*
 * Screen fixtures: agy 1.2.11 rendered in a 120-column PTY through
 * @xterm/headless (2026-09-25), with a sandboxed HOME, `modelProvider:
 * "gemini"` and a dummy GEMINI_API_KEY — none of these screens needs an
 * account or a working key. Home-directory paths are shortened.
 */
const RULE = '─'.repeat(120);
const TURN_RULE = '─'.repeat(60);
const LOGO = ['', '      ▄▀▀▄', '     ▀▀▀▀▀▀', '    ▀▀▀▀▀▀▀▀', '   ▄▀▀    ▀▀▄', '  ▄▀▀      ▀▀▄', ''];
const BANNER = ['  Antigravity CLI 1.2.11', '  Gemini API key', '  Gemini 3.1 Pro (Low)', '  /home/me/project', ''];
const FOOTER_TAIL = 'accept-edits · Gemini 3.1 Pro · low';

/** Fresh session, accept-edits mode, nothing typed. */
const IDLE_FRESH = [...LOGO, ...BANNER, RULE, '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)', RULE, `? for shortcuts${' '.repeat(70)}${FOOTER_TAIL}`].join('\n');

/** Text typed but not submitted: the footer hint disappears. */
const TYPED = [...LOGO, ...BANNER, RULE, '> say hello', RULE, `${' '.repeat(85)}${FOOTER_TAIL}`].join('\n');

/** Busy: spinner row under the echoed message, empty box, `esc to cancel` footer. */
const BUSY = [...LOGO, ...BANNER, TURN_RULE, '> say hello', '⣯  Generating...', RULE, '>', RULE, `esc to cancel${' '.repeat(72)}${FOOTER_TAIL}`].join('\n');

/** After a turn (here a rejected dummy key): echo above, idle footer below. */
const AFTER_TURN_ERROR = [
	...LOGO,
	...BANNER,
	TURN_RULE,
	'> say hello',
	'',
	'⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key.,',
	'Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com',
	'metadata:map[service:generativelanguage.googleapis.com] reason:API_KEY_INVALID]',
	'',
	RULE,
	'>',
	RULE,
	`? for shortcuts${' '.repeat(70)}${FOOTER_TAIL}`,
].join('\n');

/** Default mode (no --mode): empty box shows a bare `>`. */
const IDLE_DEFAULT_MODE = [...LOGO, ...BANNER, RULE, '>', RULE, `? for shortcuts${' '.repeat(84)}Gemini 3.1 Pro · low`].join('\n');

/** First Ctrl+C at the idle prompt only arms the exit. */
const CTRL_C_ARMED = [...LOGO, ...BANNER, RULE, '>', RULE, `press ctrl+c again to exit${' '.repeat(73)}Gemini 3.1 Pro · low`].join('\n');

/** Clean exit (Ctrl+D twice). */
const EXITED = [...BANNER, RULE, '>', RULE, '', 'Resume with -c (or command below):', 'agy --conversation=75e715be-ea13-400e-8e4a-0358e87d170c', 'me@host project %'].join('\n');

/** Folder-trust screen for a folder not in trustedWorkspaces. */
const TRUST_SCREEN = [
	'Accessing workspace:',
	'',
	'/home/me/project',
	'',
	'Do you trust the contents of this project?',
	'',
	'Antigravity CLI requires permission to read, edit, and execute files here.',
	'',
	'> Yes, I trust this folder',
	'  No, exit',
	'',
	'  ↑/↓ Navigate · enter Confirm',
	`${' '.repeat(85)}${FOOTER_TAIL}`,
].join('\n');

/** First-run onboarding, step 1. */
const FIRST_RUN_COLOR = [
	...LOGO,
	'Welcome to Antigravity CLI!',
	'',
	'Choose your color scheme:        ╭─────────────────────────────────────╮',
	'                                 │ > you: add a greeting function      │',
	'  > terminal                     │                                     │',
	'    light                        │   Here\'s the change:                │',
	'',
	'    [Next]',
	'',
	'  ↑/↓ Navigate · enter Confirm',
	`${' '.repeat(85)}${FOOTER_TAIL}`,
].join('\n');

/** First-run onboarding, step 2 (Google's terms + data-use consent). */
const FIRST_RUN_TERMS = [
	...LOGO,
	'Terms of Service & Data Use',
	'',
	'  > [x] Yes, I agree to help improve Antigravity CLI by allowing',
	'      Google to collect and use my Interactions data,',
	'',
	'    [Previous]      [Done]',
	'',
	'  ↑/↓ Navigate · enter Toggle',
].join('\n');

/** agy's refusal to start when the provider is gemini but the key env var is empty (wrapped at 120 cols as captured). */
const MISSING_KEY = [
	'me@host project % AGY_CLI_DISABLE_AUTO_UPDATE=true agy --dangerously-skip-permissions --mode=accept-edits',
	'modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set. Set GEMINI_AP',
	'I_KEY to your Gemini API key, or remove "modelProvider" from settings.json to use the default backend.',
	'me@host project %',
].join('\n');

/** The same refusal wrapped at the default 80-column PTY width. */
const MISSING_KEY_80 = [
	'modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY enviro',
	'nment variable is not set. Set GEMINI_API_KEY to your Gemini API key, or remove',
].join('\n');

/** An account session: banner without the `Gemini API key` header (the email is shown instead). */
const ACCOUNT_SESSION = IDLE_FRESH.replace('  Gemini API key', '  someone@example.com');

/** An account sign-in screen (strings from the agy binary). */
const ACCOUNT_LOGIN = ['Select login method:', '  > Sign in with Google', '    Other sign-in options'].join('\n');

describe('Antigravity screen helpers', () => {
	it('finds markers even when the terminal wrapped them', () => {
		expect(antigravityScreenIncludes(MISSING_KEY_80, 'but the GEMINI_API_KEY environment variable is not set')).toBe(true);
		expect(antigravityScreenIncludes(IDLE_FRESH, 'nope')).toBe(false);
	});

	it('classifies the screens only the user may resolve and the ones Crewly refuses', () => {
		expect(detectAntigravityStartupBlocker(FIRST_RUN_COLOR)?.reason).toBe('first_run_setup');
		expect(detectAntigravityStartupBlocker(FIRST_RUN_TERMS)?.reason).toBe('first_run_setup');
		expect(detectAntigravityStartupBlocker(MISSING_KEY)?.reason).toBe('api_key_required');
		expect(detectAntigravityStartupBlocker(MISSING_KEY)?.message).toBe(ANTIGRAVITY_CONSTANTS.MESSAGES.KEY_NOT_IN_SESSION);
		expect(detectAntigravityStartupBlocker(MISSING_KEY_80)?.reason).toBe('api_key_required');
		expect(detectAntigravityStartupBlocker(ACCOUNT_LOGIN)?.reason).toBe('account_login_refused');
		for (const screen of [IDLE_FRESH, BUSY, AFTER_TURN_ERROR, TRUST_SCREEN, TYPED]) {
			expect(detectAntigravityStartupBlocker(screen)).toBeNull();
		}
	});

	it('tells an API-key session from an account session by the header line', () => {
		expect(isAntigravityAccountSession(IDLE_FRESH)).toBe(false);
		expect(isAntigravityAccountSession(ACCOUNT_SESSION)).toBe(true);
		// No banner on screen (scrolled away): nothing to judge.
		expect(isAntigravityAccountSession([RULE, '>', RULE, '? for shortcuts'].join('\n'))).toBe(false);
	});

	it('recognises the folder-trust screen', () => {
		expect(isAntigravityTrustPrompt(TRUST_SCREEN)).toBe(true);
		expect(isAntigravityTrustPrompt(IDLE_FRESH)).toBe(false);
	});

	it('reads the prompt box, not the echoes above it', () => {
		expect(getAntigravityInputBoxText(IDLE_FRESH)).toBe('');
		expect(getAntigravityInputBoxText(IDLE_DEFAULT_MODE)).toBe('');
		expect(getAntigravityInputBoxText(TYPED)).toBe('say hello');
		expect(getAntigravityInputBoxText(BUSY)).toBe('');
		expect(getAntigravityInputBoxText(AFTER_TURN_ERROR)).toBe('');
		expect(getAntigravityInputBoxText('plain shell output')).toBeNull();
	});

	it('reports a message as stuck only while it sits in the prompt box', () => {
		expect(isTextInAntigravityInputBox(TYPED, 'say hello')).toBe(true);
		// Submitted: the echo `> say hello` is above the box, which is empty.
		expect(isTextInAntigravityInputBox(BUSY, 'say hello')).toBe(false);
		expect(isTextInAntigravityInputBox(AFTER_TURN_ERROR, 'say hello')).toBe(false);
		const wrapped = [RULE, '> Read the file at /home/me/.crewly/prompts/team-dev-1-init.md and follow all', '  instructions in it.', RULE, ''].join('\n');
		expect(isTextInAntigravityInputBox(wrapped, 'Read the file at /home/me/.crewly/prompts/team-dev-1-init.md and follow all instructions in it.')).toBe(true);
		expect(isTextInAntigravityInputBox(TYPED, '')).toBe(false);
	});
});

describe('resolveAntigravityApiKey', () => {
	const originalEnv = process.env.GEMINI_API_KEY;
	afterEach(() => {
		jest.restoreAllMocks();
		if (originalEnv === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = originalEnv;
	});

	/**
	 * Stub the key sources.
	 *
	 * @param stored - Key in the harness credentials store
	 * @param fromSettings - Key from Crewly settings
	 */
	function stub(stored: string | null, fromSettings: string | undefined): jest.Mock {
		jest.spyOn(credentialsModule, 'getHarnessCredentialsStore').mockReturnValue({
			getAntigravityGeminiApiKey: () => stored,
		} as unknown as credentialsModule.HarnessCredentialsStore);
		const getApiKey = jest.fn().mockResolvedValue(fromSettings);
		jest.spyOn(settingsServiceModule, 'getSettingsService').mockReturnValue({ getApiKey } as never);
		return getApiKey;
	}

	it('prefers the key saved for Antigravity in Settings → Harness', async () => {
		stub('stored-key', 'settings-key');
		await expect(resolveAntigravityApiKey()).resolves.toBe('stored-key');
	});

	it('falls back to a Crewly Gemini key for the antigravity-cli runtime, then to the env', async () => {
		const getApiKey = stub(null, 'settings-key');
		await expect(resolveAntigravityApiKey()).resolves.toBe('settings-key');
		expect(getApiKey).toHaveBeenCalledWith('gemini', { runtime: 'antigravity-cli' });
		stub(null, undefined);
		process.env.GEMINI_API_KEY = 'env-key';
		await expect(resolveAntigravityApiKey()).resolves.toBe('env-key');
		delete process.env.GEMINI_API_KEY;
		await expect(resolveAntigravityApiKey()).resolves.toBeNull();
	});
});

describe('AntigravityRuntimeService', () => {
	let service: AntigravityRuntimeService;
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;
	let resolveApiKey: jest.Mock;
	let ensureProvider: jest.Mock;

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
		} as unknown as jest.Mocked<SessionCommandHelper>;
		resolveApiKey = jest.fn().mockResolvedValue('AIza-test-key');
		ensureProvider = jest.fn().mockResolvedValue('written');
		service = new AntigravityRuntimeService(mockSessionHelper, '/test/project', {
			resolveApiKey,
			ensureProvider,
			crewlyHome: () => '/home/me/.crewly',
			tmpDir: () => '/tmp',
		});
	});

	afterEach(() => jest.restoreAllMocks());

	it('is the antigravity-cli runtime', () => {
		expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.ANTIGRAVITY_CLI);
	});

	describe('launch', () => {
		/** Mock settings + capture the command sent to the shell. */
		function captureLaunch(command: string = ANTIGRAVITY_CONSTANTS.LAUNCH_COMMAND): jest.SpyInstance {
			const settings = getDefaultSettings();
			settings.general.runtimeCommands['antigravity-cli'] = command;
			jest.spyOn(settingsServiceModule, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(settings),
			} as never);
			return jest.spyOn(service as never, 'sendShellCommandsToSession').mockResolvedValue(undefined as never);
		}

		it('forces the Gemini API key provider (trusting the workspace) before launching', async () => {
			const send = captureLaunch();
			await service.executeRuntimeInitScript('s1', '/work/proj');
			expect(ensureProvider).toHaveBeenCalledWith(['/work/proj', '/home/me/.crewly', '/tmp']);
			expect(ensureProvider.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
		});

		it('launches agy with the auto-update switch, approvals, model flags and the extra workspace folders — never the key', async () => {
			const send = captureLaunch();
			await service.executeRuntimeInitScript('s1', '/work/proj', ['--model', 'gemini-3.8-flash-high', '--effort', 'high']);
			const [, commands, cwd] = send.mock.calls[0] as unknown as [string, string[], string];
			expect(cwd).toBe('/work/proj');
			expect(commands[0]).toBe(
				"AGY_CLI_DISABLE_AUTO_UPDATE=true agy --model gemini-3.8-flash-high --effort high --add-dir='/home/me/.crewly' --add-dir='/tmp' --dangerously-skip-permissions --mode=accept-edits",
			);
			expect(commands[0]).not.toContain('AIza-test-key');
			expect(commands[0]).not.toContain('GEMINI_API_KEY');
		});

		it('resumes with --conversation=<id> and never passes Claude-only arguments', async () => {
			const send = captureLaunch();
			await service.executeRuntimeInitScript('s1', '/work/proj', ['--conversation=abc-123'], '/p/prompt.md', 'crewly-dev', 'abc-123');
			const cmd = (send.mock.calls[0] as unknown as [string, string[]])[1][0];
			expect(cmd).toContain('--conversation=abc-123');
			expect(cmd).not.toContain('--agent');
			expect(cmd).not.toContain('--append-system-prompt-file');
		});

		it('quotes workspace folders with spaces or quotes', async () => {
			service = new AntigravityRuntimeService(mockSessionHelper, '/test/project', {
				resolveApiKey,
				ensureProvider,
				crewlyHome: () => "/home/o'brien/My Crewly",
				tmpDir: () => '/tmp',
			});
			const send = captureLaunch();
			await service.executeRuntimeInitScript('s1', '/work/proj');
			const cmd = (send.mock.calls[0] as unknown as [string, string[]])[1][0];
			expect(cmd).toContain(`--add-dir='/home/o'\\''brien/My Crewly'`);
		});

		it('does not add the env prefix twice to a custom command that has it', async () => {
			const send = captureLaunch('AGY_CLI_DISABLE_AUTO_UPDATE=true agy --dangerously-skip-permissions');
			await service.executeRuntimeInitScript('s1', '/work/proj');
			const cmd = (send.mock.calls[0] as unknown as [string, string[]])[1][0];
			expect(cmd.match(/AGY_CLI_DISABLE_AUTO_UPDATE/g)).toHaveLength(1);
		});

		it('refuses to launch without a Gemini API key (never falls back to an account login)', async () => {
			resolveApiKey.mockResolvedValue(null);
			const send = captureLaunch();
			const error = await service.executeRuntimeInitScript('s1', '/work/proj').catch((e: unknown) => e);
			expect(error).toBeInstanceOf(RuntimeStartupBlockedError);
			expect(error).toMatchObject({ reason: 'api_key_required', message: ANTIGRAVITY_CONSTANTS.MESSAGES.NO_API_KEY });
			expect(ensureProvider).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		});

		it.each([
			['unparseable', ANTIGRAVITY_CONSTANTS.MESSAGES.SETTINGS_UNREADABLE],
			['error', ANTIGRAVITY_CONSTANTS.MESSAGES.SETTINGS_WRITE_FAILED],
		])('refuses to launch when agy settings are %s (the provider could not be forced)', async (result, message) => {
			ensureProvider.mockResolvedValue(result);
			const send = captureLaunch();
			await expect(service.executeRuntimeInitScript('s1', '/work/proj')).rejects.toMatchObject({ reason: 'settings_unreadable', message });
			expect(send).not.toHaveBeenCalled();
		});

		it('launches when the settings were already right', async () => {
			ensureProvider.mockResolvedValue('unchanged');
			const send = captureLaunch();
			await service.executeRuntimeInitScript('s1');
			expect(ensureProvider).toHaveBeenCalledWith(['/test/project', '/home/me/.crewly', '/tmp']);
			expect(send).toHaveBeenCalled();
		});
	});

	describe('waitForRuntimeReady', () => {
		it('is ready at the idle prompt', async () => {
			mockSessionHelper.capturePane.mockReturnValue(IDLE_FRESH);
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).resolves.toBe(true);
		});

		it('is ready for a resumed conversation that is already working', async () => {
			mockSessionHelper.capturePane.mockReturnValue(BUSY);
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).resolves.toBe(true);
		});

		it('accepts the folder-trust screen with Enter (pre-selected "Yes"), then continues', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(TRUST_SCREEN).mockReturnValue(IDLE_FRESH);
			await expect(service.waitForRuntimeReady('s1', 5000, 1)).resolves.toBe(true);
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(1);
		});

		it.each([
			['first-run colour scheme', FIRST_RUN_COLOR, 'first_run_setup'],
			['first-run terms and data use', FIRST_RUN_TERMS, 'first_run_setup'],
			['missing key refusal', MISSING_KEY, 'api_key_required'],
		])('fails fast on the %s screen without answering it', async (_name, screen, reason) => {
			mockSessionHelper.capturePane.mockReturnValue(screen);
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).rejects.toMatchObject({ reason });
			// Crewly never accepts Google's terms or data-use consent for the user.
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();
		});

		it('refuses an account sign-in screen and leaves agy', async () => {
			mockSessionHelper.capturePane.mockReturnValue(ACCOUNT_LOGIN);
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).rejects.toMatchObject({ reason: 'account_login_refused' });
			expect(mockSessionHelper.sendCtrlC).toHaveBeenCalledTimes(2);
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
		});

		it('refuses a session that came up on an account instead of the Gemini API key', async () => {
			mockSessionHelper.capturePane.mockReturnValue(ACCOUNT_SESSION);
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).rejects.toMatchObject({ reason: 'account_login_refused' });
			expect(mockSessionHelper.sendCtrlC).toHaveBeenCalledTimes(2);
		});

		it('fails fast when agy is not installed', async () => {
			mockSessionHelper.capturePane.mockReturnValue('zsh: command not found: agy');
			await expect(service.waitForRuntimeReady('s1', 1000, 1)).resolves.toBe(false);
		});

		it('times out on a screen it does not recognise', async () => {
			mockSessionHelper.capturePane.mockReturnValue('me@host project % ');
			await expect(service.waitForRuntimeReady('s1', 20, 5)).resolves.toBe(false);
		});
	});

	describe('isReadyForInput', () => {
		it('is ready at an empty prompt (fresh, after a turn, default mode)', () => {
			expect(service.isReadyForInput(IDLE_FRESH)).toBe(true);
			expect(service.isReadyForInput(AFTER_TURN_ERROR)).toBe(true);
			expect(service.isReadyForInput(IDLE_DEFAULT_MODE)).toBe(true);
		});

		it('is not ready while busy, while text is typed, or with an exit armed', () => {
			expect(service.isReadyForInput(BUSY)).toBe(false);
			expect(service.isReadyForInput(TYPED)).toBe(false);
			expect(service.isReadyForInput(CTRL_C_ARMED)).toBe(false);
		});

		it('is not ready on the trust, first-run or exit screens', () => {
			expect(service.isReadyForInput(TRUST_SCREEN)).toBe(false);
			expect(service.isReadyForInput(FIRST_RUN_COLOR)).toBe(false);
			expect(service.isReadyForInput(EXITED)).toBe(false);
		});
	});

	describe('detectRuntimeSpecific (passive, no key probes)', () => {
		it('detects agy idle or busy', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(IDLE_FRESH).mockReturnValueOnce(BUSY);
			expect(await service['detectRuntimeSpecific']('s1')).toBe(true);
			expect(await service['detectRuntimeSpecific']('s1')).toBe(true);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledWith('s1', 120);
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendCtrlC).not.toHaveBeenCalled();
		});

		it('does not detect agy after it exited or from the launch command echo', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(EXITED).mockReturnValueOnce('me@host % AGY_CLI_DISABLE_AUTO_UPDATE=true agy --dangerously-skip-permissions');
			expect(await service['detectRuntimeSpecific']('s1')).toBe(false);
			expect(await service['detectRuntimeSpecific']('s1')).toBe(false);
		});
	});

	describe('patterns', () => {
		it('never uses the bare binary name as a ready pattern (it is echoed by the shell)', () => {
			expect(service['getRuntimeReadyPatterns']().map((p: string) => p.toLowerCase())).not.toContain('agy');
		});

		it('exit patterns match agy\'s exit hint and its missing-key refusal (raw, unwrapped stream)', () => {
			const exits = service.getExitPatterns();
			const matches = (text: string): boolean => exits.some((re) => re.test(text));
			expect(matches('Resume with -c (or command below):\nagy --conversation=abc')).toBe(true);
			expect(matches('modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set.')).toBe(true);
			expect(matches('zsh: command not found: agy')).toBe(true);
			expect(matches('⣯  Generating...')).toBe(false);
			expect(matches('? for shortcuts')).toBe(false);
		});
	});

	describe('postInitialize', () => {
		it('adds the extra project folders with /add-dir (raw path, no quotes — agy keeps quotes literally)', async () => {
			mockSessionHelper.capturePane.mockReturnValue(IDLE_FRESH);
			await service.postInitialize('crewly-orc', '/work/proj', ['/work/other', '/work/My Project', '/work/proj', '/home/me/.crewly', '/work/other']);
			expect(mockSessionHelper.sendMessage.mock.calls.map((c) => c[1])).toEqual(['/add-dir /work/other', '/add-dir /work/My Project']);
		});

		it('does nothing when there is nothing to add', async () => {
			await service.postInitialize('s1', '/work/proj', []);
			await service.postInitialize('s1', '/work/proj');
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('skips paths that would break the command line', async () => {
			mockSessionHelper.capturePane.mockReturnValue(IDLE_FRESH);
			await service.postInitialize('s1', '/work/proj', ['/work/a\n/add-dir /etc']);
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});
	});

	describe('addWorkspaceDir', () => {
		it('sends /add-dir only while agy is idle', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(IDLE_FRESH).mockReturnValueOnce(BUSY);
			await expect(service.addWorkspaceDir('crewly-orc', '/work/new')).resolves.toBe(true);
			await expect(service.addWorkspaceDir('crewly-orc', '/work/other')).resolves.toBe(false);
			expect(mockSessionHelper.sendMessage.mock.calls.map((c) => c[1])).toEqual(['/add-dir /work/new']);
		});

		it('refuses unusable paths and survives a dead session', async () => {
			await expect(service.addWorkspaceDir('crewly-orc', '')).resolves.toBe(false);
			await expect(service.addWorkspaceDir('crewly-orc', '/a\n/b')).resolves.toBe(false);
			mockSessionHelper.capturePane.mockImplementationOnce(() => {
				throw new Error('gone');
			});
			await expect(service.addWorkspaceDir('crewly-orc', '/work/new')).resolves.toBe(false);
		});
	});
});
