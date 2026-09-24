import * as path from 'path';
import { promises as fs, existsSync } from 'fs';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, CLAUDE_STARTUP_CONSTANTS } from '../../constants.js';
import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { getSettingsService } from '../settings/settings.service.js';
import { safeReadJson, atomicWriteJson } from '../../utils/file-io.utils.js';
import { getDefaultSettings } from '../../types/settings.types.js';

jest.mock('fs', () => ({
	...jest.requireActual('fs'),
	existsSync: jest.fn().mockReturnValue(false),
	promises: {
		...jest.requireActual('fs').promises,
		mkdir: jest.fn().mockResolvedValue(undefined),
	},
}));

jest.mock('../../utils/file-io.utils.js', () => ({
	safeReadJson: jest.fn().mockResolvedValue({}),
	atomicWriteJson: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../settings/settings.service.js', () => ({
	getSettingsService: jest.fn().mockReturnValue({
		getSettings: jest.fn().mockResolvedValue({
			...require('../../types/settings.types.js').getDefaultSettings(),
		}),
	}),
}));

describe('ClaudeRuntimeService', () => {
	let service: ClaudeRuntimeService;
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;

	beforeEach(() => {
		mockSessionHelper = {
			capturePane: jest.fn().mockReturnValue(''),
			sendKey: jest.fn().mockResolvedValue(undefined),
			sendCtrlC: jest.fn().mockResolvedValue(undefined),
			sendEscape: jest.fn().mockResolvedValue(undefined),
			sendEnter: jest.fn().mockResolvedValue(undefined),
			sendMessage: jest.fn().mockResolvedValue(undefined),
			clearCurrentCommandLine: jest.fn().mockResolvedValue(undefined),
			sessionExists: jest.fn().mockReturnValue(true),
			createSession: jest.fn().mockResolvedValue({}),
			killSession: jest.fn().mockResolvedValue(undefined),
			setEnvironmentVariable: jest.fn().mockResolvedValue(undefined),
			writeRaw: jest.fn(),
			getSession: jest.fn(),
			getRawHistory: jest.fn(),
			getTerminalBuffer: jest.fn(),
			backend: {},
		} as any;

		service = new ClaudeRuntimeService(mockSessionHelper, '/test/project');
	});

	describe('getRuntimeType', () => {
		it('should return CLAUDE_CODE runtime type', () => {
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.CLAUDE_CODE);
		});
	});

	// detectRuntimeSpecific tests skipped — they use internal setTimeouts that
	// conflict with jest fake timers and are not affected by session ID changes.

	describe('getRuntimeReadyPatterns', () => {
		it('should return Claude-specific ready patterns', () => {
			const patterns = service['getRuntimeReadyPatterns']();

			expect(patterns).toContain('Welcome to Claude Code!');
			expect(patterns).toContain('claude-code>');
			expect(patterns).toContain('✻ Welcome to Claude');
		});
	});

	describe('getRuntimeErrorPatterns', () => {
		it('should return Claude-specific error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();

			expect(patterns).toContain('command not found: claude');
			expect(patterns).toContain('Permission denied');
		});
	});

	describe('getRuntimeExitPatterns', () => {
		it('should return Claude-specific exit patterns including fatal patterns', () => {
			const patterns = service['getRuntimeExitPatterns']();
			// 2 clean exit patterns + CLAUDE_FATAL_PATTERNS
			expect(patterns.length).toBeGreaterThanOrEqual(4);
			expect(patterns[0].test('Claude Code exited')).toBe(true);
			expect(patterns[0].test('Claude exited')).toBe(true);
			expect(patterns[1].test('Session ended')).toBe(true);
			// Fatal patterns included
			expect(patterns.some(p => p.test('thinking blocks cannot be modified'))).toBe(true);
			expect(patterns.some(p => p.test('redacted_thinking blocks cannot be modified'))).toBe(true);
		});

		it('should not match unrelated text', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns.some(p => p.test('Welcome to Claude Code!'))).toBe(false);
		});
	});

	describe('getExitPatterns', () => {
		it('should expose exit patterns via public accessor', () => {
			const patterns = service.getExitPatterns();
			expect(patterns.length).toBeGreaterThanOrEqual(4);
		});
	});

	describe('checkClaudeInstallation', () => {
		it('should check Claude installation', async () => {
			// This test uses real spawn — just verify the function returns a valid result
			const result = await service.checkClaudeInstallation();
			expect(result).toHaveProperty('installed');
			expect(result).toHaveProperty('message');
		});
	});

	describe('initializeClaudeInSession', () => {
		it('should initialize Claude successfully', async () => {
			jest.spyOn(service as any, 'waitForRuntimeReady').mockResolvedValue(true);

			const result = await service.initializeClaudeInSession('test-session');

			expect(result.success).toBe(true);
			expect(result.message).toBe('Claude Code initialized and ready');
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('test-session');
		});

		it('should handle initialization timeout', async () => {
			jest.spyOn(service as any, 'waitForRuntimeReady').mockResolvedValue(false);

			const result = await service.initializeClaudeInSession('test-session');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Claude Code failed to initialize within timeout');
		});
	});

	describe('detectClaudeWithSlashCommand', () => {
		it('should delegate to base detectRuntimeWithCommand', async () => {
			const spy = jest.spyOn(service as any, 'detectRuntimeWithCommand').mockResolvedValue(true);

			const result = await service.detectClaudeWithSlashCommand('test-session');

			expect(result).toBe(true);
			expect(spy).toHaveBeenCalledWith('test-session', false);
		});
	});

	describe('ensureClaudeMcpConfig', () => {
		const mockSafeReadJson = safeReadJson as jest.MockedFunction<typeof safeReadJson>;
		const mockAtomicWriteJson = atomicWriteJson as jest.MockedFunction<typeof atomicWriteJson>;
		const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
		const mockGetSettingsService = getSettingsService as jest.MockedFunction<typeof getSettingsService>;
		const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

		beforeEach(() => {
			jest.clearAllMocks();
			mockSafeReadJson.mockResolvedValue({});
			mockAtomicWriteJson.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);
			mockExistsSync.mockReturnValue(false); // Default: no pro addon installed
			mockGetSettingsService.mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(getDefaultSettings()),
			} as any);
		});

		it('should create .mcp.json with playwright when it does not exist', async () => {
			mockSafeReadJson.mockResolvedValue({});

			const result = await service.ensureClaudeMcpConfig('/test/project');

			expect(result.success).toBe(true);
			expect(result.addedServers).toBe(1);
			expect(result.serverNames).toContain('playwright');
			expect(mockMkdir).toHaveBeenCalledWith(
				'/test/project',
				{ recursive: true }
			);
			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.mcp.json'),
				{
					mcpServers: {
							playwright: {
								command: 'npx',
								args: [
									'@playwright/mcp@latest',
									'--headless',
									'--human-delay-min',
									'300',
									'--human-delay-max',
									'1200',
								],
							},
						},
					}
				);
		});

		it('should preserve existing user MCP servers', async () => {
			mockSafeReadJson.mockResolvedValue({
				mcpServers: {
					'my-custom-server': { command: 'node', args: ['server.js'] },
				},
				otherSetting: 'preserved',
			});

			await service.ensureClaudeMcpConfig('/test/project');

			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.mcp.json'),
				{
					mcpServers: {
						'my-custom-server': { command: 'node', args: ['server.js'] },
							playwright: {
								command: 'npx',
								args: [
									'@playwright/mcp@latest',
									'--headless',
									'--human-delay-min',
									'300',
									'--human-delay-max',
									'1200',
								],
							},
						},
						otherSetting: 'preserved',
				}
			);
		});

		it('should not overwrite existing playwright config', async () => {
			const userPlaywright = { command: 'playwright', args: ['--custom'] };
			mockSafeReadJson.mockResolvedValue({
				mcpServers: {
					playwright: userPlaywright,
				},
			});

			await service.ensureClaudeMcpConfig('/test/project');

			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.mcp.json'),
				{
					mcpServers: {
						playwright: userPlaywright,
					},
				}
			);
		});

		it('should skip playwright when enableBrowserAutomation is false', async () => {
			const disabledSettings = getDefaultSettings();
			disabledSettings.skills.enableBrowserAutomation = false;
			mockGetSettingsService.mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(disabledSettings),
			} as any);

			const result = await service.ensureClaudeMcpConfig('/test/project');

			expect(result.success).toBe(true);
			expect(result.totalServers).toBe(0);
			expect(result.serverNames).toEqual([]);
			expect(mockAtomicWriteJson).not.toHaveBeenCalled();
		});

		it('should default to enabled when settings service is unavailable', async () => {
			mockGetSettingsService.mockReturnValue({
				getSettings: jest.fn().mockRejectedValue(new Error('Settings unavailable')),
			} as any);

			await service.ensureClaudeMcpConfig('/test/project');

			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					mcpServers: expect.objectContaining({
						playwright: expect.any(Object),
					}),
				})
			);
		});

		it('should return error result when filesystem operations fail', async () => {
			mockAtomicWriteJson.mockRejectedValue(new Error('Permission denied'));

			const result = await service.ensureClaudeMcpConfig('/test/project');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Permission denied');
		});

		it('should skip playwright injection when crewly-pro addon is installed', async () => {
			mockExistsSync.mockReturnValue(true);
			mockSafeReadJson.mockResolvedValue({});

			const result = await service.ensureClaudeMcpConfig('/test/project');

			expect(result.success).toBe(true);
			expect(result.totalServers).toBe(0);
			expect(result.serverNames).toEqual([]);
			expect(mockAtomicWriteJson).not.toHaveBeenCalled();
		});

		it('should inject playwright when crewly-pro addon is NOT installed', async () => {
			mockExistsSync.mockReturnValue(false);
			mockSafeReadJson.mockResolvedValue({});

			const result = await service.ensureClaudeMcpConfig('/test/project');

			expect(result.success).toBe(true);
			expect(result.addedServers).toBe(1);
			expect(result.serverNames).toContain('playwright');
		});
	});

	describe('postInitialize', () => {
		it('should call ensureClaudeMcpConfig with project root when no target path given', async () => {
			const spy = jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 1, totalServers: 1, serverNames: ['playwright'],
			});

			await service.postInitialize('test-session');

			expect(spy).toHaveBeenCalledWith('/test/project', undefined);
		});

		it('should call ensureClaudeMcpConfig with target project path when provided', async () => {
			const spy = jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 1, totalServers: 1, serverNames: ['playwright'],
			});

			await service.postInitialize('test-session', '/target/project');

			expect(spy).toHaveBeenCalledWith('/target/project', undefined);
		});

		it('should run health check verification after successful config', async () => {
			const configSpy = jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 1, totalServers: 1, serverNames: ['playwright'],
			});
			const verifySpy = jest.spyOn(service as any, 'verifyMcpConfig').mockResolvedValue(true);

			await service.postInitialize('test-session');

			expect(configSpy).toHaveBeenCalledWith('/test/project', undefined);
			expect(verifySpy).toHaveBeenCalledWith(
				path.join('/test/project', '.mcp.json'),
				['playwright']
			);
		});

		it('should pass browser automation override to ensureClaudeMcpConfig', async () => {
			const spy = jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 0, totalServers: 0, serverNames: [],
			});

			await service.postInitialize('test-session', '/test/project', undefined, false);

			expect(spy).toHaveBeenCalledWith('/test/project', false);
		});

		it('should log warning when health check fails', async () => {
			jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 1, totalServers: 1, serverNames: ['playwright'],
			});
			jest.spyOn(service as any, 'verifyMcpConfig').mockResolvedValue(false);

			// Should not throw even when verification fails
			await expect(service.postInitialize('test-session')).resolves.not.toThrow();
		});

		it('should skip health check when no servers configured', async () => {
			jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: true, addedServers: 0, totalServers: 0, serverNames: [],
			});
			const verifySpy = jest.spyOn(service as any, 'verifyMcpConfig');

			await service.postInitialize('test-session');

			expect(verifySpy).not.toHaveBeenCalled();
		});

		it('should log warning when config setup itself fails', async () => {
			jest.spyOn(service, 'ensureClaudeMcpConfig').mockResolvedValue({
				success: false, addedServers: 0, totalServers: 0, serverNames: [], error: 'Permission denied',
			});
			const verifySpy = jest.spyOn(service as any, 'verifyMcpConfig');

			await expect(service.postInitialize('test-session')).resolves.not.toThrow();
			expect(verifySpy).not.toHaveBeenCalled();
		});
	});

	describe('isReadyForInput', () => {
		const CLAUDE_IDLE_SCREEN = [
			'╭───────────────────────────────────────────────────────────╮',
			'│ ✻ Welcome to Claude Code!                                 │',
			'│                                                           │',
			'│   /help for help, /status for your current setup          │',
			'│                                                           │',
			'│   cwd: /home/crewly/projects/app                          │',
			'╰───────────────────────────────────────────────────────────╯',
			'',
			'╭───────────────────────────────────────────────────────────╮',
			'│ ❯                                                         │',
			'╰───────────────────────────────────────────────────────────╯',
			'  ⏵⏵ bypass permissions on (shift+tab to cycle)',
		].join('\n');

		const CLAUDE_BOOTING_SCREEN = [
			'╭───────────────────────────────────────────────────────────╮',
			'│ ✻ Welcome to Claude Code!                                 │',
			'│                                                           │',
			'│   cwd: /home/crewly/projects/app                          │',
			'╰───────────────────────────────────────────────────────────╯',
			'',
			'⠋ Loading MCP servers…',
		].join('\n');

		const CLAUDE_WORKING_SCREEN = [
			'❯ Begin your work now. Follow the step-by-step instructions…',
			'',
			'✶ Thinking… (esc to interrupt)',
		].join('\n');

		const CLAUDE_LOGIN_SCREEN = [
			'  Browser didn\'t open? Use the url below to sign in:',
			'',
			'  https://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code',
			'',
			'  Paste code here if prompted >',
		].join('\n');

		it('is ready at the idle ❯ prompt', () => {
			expect(service.isReadyForInput(CLAUDE_IDLE_SCREEN)).toBe(true);
		});

		it('is NOT ready while the banner is up but no prompt box has been painted', () => {
			expect(service.isReadyForInput(CLAUDE_BOOTING_SCREEN)).toBe(false);
		});

		it('is NOT ready while thinking / esc to interrupt is showing', () => {
			expect(service.isReadyForInput(CLAUDE_WORKING_SCREEN)).toBe(false);
		});

		it('is NOT ready on the sign-in screen', () => {
			expect(service.isReadyForInput(CLAUDE_LOGIN_SCREEN)).toBe(false);
		});

		it('is NOT ready on an empty capture', () => {
			expect(service.isReadyForInput('')).toBe(false);
		});
	});


	// ---------------------------------------------------------------------
	// Fresh-install fail-fast (Mia's pre-validation, Claude Code 2.1.197)
	// ---------------------------------------------------------------------

	describe('fresh install: fail fast instead of a 5-minute hang', () => {
		const SANDBOX = CLAUDE_STARTUP_CONSTANTS.SANDBOX_ENV;
		let savedSandbox: string | undefined;

		beforeEach(() => {
			savedSandbox = process.env[SANDBOX];
			delete process.env[SANDBOX];
		});

		afterEach(() => {
			if (savedSandbox !== undefined) process.env[SANDBOX] = savedSandbox;
			else delete process.env[SANDBOX];
			jest.restoreAllMocks();
		});

		it('as root: refuses to launch Claude with the actionable root error, before running the init script', async () => {
			jest.spyOn(process, 'getuid').mockReturnValue(0);
			const superInit = jest
				.spyOn(RuntimeAgentService.prototype, 'executeRuntimeInitScript')
				.mockResolvedValue(undefined);

			const err = await service.executeRuntimeInitScript('s1', '/proj').catch((e: unknown) => e);

			expect((err as { code?: string }).code).toBe('RUNTIME_STARTUP_BLOCKED');
			expect((err as { reason?: string }).reason).toBe('root_user');
			expect((err as Error).message).toBe(CLAUDE_STARTUP_CONSTANTS.MESSAGES.ROOT);
			expect((err as Error).message).toMatch(/cannot run as root.*normal \(non-root\) user/);
			expect(superInit).not.toHaveBeenCalled();
		});

		it('as root with IS_SANDBOX=1 (Claude allows the flag then): launches normally', async () => {
			jest.spyOn(process, 'getuid').mockReturnValue(0);
			process.env[SANDBOX] = '1';
			const superInit = jest
				.spyOn(RuntimeAgentService.prototype, 'executeRuntimeInitScript')
				.mockResolvedValue(undefined);

			await expect(service.executeRuntimeInitScript('s1', '/proj')).resolves.toBeUndefined();
			expect(superInit).toHaveBeenCalledTimes(1);
		});

		it('as a normal user: launches normally', async () => {
			jest.spyOn(process, 'getuid').mockReturnValue(501);
			const superInit = jest
				.spyOn(RuntimeAgentService.prototype, 'executeRuntimeInitScript')
				.mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('s1', '/proj');
			expect(superInit).toHaveBeenCalledTimes(1);
		});

		it('readiness: Claude refusing root in the terminal fails fast with the root error (not a timeout)', async () => {
			mockSessionHelper.capturePane.mockReturnValue(
				'$ claude --dangerously-skip-permissions\n--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n$ ',
			);
			const started = Date.now();

			const err = await service.waitForRuntimeReady('s1', 300000, 10).catch((e: unknown) => e);

			expect((err as { reason?: string }).reason).toBe('root_user');
			expect((err as Error).message).toBe(CLAUDE_STARTUP_CONSTANTS.MESSAGES.ROOT);
			expect(Date.now() - started).toBeLessThan(2000);
		});

		it('readiness: the first-run theme picker fails fast with "run claude once" (checked before ready patterns)', async () => {
			mockSessionHelper.capturePane.mockReturnValue(
				'✻ Welcome to Claude Code v2.1.197\n\nLet’s get started.\n\nChoose the text style that looks best with your terminal\n ❯ 1. Auto\n   2. Dark mode ✔\n   3. Light mode',
			);
			const started = Date.now();

			const err = await service.waitForRuntimeReady('s1', 300000, 10).catch((e: unknown) => e);

			expect((err as { reason?: string }).reason).toBe('first_run_setup');
			expect((err as Error).message).toBe(CLAUDE_STARTUP_CONSTANTS.MESSAGES.FIRST_RUN);
			expect((err as Error).message).toMatch(/Run `claude` once.*choose a theme and log in/);
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled(); // never auto-answers the picker
			expect(Date.now() - started).toBeLessThan(2000);
		});

		it('readiness: a set-up, logged-in Claude still reaches ready', async () => {
			mockSessionHelper.capturePane.mockReturnValue('✻ Welcome to Claude Code!\n\n/help for help, /status for your current setup\n\ncwd: /proj');

			await expect(service.waitForRuntimeReady('s1', 5000, 10)).resolves.toBe(true);
		});
	});
});
