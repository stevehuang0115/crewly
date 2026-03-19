import { RuntimeAgentService } from './runtime-agent.service.abstract.js';
import { SessionCommandHelper } from '../session/index.js';
import { RUNTIME_TYPES, type RuntimeType } from '../../constants.js';
import * as settingsServiceModule from '../settings/settings.service.js';
import { getDefaultSettings } from '../../types/settings.types.js';
import { readFile } from 'fs/promises';
import { safeReadJson } from '../../utils/file-io.utils.js';

// Mock fs/promises at module level so the static import in the source file is intercepted
jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
}));

jest.mock('../../utils/file-io.utils.js', () => ({
	safeReadJson: jest.fn(),
	atomicWriteJson: jest.fn().mockResolvedValue(undefined),
}));

const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;
const mockSafeReadJson = safeReadJson as jest.MockedFunction<typeof safeReadJson>;

// Test implementation of abstract class
class TestRuntimeService extends RuntimeAgentService {
	constructor(sessionHelper: SessionCommandHelper, projectRoot: string) {
		super(sessionHelper, projectRoot);
	}

	protected getRuntimeType(): RuntimeType {
		return RUNTIME_TYPES.CLAUDE_CODE;
	}

	protected async detectRuntimeSpecific(sessionName: string): Promise<boolean> {
		return sessionName === 'test-session-running';
	}

	protected getRuntimeReadyPatterns(): string[] {
		return ['Ready', 'Welcome'];
	}

	protected getRuntimeErrorPatterns(): string[] {
		return ['Error', 'Failed'];
	}

	protected getRuntimeExitPatterns(): RegExp[] {
		return [/Test exited/i, /Session ended/i];
	}
}

