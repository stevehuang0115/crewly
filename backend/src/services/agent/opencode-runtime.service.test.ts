import { OpenCodeRuntimeService } from './opencode-runtime.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, RUNTIME_INPUT_READY_PATTERNS } from '../../constants.js';

/**
 * Screen fixtures modelled on the OpenCode 1.x TUI (opentui renderer):
 * block-glyph logo, a left-bordered input box whose empty state shows the
 * `Ask anything…` placeholder, an agent/model meta line under the box, and a
 * footer with `tab agents` / `ctrl+p commands` (idle) or a Knight-Rider
 * spinner plus `esc interrupt` (busy).
 */
const OPENCODE_IDLE_HOME_SCREEN = [
	'',
	'                   ▄',
	'█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█',
	'█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀',
	'▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
	'',
	'┃',
	'┃  Ask anything… "Fix a TODO in the codebase"',
	'┃',
	'┃  Build auto · claude-sonnet-4 Anthropic',
	'╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
	'  ~/projects/demo                                tab agents  ctrl+p commands',
	'',
	'~/projects/demo                                          • 0 LSP  /status',
].join('\n');

const OPENCODE_IDLE_SESSION_SCREEN = [
	'  Read the file at /root/.crewly/prompts/crewly-orc-init.md and follow all instructions in it.',
	'',
	'  I have read the instructions and registered as the orchestrator. Ready for tasks.',
	'',
	'┃',
	'┃  Ask anything… "Fix broken tests"',
	'┃',
	'┃  Build auto · claude-sonnet-4 Anthropic',
	'╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
	'  ~/projects/demo                 12.4K · $0.03   tab agents  ctrl+p commands',
].join('\n');

const OPENCODE_BUSY_SCREEN = [
	'  Read the file at /root/.crewly/prompts/crewly-orc-init.md and follow all instructions in it.',
	'',
	'  ▸ Read /root/.crewly/prompts/crewly-orc-init.md',
	'',
	'┃',
	'┃  Ask anything… "What is the tech stack of this project?"',
	'┃',
	'┃  Build auto · claude-sonnet-4 Anthropic',
	'╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
	'  ■■⬝⬝⬝⬝ esc interrupt                           tab agents  ctrl+p commands',
].join('\n');

const OPENCODE_BUSY_ANIMATIONS_OFF_SCREEN = OPENCODE_BUSY_SCREEN.replace('■■⬝⬝⬝⬝ esc interrupt', '[⋯] esc again to interrupt');

const OPENCODE_RETRY_SCREEN = [
	'┃',
	'┃  Ask anything… "Fix broken tests"',
	'┃',
	'┃  Build auto · claude-sonnet-4 Anthropic',
	'╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
	'  ■■⬝⬝⬝⬝ Overloaded [retrying in 4s attempt #2]                   esc interrupt',
].join('\n');

const OPENCODE_CONNECT_PROVIDER_SCREEN = [
	'┃',
	'┃  Ask anything… "Fix a TODO in the codebase"',
	'┃',
	'╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
	'',
	'  ┌──────────────────────────────────────────────────┐',
	'  │ Connect a provider                                │',
	'  │                                                  │',
	'  │  Popular                                         │',
	'  │  › OpenCode Zen        Curated models            │',
	'  │    Anthropic                                     │',
	'  │    OpenAI                                        │',
	'  │    Google                                        │',
	'  │                                                  │',
	'  │  Providers                                       │',
	'  │    Other               Custom provider           │',
	'  └──────────────────────────────────────────────────┘',
].join('\n');

const OPENCODE_NO_PROVIDER_FOOTER_SCREEN = OPENCODE_IDLE_HOME_SCREEN.replace(
	'~/projects/demo                                          • 0 LSP  /status',
	'~/projects/demo                                     Get started /connect',
);

const OPENCODE_UNKNOWN_ARG_SCREEN = [
	'user@host:~/projects/demo$ OPENCODE_DISABLE_AUTOUPDATE=1 opencode --auto',
	'Unknown argument: auto',
	'user@host:~/projects/demo$ ',
].join('\n');

