import * as path from 'path';
import { promises as fs, existsSync } from 'fs';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES } from '../../constants.js';
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

	describe('isClaudeTrustPrompt (#267)', () => {
		it('should detect v2.1.81 trust dialog text', () => {
			const dialogOutput = `Accessing workspace: /usr/local/lib/node_modules/crewly

Quick safety check: Is this a project you created or one you trust?
Claude Code'll be able to read, edit, and execute files here.

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel`;

			expect(service['isClaudeTrustPrompt'](dialogOutput)).toBe(true);
		});

		it('should detect "Quick safety check" text', () => {
			expect(service['isClaudeTrustPrompt']('Quick safety check')).toBe(true);
		});

		it('should detect "Yes, I trust this folder" text', () => {
			expect(service['isClaudeTrustPrompt']('Yes, I trust this folder')).toBe(true);
		});

		it('should detect "Enter to confirm" text', () => {
			expect(service['isClaudeTrustPrompt']('Enter to confirm · Esc to cancel')).toBe(true);
		});

		it('should detect legacy "Do you trust the files" text', () => {
			expect(service['isClaudeTrustPrompt']('Do you trust the files in this folder?')).toBe(true);
		});

		it('should detect legacy "Is this a project you trust" text', () => {
			expect(service['isClaudeTrustPrompt']('Is this a project you trust?')).toBe(true);
		});

		it('should not match normal output', () => {
			expect(service['isClaudeTrustPrompt']('Welcome to Claude Code!')).toBe(false);
			expect(service['isClaudeTrustPrompt']('Ready to assist')).toBe(false);
			expect(service['isClaudeTrustPrompt']('')).toBe(false);
		});

		it('should detect space-stripped PTY output (ESTestNode #267)', () => {
			// PTY output strips spaces between words
			const strippedOutput = 'Yes,Itrustthisfolder';
			expect(service['isClaudeTrustPrompt'](strippedOutput)).toBe(true);
		});

		it('should detect full space-stripped trust dialog from PTY', () => {
			const strippedDialog = [
				'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
				'ClaudeCode\'llbeabletoread,edit,andexecutefileshere.',
				'❯1.Yes,Itrustthisfolder',
				'2.No,exit',
				'Entertoconfirm·Esctocancel',
			].join('\r\r\n');
			expect(service['isClaudeTrustPrompt'](strippedDialog)).toBe(true);
		});

		it('should detect mixed case space-stripped output', () => {
			expect(service['isClaudeTrustPrompt']('QUICKSAFETYCHECK')).toBe(true);
			expect(service['isClaudeTrustPrompt']('entertoconfirm')).toBe(true);
		});

		it('should not false-positive on space-stripped normal output', () => {
			expect(service['isClaudeTrustPrompt']('WelcometoClaudeCode!')).toBe(false);
			expect(service['isClaudeTrustPrompt']('Readytoassist')).toBe(false);
		});
	});

	describe('waitForRuntimeReady trust prompt auto-accept (#267)', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should auto-accept trust prompt and then detect ready', async () => {
			// First call: return trust dialog, second call: return ready signal
			mockSessionHelper.capturePane
				.mockReturnValueOnce('Quick safety check: Is this a project you created or one you trust?')
				.mockReturnValueOnce('✻ Welcome to Claude');

			const promise = service.waitForRuntimeReady('test-session', 30000, 100);

			// Advance through the trust prompt delay (1000ms) + check interval
			await jest.advanceTimersByTimeAsync(1100);
			await jest.advanceTimersByTimeAsync(200);

			const result = await promise;

			expect(result).toBe(true);
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('test-session');
		});

		it('should fail after max trust prompt attempts', async () => {
			// Always return trust dialog
			mockSessionHelper.capturePane.mockReturnValue(
				'Quick safety check: Is this a project you created or one you trust?'
			);

			const promise = service.waitForRuntimeReady('test-session', 60000, 100);

			// Advance enough time for 6 trust attempts (max is 5)
			for (let i = 0; i < 7; i++) {
				await jest.advanceTimersByTimeAsync(1200);
			}

			const result = await promise;

			expect(result).toBe(false);
			// Should have tried sendEnter exactly MAX_TRUST_ATTEMPTS (5) times
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(5);
		});
	});

});