describe('RuntimeAgentService (Abstract)', () => {
	let service: TestRuntimeService;
	let mockSessionHelper: jest.Mocked<SessionCommandHelper>;

	beforeEach(() => {
		mockSessionHelper = {
			capturePane: jest.fn(),
			sendKey: jest.fn(),
			sendEnter: jest.fn(),
			sendCtrlC: jest.fn(),
			sendMessage: jest.fn(),
			sendEscape: jest.fn(),
			clearCurrentCommandLine: jest.fn(),
			sessionExists: jest.fn(),
			createSession: jest.fn(),
			killSession: jest.fn(),
			setEnvironmentVariable: jest.fn(),
			writeRaw: jest.fn(),
			getSession: jest.fn(),
			getRawHistory: jest.fn(),
			getTerminalBuffer: jest.fn(),
			backend: {},
		} as any;

		// Reset the mock for readFile before each test
		mockReadFile.mockReset();

		service = new TestRuntimeService(mockSessionHelper, '/test/project');
	});

	describe('constructor', () => {
		it('should initialize with session helper and project root', () => {
			expect(service['sessionHelper']).toBe(mockSessionHelper);
			expect(service['projectRoot']).toBe('/test/project');
			expect(service['logger']).toBeDefined();
		});

		it('should initialize detection state maps', () => {
			expect(service['detectionInProgress']).toBeInstanceOf(Map);
			expect(service['detectionResults']).toBeInstanceOf(Map);
		});
	});

	describe('detectRuntimeWithCommand', () => {
		it('should return true for running runtime session', async () => {
			const result = await service.detectRuntimeWithCommand('test-session-running');
			expect(result).toBe(true);
		});

		it('should return false for non-running runtime session', async () => {
			const result = await service.detectRuntimeWithCommand('test-session-stopped');
			expect(result).toBe(false);
		});

		it('should use cached results within cache timeout', async () => {
			// First call
			await service.detectRuntimeWithCommand('test-session-running');

			// Mock the concrete implementation to return different value
			const spy = jest.spyOn(service as any, 'detectRuntimeSpecific');
			spy.mockResolvedValue(false);

			// Second call should use cache (not call detectRuntimeSpecific again)
			const result = await service.detectRuntimeWithCommand('test-session-running');

			expect(result).toBe(true); // Should still be true from cache
		});

		it('should not run concurrent detections for same session', async () => {
			const spy = jest.spyOn(service as any, 'detectRuntimeSpecific');
			spy.mockImplementation(async () => {
				await new Promise(resolve => setTimeout(resolve, 100));
				return true;
			});

			// Start two concurrent detections
			const promise1 = service.detectRuntimeWithCommand('test-session');
			const promise2 = service.detectRuntimeWithCommand('test-session');

			const [result1, result2] = await Promise.all([promise1, promise2]);

			// Should only call detectRuntimeSpecific once due to concurrency protection
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result1).toBe(true);
			expect(result2).toBe(true);
		});
	});

	describe('clearDetectionCache', () => {
		it('should clear cached detection result for session', async () => {
			// First call to cache result
			await service.detectRuntimeWithCommand('test-session-running');

			// Clear cache
			service.clearDetectionCache('test-session-running');

			// Mock to return different value
			const spy = jest.spyOn(service as any, 'detectRuntimeSpecific');
			spy.mockResolvedValue(false);

			// Should call detectRuntimeSpecific again since cache was cleared
			const result = await service.detectRuntimeWithCommand('test-session-running');
			expect(result).toBe(false);
			expect(spy).toHaveBeenCalled();
		});
	});

	describe('waitForRuntimeReady', () => {
		it('should return true when ready pattern is found', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Welcome to the system');

			const result = await service['waitForRuntimeReady']('test-session', 1000);

			expect(result).toBe(true);
		});

		it('should return false when error pattern is found', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Error: Failed to start');

			const result = await service['waitForRuntimeReady']('test-session', 1000);

			expect(result).toBe(false);
		});

		it('should return false when timeout is reached', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Loading...');

			const result = await service['waitForRuntimeReady']('test-session', 100);

			expect(result).toBe(false);
		});

		it('should return false immediately when error pattern is detected without waiting for timeout', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Failed to initialize runtime');

			const startTime = Date.now();
			// Use a very long timeout to prove fail-fast behavior
			const result = await service['waitForRuntimeReady']('test-session', 30000, 2000);
			const elapsed = Date.now() - startTime;

			expect(result).toBe(false);
			// Should return well before the 30s timeout; allow generous margin for CI but
			// it must be significantly less than the timeout to prove fail-fast
			expect(elapsed).toBeLessThan(5000);
			// capturePane should only be called once since error is found on first check
			expect(mockSessionHelper.capturePane).toHaveBeenCalledTimes(1);
		});

		it('should detect the "Error" pattern alone in output', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Error: something went wrong');

			const result = await service['waitForRuntimeReady']('test-session', 5000, 500);

			expect(result).toBe(false);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledTimes(1);
		});

		it('should detect the "Failed" pattern alone in output', async () => {
			mockSessionHelper.capturePane.mockReturnValue('Connection Failed');

			const result = await service['waitForRuntimeReady']('test-session', 5000, 500);

			expect(result).toBe(false);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledTimes(1);
		});

		it('should not false-positive when output contains no error or ready patterns', async () => {
			// Output that does not contain "Error", "Failed", "Ready", or "Welcome"
			mockSessionHelper.capturePane.mockReturnValue('Initializing system... please wait');

			const result = await service['waitForRuntimeReady']('test-session', 200, 50);

			expect(result).toBe(false);
			// Should have been called multiple times since it polled until timeout
			expect(mockSessionHelper.capturePane.mock.calls.length).toBeGreaterThan(1);
		});

		it('should match error pattern as a substring (includes-based matching)', async () => {
			// "Error" appears as a substring inside "RuntimeError" -- since the code uses
			// output.includes(pattern), this WILL match. This test documents that behavior.
			mockSessionHelper.capturePane.mockReturnValue('Caught a RuntimeError in module');

			const result = await service['waitForRuntimeReady']('test-session', 5000, 500);

			expect(result).toBe(false);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledTimes(1);
		});

		it('should prioritize ready pattern over error pattern when both are present', async () => {
			// The code checks ready patterns BEFORE error patterns, so when both match,
			// the method should return true (ready takes priority).
			mockSessionHelper.capturePane.mockReturnValue('Welcome - Error log cleared');

			const result = await service['waitForRuntimeReady']('test-session', 5000, 500);

			expect(result).toBe(true);
			expect(mockSessionHelper.capturePane).toHaveBeenCalledTimes(1);
		});

		it('should detect error pattern appearing after initial clean output', async () => {
			// Simulate output changing over time: first call clean, second call has error
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return 'Initializing...';
				}
				return 'Initializing... Failed to connect';
			});

			const result = await service['waitForRuntimeReady']('test-session', 10000, 50);

			expect(result).toBe(false);
			// Should have been called at least twice: first clean, then with error
			expect(mockSessionHelper.capturePane.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		it('should handle capturePane throwing an error gracefully and continue polling', async () => {
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					throw new Error('Session not found');
				}
				return 'Welcome to the runtime';
			});

			const result = await service['waitForRuntimeReady']('test-session', 10000, 50);

			expect(result).toBe(true);
			// Should have recovered from the error on first call and found ready on second
			expect(mockSessionHelper.capturePane.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('executeRuntimeInitScript', () => {
		it('should handle script execution method existence', async () => {
			// Test that the method exists and can be called
			expect(typeof service.executeRuntimeInitScript).toBe('function');
		});

		it('should handle script execution with different target paths', async () => {
			// Test that the method exists and can be called with different parameters
			const result = service.executeRuntimeInitScript('test-session', '/target/path');
			expect(result).toBeDefined();
		});
	});

	describe('runtime configuration', () => {
		it('should have access to runtime configuration', () => {
			// Test that the service has runtime configuration properties
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.CLAUDE_CODE);
		});

		it('should handle runtime configuration initialization', () => {
			// Test that runtime type is properly set during construction
			const runtimeType = service['getRuntimeType']();
			expect(runtimeType).toBeDefined();
			expect(typeof runtimeType).toBe('string');
		});
	});

	describe('script path resolution', () => {
		beforeEach(() => {
			mockReadFile.mockReset();
		});

		it('should construct correct path for initialization scripts in runtime_scripts directory', async () => {
			const scriptContent = 'echo "test command"\necho "another command"';
			mockReadFile.mockResolvedValue(scriptContent as any);

			const projectRoot = '/test/project';
			const testService = new TestRuntimeService(mockSessionHelper, projectRoot);

			const commands = await testService['loadInitScript']('initialize_gemini.sh');

			// Verify readFile was called with correct path including runtime_scripts directory
			expect(mockReadFile).toHaveBeenCalledWith(
				'/test/project/config/runtime_scripts/initialize_gemini.sh',
				'utf8'
			);
			expect(commands).toEqual(['echo "test command"', 'echo "another command"']);
		});

		it('should construct correct path for claude initialization script', async () => {
			const scriptContent = 'claude --version\necho "Claude ready"';
			mockReadFile.mockResolvedValue(scriptContent as any);

			const projectRoot = '/test/project';
			const testService = new TestRuntimeService(mockSessionHelper, projectRoot);

			await testService['loadInitScript']('initialize_claude.sh');

			expect(mockReadFile).toHaveBeenCalledWith(
				'/test/project/config/runtime_scripts/initialize_claude.sh',
				'utf8'
			);
		});

		it('should construct correct path for codex initialization script', async () => {
			const scriptContent = 'codex --help';
			mockReadFile.mockResolvedValue(scriptContent as any);

			const projectRoot = '/test/project';
			const testService = new TestRuntimeService(mockSessionHelper, projectRoot);

			await testService['loadInitScript']('initialize_codex.sh');

			expect(mockReadFile).toHaveBeenCalledWith(
				'/test/project/config/runtime_scripts/initialize_codex.sh',
				'utf8'
			);
		});

		it('should filter out empty lines and comments from script', async () => {
			const scriptContent = `
# This is a comment
echo "first command"

# Another comment
echo "second command"

`;
			mockReadFile.mockResolvedValue(scriptContent as any);

			const projectRoot = '/test/project';
			const testService = new TestRuntimeService(mockSessionHelper, projectRoot);

			const commands = await testService['loadInitScript']('test_script.sh');

			expect(commands).toEqual(['echo "first command"', 'echo "second command"']);
		});
	});

	describe('runtime flag injection', () => {
		it('should inject runtime flags before --dangerously-skip-permissions', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path', ['--chrome']);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --chrome --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should inject multiple runtime flags', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path', ['--chrome', '--verbose']);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --chrome --verbose --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should not modify commands when runtimeFlags is undefined', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path', undefined);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should not modify commands when runtimeFlags is empty array', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path', []);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should append --append-system-prompt-file when promptFilePath is provided', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript(
				'test-session',
				'/test/path',
				undefined,
				'/home/test/.crewly/prompts/test-session-init.md'
			);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions --append-system-prompt-file "/home/test/.crewly/prompts/test-session-init.md"'],
				'/test/path',
			);
		});

		it('should append --append-system-prompt-file after runtime flags', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript(
				'test-session',
				'/test/path',
				['--chrome'],
				'/home/test/.crewly/prompts/test-session-init.md'
			);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --chrome --dangerously-skip-permissions --append-system-prompt-file "/home/test/.crewly/prompts/test-session-init.md"'],
				'/test/path',
			);
		});

		it('should silently skip prompt file injection when command lacks --dangerously-skip-permissions', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'custom_script.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'echo "no flag marker here"',
			]);
			// Force settings to not return a command, so it falls through to loadInitScript
			jest.spyOn(settingsServiceModule, 'getSettingsService').mockImplementation(() => {
				throw new Error('Settings unavailable');
			});
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript(
				'test-session',
				'/test/path',
				undefined,
				'/home/test/.crewly/prompts/test-session-init.md'
			);

			// Command should be unchanged — no --dangerously-skip-permissions to anchor on
			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['echo "no flag marker here"'],
				'/test/path',
			);
		});

		it('should handle promptFilePath with spaces', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript(
				'test-session',
				'/test/path',
				undefined,
				'/home/test user/.crewly/prompts/my session-init.md'
			);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions --append-system-prompt-file "/home/test user/.crewly/prompts/my session-init.md"'],
				'/test/path',
			);
		});

		it('should not append --append-system-prompt-file when promptFilePath is undefined', async () => {
			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path', undefined, undefined);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});
	});

	describe('settings-based init command', () => {
		it('should use command from settings when available', async () => {
			const mockSettings = getDefaultSettings();
			mockSettings.general.runtimeCommands['claude-code'] = '/custom/claude --dangerously-skip-permissions';

			jest.spyOn(settingsServiceModule, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(mockSettings),
			} as any);

			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path');

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['/custom/claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should append --append-system-prompt-file to settings-based command', async () => {
			const mockSettings = getDefaultSettings();
			mockSettings.general.runtimeCommands['claude-code'] = 'claude --dangerously-skip-permissions';

			jest.spyOn(settingsServiceModule, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(mockSettings),
			} as any);

			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript(
				'test-session',
				'/test/path',
				undefined,
				'/home/test/.crewly/prompts/test-session-init.md'
			);

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions --append-system-prompt-file "/home/test/.crewly/prompts/test-session-init.md"'],
				'/test/path',
			);
		});

		it('should fallback to init script when settings command is empty', async () => {
			const mockSettings = getDefaultSettings();
			mockSettings.general.runtimeCommands['claude-code'] = '  ';

			jest.spyOn(settingsServiceModule, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue(mockSettings),
			} as any);

			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path');

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});

		it('should fallback to init script when settings service throws', async () => {
			jest.spyOn(settingsServiceModule, 'getSettingsService').mockImplementation(() => {
				throw new Error('Settings unavailable');
			});

			jest.spyOn(service as any, 'getRuntimeConfig').mockReturnValue({
				initScript: 'initialize_claude.sh',
				displayName: 'Claude Code',
				welcomeMessage: 'Welcome',
				timeout: 120000,
				description: 'Claude Code CLI',
			});
			jest.spyOn(service as any, 'loadInitScript').mockResolvedValue([
				'claude --dangerously-skip-permissions',
			]);
			const sendCommandsSpy = jest.spyOn(service as any, 'sendShellCommandsToSession').mockResolvedValue(undefined);

			await service.executeRuntimeInitScript('test-session', '/test/path');

			expect(sendCommandsSpy).toHaveBeenCalledWith(
				'test-session',
				['claude --dangerously-skip-permissions'],
				'/test/path',
			);
		});
	});

	describe('postInitialize', () => {
		it('should be a no-op by default (does not throw)', async () => {
			await expect(service.postInitialize('test-session')).resolves.not.toThrow();
		});
	});

	describe('abstract method implementations', () => {
		it('getRuntimeType should return correct runtime type', () => {
			expect(service['getRuntimeType']()).toBe(RUNTIME_TYPES.CLAUDE_CODE);
		});

		it('getRuntimeReadyPatterns should return array of patterns', () => {
			const patterns = service['getRuntimeReadyPatterns']();
			expect(patterns).toEqual(['Ready', 'Welcome']);
		});

		it('getRuntimeErrorPatterns should return array of error patterns', () => {
			const patterns = service['getRuntimeErrorPatterns']();
			expect(patterns).toEqual(['Error', 'Failed']);
		});

		it('getRuntimeExitPatterns should return array of exit patterns', () => {
			const patterns = service['getRuntimeExitPatterns']();
			expect(patterns).toHaveLength(2);
			expect(patterns[0]).toBeInstanceOf(RegExp);
		});
	});

	describe('getExitPatterns', () => {
		it('should return exit patterns via public accessor', () => {
			const patterns = service.getExitPatterns();
			expect(patterns).toHaveLength(2);
			expect(patterns[0].test('Test exited')).toBe(true);
			expect(patterns[1].test('Session ended')).toBe(true);
		});

		it('should not match unrelated text', () => {
			const patterns = service.getExitPatterns();
			expect(patterns.some(p => p.test('Hello world'))).toBe(false);
		});
	});

	describe('verifyMcpConfig', () => {
		let verifyMcpConfig: (configFilePath: string, expectedServers: string[]) => Promise<boolean>;

		beforeEach(() => {
			verifyMcpConfig = (service as any).verifyMcpConfig.bind(service);
		});

		it('should return true when all expected servers are present', async () => {
			mockSafeReadJson.mockResolvedValue({
				mcpServers: {
					'crewly-server': { command: 'node', args: ['server.js'] },
					'chrome-mcp': { command: 'node', args: ['chrome.js'] },
				},
			});

			const result = await verifyMcpConfig('/path/to/config.json', ['crewly-server', 'chrome-mcp']);
			expect(result).toBe(true);
		});

		it('should return false when expected servers are missing', async () => {
			mockSafeReadJson.mockResolvedValue({
				mcpServers: {
					'crewly-server': { command: 'node', args: ['server.js'] },
				},
			});

			const result = await verifyMcpConfig('/path/to/config.json', ['crewly-server', 'chrome-mcp']);
			expect(result).toBe(false);
		});

		it('should return false when mcpServers key is missing', async () => {
			mockSafeReadJson.mockResolvedValue({});

			const result = await verifyMcpConfig('/path/to/config.json', ['crewly-server']);
			expect(result).toBe(false);
		});

		it('should return true for empty expected servers list', async () => {
			mockSafeReadJson.mockResolvedValue({ mcpServers: {} });

			const result = await verifyMcpConfig('/path/to/config.json', []);
			expect(result).toBe(true);
		});

		it('should return false when file read throws', async () => {
			mockSafeReadJson.mockRejectedValue(new Error('ENOENT'));

			const result = await verifyMcpConfig('/path/to/config.json', ['crewly-server']);
			expect(result).toBe(false);
		});
	});
});