describe('OpenCodeRuntimeService', () => {
	let service: OpenCodeRuntimeService;
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

		service = new OpenCodeRuntimeService(mockSessionHelper, '/test/project');
	});

	describe('getRuntimeType', () => {
		it('should return OPENCODE_CLI runtime type', () => {
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.OPENCODE_CLI);
		});
	});

	describe('detectRuntimeSpecific', () => {
		it('should detect OpenCode from the idle home screen without any key probes', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(OPENCODE_IDLE_HOME_SCREEN);

			const result = await service['detectRuntimeSpecific']('test-session');

			expect(result).toBe(true);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledWith('test-session', 120);
			expect(mockSessionHelper.clearCurrentCommandLine).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendCtrlC).not.toHaveBeenCalled();
		});

		it('should detect OpenCode while it is busy (TUI is up, just working)', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(OPENCODE_BUSY_SCREEN);

			expect(await service['detectRuntimeSpecific']('test-session')).toBe(true);
		});

		it('should detect a launched-but-unauthenticated OpenCode (provider dialog)', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce(OPENCODE_CONNECT_PROVIDER_SCREEN);

			expect(await service['detectRuntimeSpecific']('test-session')).toBe(true);
		});

		it('should not detect OpenCode on a bare shell prompt', async () => {
			mockSessionHelper.capturePane.mockReturnValueOnce('testuser@macbookpro crewly %');

			expect(await service['detectRuntimeSpecific']('test-session')).toBe(false);
		});

		it('should not detect OpenCode from the launch command echo alone', async () => {
			// The literal `opencode` is in the scrollback before the TUI paints anything.
			mockSessionHelper.capturePane.mockReturnValueOnce('user@host:~$ OPENCODE_DISABLE_AUTOUPDATE=1 opencode --auto\n');

			expect(await service['detectRuntimeSpecific']('test-session')).toBe(false);
		});
	});

	describe('getRuntimeReadyPatterns', () => {
		it('should return OpenCode-specific ready patterns', () => {
			const patterns = service['getRuntimeReadyPatterns']();

			expect(patterns).toContain('Ask anything');
			expect(patterns).toContain('tab agents');
			expect(patterns).toContain('ctrl+p commands');
			expect(patterns).toContain('Connect a provider');
		});

		it('should not use the bare binary name (it is echoed by the shell before boot)', () => {
			const patterns = service['getRuntimeReadyPatterns']();
			expect(patterns.map((p) => p.toLowerCase())).not.toContain('opencode');
		});
	});

	describe('getRuntimeErrorPatterns', () => {
		it('should return OpenCode-specific error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();

			expect(patterns).toContain('command not found: opencode');
			expect(patterns).toContain('opencode: command not found');
			expect(patterns).toContain('Unknown argument');
			expect(patterns).toContain('Invalid API key');
			expect(patterns).toContain('Rate limit exceeded');
		});
	});

	describe('getRuntimeExitPatterns', () => {
		it('should return OpenCode-specific exit patterns', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns).toHaveLength(3);
			expect(patterns[0].test('opencode exited')).toBe(true);
			expect(patterns[0].test('OpenCode TUI exited with code 0')).toBe(true);
			expect(patterns[1].test('Session ended')).toBe(true);
			expect(patterns[2].test('Unknown argument: auto')).toBe(true);
			expect(patterns[2].test('Unknown arguments: auto, foo')).toBe(true);
		});

		it('should match the yargs error an older opencode prints for --auto', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns.some((p) => p.test(OPENCODE_UNKNOWN_ARG_SCREEN))).toBe(true);
		});

		it('should not match idle or busy screens', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns.some((p) => p.test(OPENCODE_IDLE_HOME_SCREEN))).toBe(false);
			expect(patterns.some((p) => p.test(OPENCODE_BUSY_SCREEN))).toBe(false);
		});
	});

	describe('getExitPatterns', () => {
		it('should expose exit patterns via public accessor (used by RuntimeExitMonitorService)', () => {
			expect(service.getExitPatterns()).toHaveLength(3);
		});
	});

	describe('getNotReadyMarkers', () => {
		it('should use the shared OPENCODE_CLI marker list from constants', () => {
			expect(service['getNotReadyMarkers']()).toBe(RUNTIME_INPUT_READY_PATTERNS.OPENCODE_CLI.NOT_READY_MARKERS);
		});
	});

	describe('waitForRuntimeReady', () => {
		it('resolves true as soon as the idle screen is captured', async () => {
			mockSessionHelper.capturePane.mockReturnValue(OPENCODE_IDLE_HOME_SCREEN);

			await expect(service.waitForRuntimeReady('test-session', 5000, 10)).resolves.toBe(true);
		});

		it('fails fast on the Unknown argument error instead of waiting out the timeout', async () => {
			mockSessionHelper.capturePane.mockReturnValue(OPENCODE_UNKNOWN_ARG_SCREEN);

			const started = Date.now();
			await expect(service.waitForRuntimeReady('test-session', 5000, 10)).resolves.toBe(false);
			expect(Date.now() - started).toBeLessThan(2000);
		});
	});

	describe('checkOpenCodeInstallation', () => {
		it('should report OpenCode CLI as available', async () => {
			const result = await service.checkOpenCodeInstallation();
			expect(result.isInstalled).toBe(true);
			expect(result.message).toBe('OpenCode CLI is available');
		});
	});

	describe('initializeOpenCodeInSession', () => {
		it('should call executeRuntimeInitScript', async () => {
			const spy = jest.spyOn(service, 'executeRuntimeInitScript').mockResolvedValue(undefined);

			const result = await service.initializeOpenCodeInSession('test-session');

			expect(result.success).toBe(true);
			expect(spy).toHaveBeenCalledWith('test-session');
		});

		it('should handle initialization errors gracefully', async () => {
			jest.spyOn(service, 'executeRuntimeInitScript').mockRejectedValue(new Error('Init failed'));

			const result = await service.initializeOpenCodeInSession('test-session');

			expect(result.success).toBe(false);
			expect(result.message).toBe('Init failed');
		});
	});

	describe('isReadyForInput', () => {
		it('is ready on the fresh home screen (placeholder + idle footer)', () => {
			expect(service.isReadyForInput(OPENCODE_IDLE_HOME_SCREEN)).toBe(true);
		});

		it('is ready on an idle session screen after a turn completed', () => {
			expect(service.isReadyForInput(OPENCODE_IDLE_SESSION_SCREEN)).toBe(true);
		});

		it('is NOT ready while the model is running (placeholder still painted, esc interrupt shown)', () => {
			expect(service.isReadyForInput(OPENCODE_BUSY_SCREEN)).toBe(false);
		});

		it('is NOT ready with animations off ([⋯] + esc again to interrupt)', () => {
			expect(service.isReadyForInput(OPENCODE_BUSY_ANIMATIONS_OFF_SCREEN)).toBe(false);
		});

		it('is NOT ready while a provider call is being retried', () => {
			expect(service.isReadyForInput(OPENCODE_RETRY_SCREEN)).toBe(false);
		});

		it('is NOT ready while the Connect a provider dialog is open', () => {
			expect(service.isReadyForInput(OPENCODE_CONNECT_PROVIDER_SCREEN)).toBe(false);
		});

		it('is NOT ready when no provider is configured (Get started /connect footer)', () => {
			expect(service.isReadyForInput(OPENCODE_NO_PROVIDER_FOOTER_SCREEN)).toBe(false);
		});

		it('is NOT ready on a bare shell prompt (runtime not launched yet)', () => {
			expect(service.isReadyForInput('root@server:~# ')).toBe(false);
		});

		it('is NOT ready after the binary rejected --auto and dropped back to the shell', () => {
			expect(service.isReadyForInput(OPENCODE_UNKNOWN_ARG_SCREEN)).toBe(false);
		});

		it('is NOT ready on an empty capture', () => {
			expect(service.isReadyForInput('')).toBe(false);
		});

		it('tolerates ANSI escape codes in the capture', () => {
			const withAnsi = OPENCODE_IDLE_HOME_SCREEN.replace(
				'┃  Ask anything…',
				'[38;2;120;120;120m┃[0m  [2mAsk anything…[0m',
			);
			expect(service.isReadyForInput(withAnsi)).toBe(true);
		});

		it('matches esc interrupt regardless of column alignment whitespace', () => {
			const spaced = OPENCODE_BUSY_SCREEN.replace('esc interrupt', 'esc \t   interrupt');
			expect(service.isReadyForInput(spaced)).toBe(false);
		});
	});
});
