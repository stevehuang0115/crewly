import * as os from 'os';
import * as path from 'path';
import * as fsModule from 'fs';
import { promises as fs } from 'fs';
import { GeminiRuntimeService } from './gemini-runtime.service.js';
import { SessionCommandHelper } from '../session/index.js';
import { CREWLY_CONSTANTS, RUNTIME_TYPES, GEMINI_FAILURE_PATTERNS } from '../../constants.js';
import { getSettingsService } from '../settings/settings.service.js';
import { safeReadJson, atomicWriteJson } from '../../utils/file-io.utils.js';
import { getDefaultSettings } from '../../types/settings.types.js';

jest.mock('fs', () => ({
	...jest.requireActual('fs'),
	existsSync: jest.fn(),
	readFileSync: jest.fn(),
	writeFileSync: jest.fn(),
	appendFileSync: jest.fn(),
	promises: {
		...jest.requireActual('fs').promises,
		mkdir: jest.fn().mockResolvedValue(undefined),
		readFile: jest.fn(),
		writeFile: jest.fn().mockResolvedValue(undefined),
		appendFile: jest.fn().mockResolvedValue(undefined),
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
		getApiKey: jest.fn().mockResolvedValue('test-api-key-123'),
	}),
}));

describe('GeminiRuntimeService', () => {
	let service: GeminiRuntimeService;
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;

	beforeEach(() => {
		jest.useFakeTimers();

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
			getSessionOrThrow: jest.fn(),
			backend: {},
		} as any;

		service = new GeminiRuntimeService(mockSessionHelper, '/test/project');
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	describe('getRuntimeType', () => {
		it('should return GEMINI_CLI runtime type', () => {
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.GEMINI_CLI);
		});
	});

	describe('detectRuntimeSpecific', () => {
		it('should detect Gemini when output length increases significantly after / key', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before output')
				.mockReturnValueOnce('before output with much more content added');

			const promise = service['detectRuntimeSpecific']('test-session');
			await jest.advanceTimersByTimeAsync(10000);
			const result = await promise;

			expect(result).toBe(true);
			// No clearCurrentCommandLine — Ctrl+C triggers /quit, Escape defocuses TUI
			expect(mockSessionHelper.clearCurrentCommandLine).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).toHaveBeenCalledWith('test-session', '/');
			// Cleanup uses Backspace (safe in TUI)
			expect(mockSessionHelper.sendKey).toHaveBeenCalledWith('test-session', 'Backspace');
		});

		it('should not detect Gemini when output length stays the same', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before output')
				.mockReturnValueOnce('before output');

			const promise = service['detectRuntimeSpecific']('test-session');
			await jest.advanceTimersByTimeAsync(10000);
			const result = await promise;

			expect(result).toBe(false);
		});

		it('should not detect Gemini when output increase is small (<=5 chars)', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before')
				.mockReturnValueOnce('before/');

			const promise = service['detectRuntimeSpecific']('test-session');
			await jest.advanceTimersByTimeAsync(10000);
			const result = await promise;

			expect(result).toBe(false);
		});

		it('should clean up with Backspace after detection (not clearCurrentCommandLine)', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before')
				.mockReturnValueOnce('before with more content added');

			const promise = service['detectRuntimeSpecific']('test-session');
			await jest.advanceTimersByTimeAsync(10000);
			await promise;

			// No clearCurrentCommandLine — Ctrl+C triggers /quit, Escape defocuses TUI
			expect(mockSessionHelper.clearCurrentCommandLine).not.toHaveBeenCalled();
			// Backspace cleans up the '/' character safely in the TUI
			expect(mockSessionHelper.sendKey).toHaveBeenCalledWith('test-session', 'Backspace');
		});
	});

	describe('getRuntimeReadyPatterns', () => {
		it('should return Gemini-specific ready patterns', () => {
			const patterns = service['getRuntimeReadyPatterns']();

			expect(patterns).toContain('gemini>');
			expect(patterns).toContain('Ready for input');
			expect(patterns).toContain('Type your message');
			expect(patterns).toContain('shell mode');
			expect(patterns).toContain('context left)');
		});
	});

	describe('waitForRuntimeReady', () => {
		it('should auto-confirm Gemini trust prompt and continue startup', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce(
					'Do you trust this folder?\n1. Trust folder (crewly)\n2. Trust parent folder\n3. Don\'t trust'
				)
				.mockReturnValue('Type your message');

			const promise = service.waitForRuntimeReady('test-session', 5000, 200);
			await jest.advanceTimersByTimeAsync(6000);
			const result = await promise;

			expect(result).toBe(true);
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('test-session');
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalledWith('test-session', '1');
		});
	});

	describe('getRuntimeErrorPatterns', () => {
		it('should return Gemini-specific error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();

			expect(patterns).toContain('command not found: gemini');
			expect(patterns).toContain('API key not found');
			expect(patterns).toContain('Authentication failed');
			expect(patterns).toContain('Invalid API key');
			expect(patterns).toContain('Rate limit exceeded');
		});

		it('should include common error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();

			expect(patterns).toContain('Permission denied');
			expect(patterns).toContain('No such file or directory');
		});
	});

	describe('postInitialize', () => {
		it('should add ~/.crewly and /tmp to Gemini CLI directory allowlist', async () => {
			const expectedCrewlyPath = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
			const expectedTmpPath = os.tmpdir();

			// Mock capturePane to return different values (simulating output change)
			// so addProjectToAllowlist succeeds on first attempt
			let captureCallCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				captureCallCount++;
				return captureCallCount % 2 === 1 ? 'before' : 'before\n✓ Directory added';
			});

			const promise = service.postInitialize('test-session');
			await jest.advanceTimersByTimeAsync(20000);
			await promise;

			// Should send a batched /directory add command that includes ~/.crewly and /tmp.
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith(
				'test-session',
				expect.stringContaining(`/directory add ${expectedCrewlyPath}`)
			);
			// The batched command should also include the temp directory
			const sentCommand = mockSessionHelper.sendMessage.mock.calls.find(
				(call: any[]) => typeof call[1] === 'string' && call[1].includes('/directory add')
			);
			expect(sentCommand).toBeDefined();
			expect(sentCommand![1]).toContain(expectedTmpPath);
		});

		it('should not throw when addProjectToAllowlist fails', async () => {
			mockSessionHelper.sendMessage.mockRejectedValue(new Error('Connection failed'));

			const promise = service.postInitialize('test-session');
			await jest.advanceTimersByTimeAsync(60000);

			// Should not throw — errors are handled gracefully
			await expect(promise).resolves.not.toThrow();
		});

		it('should wait for slash queue to drain before finishing postInitialize', async () => {
			const expectedPath = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);

			mockSessionHelper.capturePane
				// addProjectsToAllowlistBatch: before + after(success)
				.mockReturnValueOnce('before')
				.mockReturnValueOnce('✓ Added directory')
				// waitForSlashQueueToDrain: queue still busy, then ready
				.mockReturnValueOnce('Slash commands cannot be queued')
				.mockReturnValueOnce('Type your message');

			const promise = service.postInitialize('test-session');
			await jest.advanceTimersByTimeAsync(30000);
			await promise;

			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith(
				'test-session',
				expect.stringContaining(`/directory add ${expectedPath}`)
			);
			// 1 from batched command warm-up + 1 queue-drain nudge
			expect(mockSessionHelper.sendEnter.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('addProjectToAllowlist', () => {
		it('should successfully add a project when output changes on first attempt', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';

			// Mock capturePane: first call (before) returns one value,
			// second call (after) returns a different value (simulating confirmation)
			let captureCallCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				captureCallCount++;
				return captureCallCount % 2 === 1 ? 'before' : 'before\n✓ Added directory';
			});

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(10000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.message).toBe(`Project path ${projectPath} added to Gemini CLI allowlist`);

			// Should send Enter first (wake-up) then the command
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith(sessionName);
			// No Escape — defocuses Ink TUI input permanently
			expect(mockSessionHelper.sendEscape).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith(
				sessionName,
				`/directory add ${projectPath} `
			);
		});

		it('should retry when output does not change', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';

			// Mock capturePane: return same value for first 2 attempts (2 before + 2 after),
			// then different value on 3rd attempt (success)
			let captureCallCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				captureCallCount++;
				// Calls 1-4 (attempts 1-2 before/after): same value → retry
				// Calls 5 (attempt 3 before): 'before'
				// Call 6 (attempt 3 after): different value → success
				if (captureCallCount <= 4) return 'same output';
				if (captureCallCount === 5) return 'before';
				return 'before\n✓ Added directory';
			});

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(30000);
			const result = await promise;

			expect(result.success).toBe(true);
			// sendMessage called 3 times (3 attempts)
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(3);
		});

		it('should handle errors gracefully after all retries', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';

			mockSessionHelper.sendMessage.mockRejectedValue(new Error('Connection failed'));

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(60000);
			const result = await promise;

			expect(result.success).toBe(false);
			expect(result.message).toContain('Failed to add project path to allowlist');
		});

		it('should recover when command text is stuck at prompt by pressing Enter again', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';
			const addCommand = `/directory add ${projectPath}`;

			// Attempt 1:
			// 1) before output
			// 2) after output with command still in prompt (stuck)
			// 3) recovered output after Enter re-press with success confirmation
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before')
				.mockReturnValueOnce(`│ > ${addCommand}`)
				.mockReturnValueOnce('✓ Added directory');

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(10000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(1);
			// Initial dismiss Enter + recovery double-Enter
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(3);
		});

		it('should retry when prompt remains stuck after Enter recovery', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';
			const addCommand = `/directory add ${projectPath}`;

			// Attempt 1 stays stuck even after recovery capture.
			// Attempt 2 succeeds via normal output confirmation.
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before-1')
				.mockReturnValueOnce(`│ > ${addCommand}`)
				.mockReturnValueOnce(`│ > ${addCommand}`) // still stuck after Enter recovery
				.mockReturnValueOnce('before-2')
				.mockReturnValueOnce('before-2\n✓ Added directory');

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(30000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(2);
			// Attempt 1: initial + recovery double-Enter, attempt 2: initial
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(4);
		});

		it('should skip sending /directory add when path is already in workspace output', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';

			mockSessionHelper.capturePane.mockReturnValue(
				`The following directories are already in the workspace: ${projectPath}`
			);

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(5000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.message).toContain('already in Gemini CLI workspace');
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('should retry when Gemini reports slash command queue contention', async () => {
			const sessionName = 'test-session';
			const projectPath = '/path/to/project';

			// Attempt 1: queue warning appears
			// Attempt 2: explicit success confirmation
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before-1')
				.mockReturnValueOnce('Slash commands cannot be queued')
				.mockReturnValueOnce('before-2')
				.mockReturnValueOnce('✓ Added directory');

			const promise = service.addProjectToAllowlist(sessionName, projectPath);
			await jest.advanceTimersByTimeAsync(30000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(2);
		});
	});

	describe('addMultipleProjectsToAllowlist', () => {
		it('should send one batched /directory add command for multiple projects', async () => {
			const sessionName = 'test-session';
			const projectPaths = ['/path/to/project1', '/path/to/project2'];

			// Batch path: before capture, then explicit success confirmation.
			mockSessionHelper.capturePane
				.mockReturnValueOnce('before')
				.mockReturnValueOnce('✓ Added directory');

			const promise = service.addMultipleProjectsToAllowlist(sessionName, projectPaths);
			await jest.advanceTimersByTimeAsync(30000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.message).toBe('Added 2/2 projects to Gemini CLI allowlist');
			expect(result.results).toHaveLength(2);
			expect(result.results.every((r) => r.success)).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(1);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith(
				sessionName,
				`/directory add ${projectPaths.join(',')} `
			);
		});

		it('should fall back to per-path adds when batched command is not confirmed', async () => {
			const sessionName = 'test-session';
			const projectPaths = ['/path/to/project1', '/path/to/project2'];

			// Batch attempt (2 attempts) never confirms:
			// - returns no confirmation text
			// Then per-path fallback:
			// - project1 succeeds
			// - project2 succeeds
			mockSessionHelper.capturePane
				// Batch attempt 1 before/after
				.mockReturnValueOnce('before-batch-1')
				.mockReturnValueOnce('no confirmation')
				// Batch attempt 2 before/after
				.mockReturnValueOnce('before-batch-2')
				.mockReturnValueOnce('still no confirmation')
				// Fallback project1 before/after
				.mockReturnValueOnce('before-p1')
				.mockReturnValueOnce('✓ Added directory')
				// Fallback project2 before/after
				.mockReturnValueOnce('before-p2')
				.mockReturnValueOnce('✓ Added directory');

			const promise = service.addMultipleProjectsToAllowlist(sessionName, projectPaths);
			await jest.advanceTimersByTimeAsync(60000);
			const result = await promise;

			expect(result.success).toBe(true);
			expect(result.results[0].success).toBe(true);
			expect(result.results[1].success).toBe(true);
			// 2 batched attempts + 2 fallback per-path sends
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(4);
		});

		it('should return success false when no projects can be added', async () => {
			const sessionName = 'test-session';
			const projectPaths = ['/path/to/project1'];

			mockSessionHelper.sendMessage.mockRejectedValue(new Error('Connection failed'));

			const promise = service.addMultipleProjectsToAllowlist(sessionName, projectPaths);
			await jest.advanceTimersByTimeAsync(60000);
			const result = await promise;

			expect(result.success).toBe(false);
			expect(result.message).toBe('Added 0/1 projects to Gemini CLI allowlist');
		});
	});

	describe('getRuntimeExitPatterns', () => {
		it('should return Gemini-specific exit and failure patterns', () => {
			const patterns = service['getRuntimeExitPatterns']();
			// 2 clean exit + 11 failure patterns (includes GEMINI_STUCK_CONNECTIVITY_PATTERN + API connection failed + Authentication expired)
			expect(patterns).toHaveLength(13);
			// Clean exit patterns
			expect(patterns[0].test('Agent powering down')).toBe(true);
			expect(patterns[1].test('Interaction Summary')).toBe(true);
			// Gemini failure patterns
			expect(patterns.some(p => p.test('Request cancelled'))).toBe(true);
			expect(patterns.some(p => p.test('RESOURCE_EXHAUSTED'))).toBe(true);
			expect(patterns.some(p => p.test('UNAVAILABLE'))).toBe(true);
			expect(patterns.some(p => p.test('Connection error'))).toBe(true);
			expect(patterns.some(p => p.test('INTERNAL: server error'))).toBe(true);
			expect(patterns.some(p => p.test('DEADLINE_EXCEEDED'))).toBe(true);
			expect(patterns.some(p => p.test('PERMISSION_DENIED'))).toBe(true);
			expect(patterns.some(p => p.test('UNAUTHENTICATED'))).toBe(true);
		});

		it('should not match unrelated text', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns.some(p => p.test('Type your message'))).toBe(false);
		});

		it('should not match non-fatal Error: lines from tool output', () => {
			const patterns = service['getRuntimeExitPatterns']();
			// Generic "Error: something" should NOT match (was a false positive before)
			expect(patterns.some(p => p.test('Error: Path not in workspace'))).toBe(false);
			expect(patterns.some(p => p.test('Error: file not found'))).toBe(false);
			// But specific gRPC status codes SHOULD match
			expect(patterns.some(p => p.test('RESOURCE_EXHAUSTED: quota exceeded'))).toBe(true);
			expect(patterns.some(p => p.test('INTERNAL: server error'))).toBe(true);
		});
	});

	describe('getExitPatterns', () => {
		it('should expose exit patterns via public accessor', () => {
			const patterns = service.getExitPatterns();
			// 2 clean exit + 11 failure patterns (includes GEMINI_STUCK_CONNECTIVITY_PATTERN + API connection failed + Authentication expired)
			expect(patterns).toHaveLength(13);
		});
	});

	describe('checkGeminiInstallation', () => {
		it('should report Gemini CLI as available', async () => {
			const result = await service.checkGeminiInstallation();

			expect(result.isInstalled).toBe(true);
			expect(result.message).toBe('Gemini CLI is available');
		});
	});

	describe('initializeGeminiInSession', () => {
		it('should call executeRuntimeInitScript', async () => {
			const spy = jest.spyOn(service, 'executeRuntimeInitScript').mockResolvedValue(undefined);

			const result = await service.initializeGeminiInSession('test-session');

			expect(result.success).toBe(true);
			expect(spy).toHaveBeenCalledWith('test-session');
		});

		it('should handle initialization errors gracefully', async () => {
			jest.spyOn(service, 'executeRuntimeInitScript').mockRejectedValue(
				new Error('Init failed')
			);

			const result = await service.initializeGeminiInSession('test-session');

			expect(result.success).toBe(false);
			expect(result.message).toBe('Init failed');
		});
	});

	describe('ensureGeminiMcpConfig', () => {
		const mockSafeReadJson = safeReadJson as jest.MockedFunction<typeof safeReadJson>;
		const mockAtomicWriteJson = atomicWriteJson as jest.MockedFunction<typeof atomicWriteJson>;
		const mockMkdir = fs.mkdir as jest.MockedFunction<typeof fs.mkdir>;
		const mockGetSettingsService = getSettingsService as jest.MockedFunction<typeof getSettingsService>;

		beforeEach(() => {
			jest.clearAllMocks();
			mockSafeReadJson.mockResolvedValue({});
			mockAtomicWriteJson.mockResolvedValue(undefined);
			mockMkdir.mockResolvedValue(undefined);
			mockGetSettingsService.mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(getDefaultSettings()),
			} as any);
		});

		it('should create .gemini/settings.json with playwright when it does not exist', async () => {
			mockSafeReadJson.mockResolvedValue({});

			await service.ensureGeminiMcpConfig('/test/project');

			expect(mockMkdir).toHaveBeenCalledWith(
				path.join('/test/project', '.gemini'),
				{ recursive: true }
			);
			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.gemini', 'settings.json'),
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

			await service.ensureGeminiMcpConfig('/test/project');

			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.gemini', 'settings.json'),
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

			await service.ensureGeminiMcpConfig('/test/project');

			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				path.join('/test/project', '.gemini', 'settings.json'),
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

			await service.ensureGeminiMcpConfig('/test/project');

			// Should not write MCP config with playwright servers
			expect(mockAtomicWriteJson).not.toHaveBeenCalled();
			// mkdir is still called for the disableAutoUpdate settings write
			expect(mockMkdir).toHaveBeenCalled();
		});

		it('should default to enabled when settings service is unavailable', async () => {
			mockGetSettingsService.mockReturnValue({
				getSettings: jest.fn().mockRejectedValue(new Error('Settings unavailable')),
			} as any);

			await service.ensureGeminiMcpConfig('/test/project');

			// Should still add playwright (default to enabled)
			expect(mockAtomicWriteJson).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					mcpServers: expect.objectContaining({
						playwright: expect.any(Object),
					}),
				})
			);
		});

		it('should not throw when filesystem operations fail', async () => {
			mockMkdir.mockRejectedValue(new Error('Permission denied'));

			// Should not throw — errors are handled gracefully
			await expect(service.ensureGeminiMcpConfig('/test/project')).resolves.not.toThrow();
		});

		it('should set disableAutoUpdate=true in settings.json (#128)', async () => {
			const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
			const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
			// MCP config writes first via atomicWriteJson, then our code reads/writes
			mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: {} }));
			mockWriteFile.mockResolvedValue(undefined);

			await service.ensureGeminiMcpConfig('/test/project');

			expect(mockWriteFile).toHaveBeenCalledWith(
				path.join('/test/project', '.gemini', 'settings.json'),
				expect.stringContaining('"disableAutoUpdate": true')
			);
		});

		it('should not overwrite disableAutoUpdate if already true (#128)', async () => {
			const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
			const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
			mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: {}, disableAutoUpdate: true }));
			mockWriteFile.mockResolvedValue(undefined);

			await service.ensureGeminiMcpConfig('/test/project');

			// writeFile should NOT be called for settings.json (since disableAutoUpdate is already true)
			// Note: writeFile may be called for other files like .env, so filter for settings.json
			const settingsWriteCalls = mockWriteFile.mock.calls.filter(
				(call) => String(call[0]).includes('settings.json')
			);
			expect(settingsWriteCalls).toHaveLength(0);
		});
	});

	describe('ensureGeminiEnvFile', () => {
		const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
		const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
		const mockAppendFile = fs.appendFile as jest.MockedFunction<typeof fs.appendFile>;

		const projectPath = '/test/project';
		const envPath = path.join(projectPath, '.env');
		const gitignorePath = path.join(projectPath, '.gitignore');

		let originalEnv: string | undefined;

		beforeEach(() => {
			// ensureGeminiEnvFile uses async/await — need real timers
			jest.useRealTimers();
			jest.clearAllMocks();
			// Re-setup settingsService mock after clearAllMocks (clearAllMocks resets mockReturnValue)
			(getSettingsService as jest.Mock).mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(getDefaultSettings()),
				getApiKey: jest.fn().mockResolvedValue('test-api-key-123'),
			});
			originalEnv = process.env.GEMINI_API_KEY;
			// Default: set the env var so most tests can focus on file behavior
			process.env.GEMINI_API_KEY = 'test-api-key-123';

			// Default mocks: files do not exist (readFile rejects with ENOENT)
			mockReadFile.mockRejectedValue(new Error('ENOENT'));
			mockWriteFile.mockResolvedValue(undefined);
			mockAppendFile.mockResolvedValue(undefined);
		});

		afterEach(() => {
			// Restore fake timers for other test groups
			jest.useFakeTimers();
			// Restore original env
			if (originalEnv !== undefined) {
				process.env.GEMINI_API_KEY = originalEnv;
			} else {
				delete process.env.GEMINI_API_KEY;
			}
		});

		it('should skip when API key is not available', async () => {
			delete process.env.GEMINI_API_KEY;
			// Mock getApiKey returning null (no key found in settings or env)
			(getSettingsService as jest.Mock).mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(getDefaultSettings()),
				getApiKey: jest.fn().mockResolvedValue(null),
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should not attempt any file operations
			expect(mockReadFile).not.toHaveBeenCalled();
			expect(mockWriteFile).not.toHaveBeenCalled();
			expect(mockAppendFile).not.toHaveBeenCalled();
		});

		it('should skip when .env already contains the matching key', async () => {
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) return 'SOME_VAR=abc\nGEMINI_API_KEY="test-api-key-123"\n';
				throw new Error('ENOENT');
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should read the file but not write — key already matches settings value
			expect(mockReadFile).toHaveBeenCalledWith(envPath, 'utf8');
			expect(mockWriteFile).not.toHaveBeenCalled();
			expect(mockAppendFile).not.toHaveBeenCalled();
		});

		it('should append key to existing .env file that lacks it', async () => {
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) return 'SOME_VAR=abc\n';
				throw new Error('ENOENT');
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should append to existing .env (content ends with newline, so no extra separator)
			expect(mockAppendFile).toHaveBeenCalledWith(
				envPath,
				'GEMINI_API_KEY="test-api-key-123"\n'
			);
			// Should not create a new file
			expect(mockWriteFile).not.toHaveBeenCalledWith(
				envPath,
				expect.anything()
			);
		});

		it('should append with newline separator when existing .env does not end with newline', async () => {
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) return 'SOME_VAR=abc'; // no trailing newline
				throw new Error('ENOENT');
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should prepend a newline separator before the key
			expect(mockAppendFile).toHaveBeenCalledWith(
				envPath,
				'\nGEMINI_API_KEY="test-api-key-123"\n'
			);
		});

		it('should create new .env file when it does not exist', async () => {
			// Default: readFile rejects (file doesn't exist)

			await service['ensureGeminiEnvFile'](projectPath);

			// Should create .env with writeFile
			expect(mockWriteFile).toHaveBeenCalledWith(
				envPath,
				'GEMINI_API_KEY="test-api-key-123"\n'
			);
			// Should not attempt to append to .env
			expect(mockAppendFile).not.toHaveBeenCalledWith(
				envPath,
				expect.anything()
			);
		});

		it('should add .env to .gitignore if not present', async () => {
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) throw new Error('ENOENT');
				if (p === gitignorePath) return 'node_modules/\ndist/\n';
				throw new Error('ENOENT');
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should create .env
			expect(mockWriteFile).toHaveBeenCalledWith(
				envPath,
				'GEMINI_API_KEY="test-api-key-123"\n'
			);

			// Should append .env entry to .gitignore
			expect(mockAppendFile).toHaveBeenCalledWith(
				gitignorePath,
				'.env\n'
			);
		});

		it('should create .gitignore with .env entry when .gitignore does not exist', async () => {
			// Default: all readFile reject (no files exist)

			await service['ensureGeminiEnvFile'](projectPath);

			// Should create .gitignore with .env entry
			expect(mockWriteFile).toHaveBeenCalledWith(
				gitignorePath,
				'.env\n'
			);
		});

		it('should not modify .gitignore if .env is already listed', async () => {
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) throw new Error('ENOENT');
				if (p === gitignorePath) return 'node_modules/\n.env\ndist/\n';
				throw new Error('ENOENT');
			});

			await service['ensureGeminiEnvFile'](projectPath);

			// Should create .env
			expect(mockWriteFile).toHaveBeenCalledWith(
				envPath,
				'GEMINI_API_KEY="test-api-key-123"\n'
			);

			// Should NOT append to .gitignore since .env is already there
			expect(mockAppendFile).not.toHaveBeenCalledWith(
				gitignorePath,
				expect.anything()
			);
			// Should NOT write a new .gitignore
			expect(mockWriteFile).not.toHaveBeenCalledWith(
				gitignorePath,
				expect.anything()
			);
		});

		it('should handle errors gracefully when writing .env fails', async () => {
			// readFile rejects (file doesn't exist), writeFile rejects
			mockWriteFile.mockRejectedValueOnce(new Error('Permission denied'));

			// Should not throw
			await expect(service['ensureGeminiEnvFile'](projectPath)).resolves.not.toThrow();
		});

		it('should handle errors gracefully when updating .gitignore fails', async () => {
			// .env does not exist, .gitignore read throws
			mockReadFile.mockImplementation(async (p) => {
				if (p === envPath) throw new Error('ENOENT');
				if (p === gitignorePath) throw new Error('Read error');
				throw new Error('ENOENT');
			});

			// Should not throw — gitignore errors are caught separately
			await expect(service['ensureGeminiEnvFile'](projectPath)).resolves.not.toThrow();

			// Should still have created the .env file
			expect(mockWriteFile).toHaveBeenCalledWith(
				envPath,
				'GEMINI_API_KEY="test-api-key-123"\n'
			);
		});
	});

	describe('ensureGeminiTrustedFolders', () => {
		beforeEach(() => {
			jest.clearAllMocks();
		});

		it('should create trustedFolders.json entries for required paths', async () => {
			(fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockReset();
			(fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockReset();
			(fs.mkdir as jest.MockedFunction<typeof fs.mkdir>).mockReset();

			// Re-set implementations after reset (mockReset strips implementations)
			(fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockResolvedValueOnce('{}' as any);
			(fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mockResolvedValue(undefined as any);
			(fs.mkdir as jest.MockedFunction<typeof fs.mkdir>).mockResolvedValue(undefined as any);

			await (service as any).ensureGeminiTrustedFolders([
				'/Users/yellowsunhy/.crewly',
				'/Users/yellowsunhy/Desktop/projects/crewly',
			]);

			expect(fs.writeFile).toHaveBeenCalled();
			const writeArgs = (fs.writeFile as jest.MockedFunction<typeof fs.writeFile>).mock.calls[0];
			expect(String(writeArgs[0])).toContain(path.join('.gemini', 'trustedFolders.json'));
			const content = String(writeArgs[1]);
			expect(content).toContain('"/Users/yellowsunhy/.crewly": "TRUST_FOLDER"');
			expect(content).toContain('"/Users/yellowsunhy/Desktop/projects/crewly": "TRUST_FOLDER"');
		});

		it('should preserve existing trusted folders and avoid duplicate writes when unchanged', async () => {
			(fs.readFile as jest.MockedFunction<typeof fs.readFile>).mockResolvedValueOnce(
				JSON.stringify({
					'/Users/yellowsunhy/.crewly': 'TRUST_FOLDER',
				}) as any
			);

			await (service as any).ensureGeminiTrustedFolders([
				'/Users/yellowsunhy/.crewly',
			]);

			expect(fs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('GEMINI_FAILURE_PATTERNS', () => {
		it('should export failure patterns as a constant array', () => {
			expect(GEMINI_FAILURE_PATTERNS).toBeInstanceOf(Array);
			expect(GEMINI_FAILURE_PATTERNS.length).toBe(11);
		});

		it('should contain expected failure patterns', () => {
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Request cancelled'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('RESOURCE_EXHAUSTED'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('UNAVAILABLE'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Connection error'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('INTERNAL: server error'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('DEADLINE_EXCEEDED'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('PERMISSION_DENIED'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('UNAUTHENTICATED'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Trying to reach gemini-3.1-pro-preview (Attempt 7/10)'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('API connection failed'))).toBe(true);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Authentication expired'))).toBe(true);
		});

		it('should not match normal output or non-fatal errors', () => {
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Working on task'))).toBe(false);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Type your message'))).toBe(false);
			// Non-fatal tool errors should NOT match
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Error: Path not in workspace'))).toBe(false);
			expect(GEMINI_FAILURE_PATTERNS.some(p => p.test('Error: file not found'))).toBe(false);
		});
	});

});
