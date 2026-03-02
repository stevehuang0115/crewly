/**
 * Tests for AgentRegistrationService
 * Tests the multi-step agent initialization and registration process
 */

import { AgentRegistrationService } from './agent-registration.service.js';
import { StorageService } from '../core/storage.service.js';
import { LoggerService } from '../core/logger.service.js';
import * as sessionModule from '../session/index.js';
import { getSessionStatePersistence } from '../session/index.js';
import { RuntimeServiceFactory } from './runtime-service.factory.js';
import { CREWLY_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';

// Mock dependencies
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn().mockReturnValue({
			createComponentLogger: jest.fn().mockReturnValue({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

jest.mock('fs/promises', () => ({
	readFile: jest.fn(),
	readdir: jest.fn().mockResolvedValue([]),
	stat: jest.fn().mockResolvedValue({ mtimeMs: 0 }),
	mkdir: jest.fn().mockResolvedValue(undefined),
	writeFile: jest.fn().mockResolvedValue(undefined),
	access: jest.fn(),
}));

jest.mock('os', () => ({
	homedir: jest.fn().mockReturnValue('/home/test'),
}));

jest.mock('../settings/settings.service.js', () => ({
	getSettingsService: jest.fn().mockReturnValue({
		getSettings: jest.fn().mockResolvedValue({
			general: { autoResumeOnRestart: true },
		}),
	}),
}));

// Mock session module
jest.mock('../session/index.js', () => ({
	getSessionBackendSync: jest.fn(),
	createSessionBackend: jest.fn(),
	createSessionCommandHelper: jest.fn(),
	getSessionStatePersistence: jest.fn(),
}));

// Mock RuntimeServiceFactory
jest.mock('./runtime-service.factory.js', () => ({
	RuntimeServiceFactory: {
		create: jest.fn(),
	},
}));

// Mock PtyActivityTrackerService — default to high idle time (agent not busy)
const mockGetIdleTimeMs = jest.fn().mockReturnValue(999999);
jest.mock('./pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: jest.fn().mockReturnValue({
			getIdleTimeMs: (...args: unknown[]) => mockGetIdleTimeMs(...args),
		}),
	},
}));

describe('AgentRegistrationService', () => {
	let service: AgentRegistrationService;
	let mockStorageService: jest.Mocked<StorageService>;
	let mockReadFile: jest.Mock;
	let mockAccess: jest.Mock;
	let mockSessionHelper: any;
	let mockRuntimeService: any;

	beforeEach(() => {
		jest.clearAllMocks();

		// Reset idle time mock to default (agent not busy)
		mockGetIdleTimeMs.mockReturnValue(999999);

		// Mock session for event-driven delivery
		// The onData callback simulates terminal output stream
		let onDataCallback: ((data: string) => void) | null = null;
		const mockSession = {
			name: 'test-session',
			pid: 1234,
			cwd: '/test',
			onData: jest.fn().mockImplementation((callback: (data: string) => void) => {
				onDataCallback = callback;
				// Simulate prompt appearing after brief delay
				setTimeout(() => {
					if (onDataCallback) {
						onDataCallback('❯ '); // Claude at prompt
					}
				}, 50);
				// Simulate processing indicator after message sent
				setTimeout(() => {
					if (onDataCallback) {
						onDataCallback('⠋ Thinking...'); // Processing started
					}
				}, 100);
				return jest.fn(); // unsubscribe function
			}),
			onExit: jest.fn().mockReturnValue(jest.fn()),
			write: jest.fn(),
			resize: jest.fn(),
			kill: jest.fn(),
		};

		// Mock SessionCommandHelper
		mockSessionHelper = {
			sessionExists: jest.fn().mockReturnValue(false),
			killSession: jest.fn().mockResolvedValue(undefined),
			createSession: jest.fn().mockResolvedValue({ pid: 1234, cwd: '/test', name: 'test-session' }),
			sendCtrlC: jest.fn().mockResolvedValue(undefined),
			clearCurrentCommandLine: jest.fn().mockResolvedValue(undefined),
			sendMessage: jest.fn().mockResolvedValue(undefined),
			sendKey: jest.fn().mockResolvedValue(undefined),
			sendEscape: jest.fn().mockResolvedValue(undefined),
			sendEnter: jest.fn().mockResolvedValue(undefined),
			capturePane: jest.fn().mockReturnValue('❯ '), // Claude at prompt by default
			setEnvironmentVariable: jest.fn().mockResolvedValue(undefined),
			getSession: jest.fn().mockReturnValue(mockSession), // For event-driven delivery
			listSessions: jest.fn().mockReturnValue([]), // For scanForStuckMessages rewind detection
			writeRaw: jest.fn(), // For rewind mode recovery
		};

		// Mock RuntimeService
		mockRuntimeService = {
			clearDetectionCache: jest.fn(),
			detectRuntimeWithCommand: jest.fn().mockResolvedValue(true),
			executeRuntimeInitScript: jest.fn().mockResolvedValue(undefined),
			waitForRuntimeReady: jest.fn().mockResolvedValue(true),
		};

		// Setup session module mocks
		(sessionModule.getSessionBackendSync as jest.Mock).mockReturnValue({});
		(sessionModule.createSessionBackend as jest.Mock).mockResolvedValue({});
		(sessionModule.createSessionCommandHelper as jest.Mock).mockReturnValue(mockSessionHelper);

		// Setup RuntimeServiceFactory mock
		(RuntimeServiceFactory.create as jest.Mock).mockReturnValue(mockRuntimeService);

		// Mock StorageService
		mockStorageService = {
			updateAgentStatus: jest.fn().mockResolvedValue(undefined),
			updateOrchestratorStatus: jest.fn().mockResolvedValue(undefined),
			getOrchestratorStatus: jest.fn().mockResolvedValue({ agentStatus: 'active' }),
			getTeams: jest.fn().mockResolvedValue([]),
		} as any;

		mockReadFile = require('fs/promises').readFile;
		mockReadFile.mockResolvedValue('{"roles": [{"key": "orchestrator", "promptFile": "orchestrator-prompt.md"}]}');

		mockAccess = require('fs/promises').access;
		mockAccess.mockRejectedValue(new Error('ENOENT: no such file'));

		// Mock SessionStatePersistence
		(sessionModule.getSessionStatePersistence as jest.Mock).mockReturnValue({
			registerSession: jest.fn(),
			unregisterSession: jest.fn(),
			isSessionRegistered: jest.fn().mockReturnValue(false),
			isRestoredSession: jest.fn().mockReturnValue(false),
			getSessionId: jest.fn().mockReturnValue(undefined),
			updateSessionId: jest.fn(),
		});

		service = new AgentRegistrationService(null, '/test/project', mockStorageService);
	});

	describe('initializeAgentWithRegistration', () => {
		it('should succeed when runtime is ready after cleanup and reinit', async () => {
			// Mock runtime ready after reinit
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			const result = await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Agent registered successfully after cleanup and reinit');
			expect(mockRuntimeService.clearDetectionCache).toHaveBeenCalledWith('test-session');
		});

		it('should attempt full recreation if cleanup and reinit fails', async () => {
			// Mock Step 1 failure (reinit doesn't work)
			mockRuntimeService.waitForRuntimeReady
				.mockResolvedValueOnce(false) // Step 1 fails
				.mockResolvedValueOnce(true);  // Step 2 succeeds

			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			const result = await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Agent registered successfully after full recreation');
			expect(mockSessionHelper.killSession).toHaveBeenCalledWith('test-session');
		});

		it('should fail after all escalation attempts', async () => {
			// Mock all steps failing
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(false);

			const result = await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to initialize agent after optimized escalation attempts');
		});

		it('should update agent status to started when runtime is ready', async () => {
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'developer',
				'/test/path',
				90000
			);

			expect(mockStorageService.updateAgentStatus).toHaveBeenCalledWith(
				'test-session',
				CREWLY_CONSTANTS.AGENT_STATUSES.STARTED
			);
		});
	});

	describe('sendRegistrationPromptAsync', () => {
		it('should send kickoff instruction for Claude Code (not raw prompt or file-read)', async () => {
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}} as {{ROLE}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'developer',
				'/test/path',
				90000,
				undefined,
				RUNTIME_TYPES.CLAUDE_CODE
			);

			// Give time for async operation to complete (file write + delays in sendPromptRobustly)
			await new Promise(resolve => setTimeout(resolve, 1000));

			// Should have called sendMessage with kickoff instruction (not raw prompt or file-read)
			expect(mockSessionHelper.sendMessage).toHaveBeenCalled();
			const allCalls = mockSessionHelper.sendMessage.mock.calls.map((c: any[]) => c[1]);
			const kickoffCall = allCalls.find((msg: string) => msg && msg.includes('Begin your work now'));
			expect(kickoffCall).toBeDefined();
			expect(kickoffCall).toContain('initial assessment');
			// Should NOT contain file path (prompt loaded via --append-system-prompt-file)
			expect(kickoffCall).not.toContain('Read the file at');
		});

		it('should send file-read instruction for Gemini CLI', async () => {
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}} as {{ROLE}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'developer',
				'/test/path',
				90000,
				undefined,
				RUNTIME_TYPES.GEMINI_CLI
			);

			// Give time for async operation to complete. Gemini prompt delivery
			// does a pre-send Enter flush with a 1000ms delay before sendMessage.
			await new Promise(resolve => setTimeout(resolve, 2000));

			// Should have called sendMessage with file-read instruction for Gemini
			expect(mockSessionHelper.sendMessage).toHaveBeenCalled();
			const allCalls = mockSessionHelper.sendMessage.mock.calls.map((c: any[]) => c[1]);
			const fileReadCall = allCalls.find((msg: string) => msg && msg.includes('Read the file at'));
			expect(fileReadCall).toBeDefined();
			expect(fileReadCall).toContain('Read the file at');
		});
	});

	describe('createAgentSession', () => {
		it('should create a new session when one does not exist', async () => {
			// Ensure session does not exist initially
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)  // Initial check
				.mockReturnValueOnce(true);  // After creation check
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);

			// Mock the roles config properly
			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
			});

			expect(result.success).toBe(true);
			expect(mockSessionHelper.createSession).toHaveBeenCalledWith('test-session', '/test/project');
		});

		it('should set environment variables after creating session', async () => {
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)  // Initial check
				.mockReturnValueOnce(true);  // After creation check
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			// Session should be created successfully
			expect(result.success).toBe(true);

			// Environment variables should be set
			expect(mockSessionHelper.setEnvironmentVariable).toHaveBeenCalledWith(
				'test-session',
				'CREWLY_SESSION_NAME',
				'test-session'
			);
			expect(mockSessionHelper.setEnvironmentVariable).toHaveBeenCalledWith(
				'test-session',
				'CREWLY_ROLE',
				'developer'
			);
		});

		it('should attempt recovery when session already exists', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			mockRuntimeService.detectRuntimeWithCommand.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}');
			// Mock capturePane to show processing indicators so sendPromptRobustly succeeds
			mockSessionHelper.capturePane.mockReturnValue('⠋ Thinking... registering agent');

			// Mock successful registration check
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [{
					sessionName: 'test-session',
					role: 'developer',
					agentStatus: 'active',
				}],
			}] as any);

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			expect(result.success).toBe(true);
			expect(result.message).toContain('recovered');
		});

		it('should fall back to session recreation when recovery fails', async () => {
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(true)  // Initial check
				.mockReturnValueOnce(true); // After kill, check again returns false

			mockRuntimeService.detectRuntimeWithCommand.mockResolvedValue(false);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			expect(mockSessionHelper.killSession).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});

		it('should skip recovery and kill immediately when forceRecreate is true', async () => {
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(true)  // Initial check: session exists
				.mockReturnValueOnce(true); // After kill, verify session created
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				forceRecreate: true,
			});

			// Should kill session immediately without attempting recovery
			expect(mockSessionHelper.killSession).toHaveBeenCalledWith('test-session');
			expect(mockRuntimeService.clearDetectionCache).toHaveBeenCalledWith('test-session');

			// Should NOT attempt intelligent recovery steps
			expect(mockRuntimeService.detectRuntimeWithCommand).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendCtrlC).not.toHaveBeenCalled();

			expect(result.success).toBe(true);
		});

		it('should attempt recovery when forceRecreate is not set and session exists', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			mockRuntimeService.detectRuntimeWithCommand.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}');
			mockSessionHelper.capturePane.mockReturnValue('⠋ Thinking... registering agent');

			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [{
					sessionName: 'test-session',
					role: 'developer',
					agentStatus: 'active',
				}],
			}] as any);

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				// forceRecreate not set - should use default recovery behavior
			});

			// Should attempt intelligent recovery
			expect(mockRuntimeService.detectRuntimeWithCommand).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});
	});

	describe('session creation lock', () => {
		it('should prevent concurrent createAgentSession calls for the same session', async () => {
			// First call takes time to complete (runtime init + ready wait)
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)  // First call: session doesn't exist
				.mockReturnValueOnce(true)   // First call: after creation check
				.mockReturnValueOnce(false)  // Second call would check - but should wait
				.mockReturnValueOnce(true);  // Second call: after creation check
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');

			// Launch two concurrent createAgentSession calls for the same session
			const promise1 = service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
			});
			const promise2 = service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
			});

			const [result1, result2] = await Promise.all([promise1, promise2]);

			// Both should succeed (second one waits for first and returns same result)
			expect(result1.success).toBe(true);
			expect(result2.success).toBe(true);

			// createSession should only be called once (second call reused first's result)
			expect(mockSessionHelper.createSession).toHaveBeenCalledTimes(1);
		});

		it('should allow a subsequent call to succeed after a previous concurrent call fails', async () => {
			// First call: createSession throws
			mockSessionHelper.sessionExists.mockReturnValue(false);
			mockSessionHelper.createSession.mockRejectedValueOnce(new Error('PTY creation failed'));
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');

			const result1 = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			expect(result1.success).toBe(false);

			// Lock should be cleaned up after failure
			const locks = (service as any).sessionCreationLocks;
			expect(locks.has('test-session')).toBe(false);

			// Second call succeeds (lock cleared, no contention)
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockSessionHelper.createSession.mockResolvedValueOnce({ pid: 5678, cwd: '/test', name: 'test-session' });
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);

			const result2 = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			expect(result2.success).toBe(true);
		});

		it('should clean up lock in finally block even if implementation throws', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(false);
			mockSessionHelper.createSession.mockRejectedValue(new Error('Crash'));
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'crash-session',
				role: 'developer',
			});

			expect(result.success).toBe(false);

			// Lock should be cleaned up
			const locks = (service as any).sessionCreationLocks;
			expect(locks.has('crash-session')).toBe(false);
		});

		it('should not lock different session names against each other', async () => {
			// Verify the lock map is keyed by session name
			// Access the private sessionCreationLocks to verify isolation
			const locks = (service as any).sessionCreationLocks;
			expect(locks).toBeInstanceOf(Map);
			expect(locks.size).toBe(0);

			// After a session creation starts, only that session name is locked
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');

			const promise = service.createAgentSession({
				sessionName: 'session-a',
				role: 'developer',
			});

			// While session-a is in progress, the lock should exist for session-a only
			// (We check immediately; the async operation is in flight)
			expect(locks.has('session-a')).toBe(true);
			expect(locks.has('session-b')).toBe(false);

			await promise;

			// After completion, lock is cleared
			expect(locks.has('session-a')).toBe(false);
		});
	});

	describe('terminateAgentSession', () => {
		it('should kill existing session and update status', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			const result = await service.terminateAgentSession('test-session', 'developer');

			expect(result.success).toBe(true);
			expect(mockSessionHelper.killSession).toHaveBeenCalledWith('test-session');
			expect(mockStorageService.updateAgentStatus).toHaveBeenCalledWith(
				'test-session',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
			);
		});

		it('should update status even if session does not exist', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(false);

			const result = await service.terminateAgentSession('test-session', 'developer');

			expect(result.success).toBe(true);
			expect(result.message).toContain('already terminated');
			expect(mockStorageService.updateAgentStatus).toHaveBeenCalledWith(
				'test-session',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
			);
		});

		it('should unregister session from persistence on termination', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			const result = await service.terminateAgentSession('test-session', 'developer');

			expect(result.success).toBe(true);
			const mockPersistence = (sessionModule.getSessionStatePersistence as jest.Mock).mock.results[0]?.value;
			expect(mockPersistence.unregisterSession).toHaveBeenCalledWith('test-session');
		});
	});

	describe('sendMessageToAgent', () => {
		// Helper to create a mock session with configurable onData behavior
		// Timings account for: prompt detection -> message sent -> Enter sent (500ms) -> processing
		const createMockSession = (outputSequence: Array<{ output: string; delayMs: number }>) => {
			return {
				name: 'test-session',
				pid: 1234,
				cwd: '/test',
				onData: jest.fn().mockImplementation((callback: (data: string) => void) => {
					// Emit outputs from sequence at specified delays
					outputSequence.forEach(({ output, delayMs }) => {
						setTimeout(() => callback(output), delayMs);
					});
					return jest.fn(); // unsubscribe function
				}),
				onExit: jest.fn().mockReturnValue(jest.fn()),
				write: jest.fn(),
				resize: jest.fn(),
				kill: jest.fn(),
			};
		};

		it('should send message and verify processing started (prompt gone)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Call 1: pre-send isClaudeAtPrompt — prompt visible
			// Call 2: beforeOutput capture (20 lines)
			// Call 3: 1st interval — processing indicator ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                // beforeOutput capture
				.mockReturnValueOnce('⏺ Processing...\n');  // 1st interval: ⏺ found → success

			const result = await service.sendMessageToAgent('test-session', 'Hello, agent!');

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith('test-session', 'Hello, agent!');
		});

		it('should detect processing indicators as success', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Call 1: pre-send — at prompt
			// Call 2: beforeOutput capture
			// Call 3: 1st interval — ⠋ spinner found → success (even though ❯ is still visible)
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                      // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                      // beforeOutput capture
				.mockReturnValueOnce('❯ \n⠋ loading context\n');  // 1st interval: ⠋ matches PROCESSING → success

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(true);
		});

		it('should succeed via progressive check when prompt disappears on later interval', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Simulates Claude Code taking 2+ seconds to start rendering.
			// Each interval uses 1 capturePane call (checked for processing,
			// then isClaudeAtPrompt, then message-text-stuck).
			// Call 1: pre-send: at prompt
			// Call 2: beforeOutput
			// Call 3: 1st interval — prompt still there, no indicators → wait 1s
			// Call 4: 2nd interval — prompt still there → wait 2s
			// Call 5: 3rd interval — processing indicator ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')               // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')               // beforeOutput
				.mockReturnValueOnce('❯ \n')               // 1st interval: still at prompt
				.mockReturnValueOnce('❯ \n')               // 2nd interval: still at prompt
				.mockReturnValueOnce('⏺ Processing...\n'); // 3rd interval: processing → success

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(true);
		}, 15000);

		it('should NOT declare success from raw output-change alone (pasted text false positive)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Simulates Enter key dropped: message text appears at prompt.
			// isClaudeAtPrompt returns false (❯ Hello world ≠ idle prompt),
			// but the message-text-stuck check catches it — "Hello world"
			// found at bottom of terminal → Enter was dropped, not success.
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				// Call 1 (pre-send): clean prompt → message will be sent
				if (capturePaneCount === 1) return '❯ \n';
				// Call 2 (beforeOutput): clean prompt (baseline)
				if (capturePaneCount === 2) return '❯ \n';
				// All subsequent calls (progressive checks): pasted text at prompt.
				// No processing indicators, isClaudeAtPrompt returns false, but
				// message text "Hello world" found at bottom → stuck, not success.
				return '❯ Hello world\n';
			});

			const result = await service.sendMessageToAgent('test-session', 'Hello world');

			// Should FAIL — message stuck at prompt, not processing
			expect(result.success).toBe(false);
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
		});

		it('should fall through to direct delivery when agent is not at prompt', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// capturePane shows non-prompt content (agent is busy/modal)
			mockSessionHelper.capturePane.mockReturnValue('Some modal text...');

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			// On final attempt, prompt detection failure falls through to direct delivery
			// rather than returning a 502 error
			expect(result.success).toBe(true);
		});

		it('should fail if session does not exist', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(false);

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
		});

		it('should fail if message is empty', async () => {
			const result = await service.sendMessageToAgent('test-session', '');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Message is required');
		});

		it('should fall through to direct delivery when event-driven delivery times out', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Configure session that never shows any recognizable pattern
			const mockSession = {
				name: 'test-session',
				pid: 1234,
				cwd: '/test',
				onData: jest.fn().mockImplementation(() => {
					// Don't emit anything - will cause timeout
					return jest.fn();
				}),
				onExit: jest.fn().mockReturnValue(jest.fn()),
				write: jest.fn(),
				resize: jest.fn(),
				kill: jest.fn(),
			};
			mockSessionHelper.getSession.mockReturnValue(mockSession);
			// IMPORTANT: Return non-prompt output so immediate check fails
			// On final attempt, falls through to direct delivery instead of failing
			mockSessionHelper.capturePane.mockReturnValue('Loading...\nPlease wait');

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			// On final attempt, prompt detection failure falls through to direct delivery
			expect(result.success).toBe(true);
		}, 40000);  // Increase timeout for event-driven retry test
	});

	describe('sendKeyToAgent', () => {
		it('should send key to existing session', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			const result = await service.sendKeyToAgent('test-session', 'Enter');

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendKey).toHaveBeenCalledWith('test-session', 'Enter');
		});

		it('should fail if session does not exist', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(false);

			const result = await service.sendKeyToAgent('test-session', 'Enter');

			expect(result.success).toBe(false);
			expect(result.error).toContain('does not exist');
		});
	});

	describe('checkAgentHealth', () => {
		it('should return active status when session exists', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			const result = await service.checkAgentHealth('test-session', 'developer');

			expect(result.success).toBe(true);
			expect(result.data?.agent.running).toBe(true);
			expect(result.data?.agent.status).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
		});

		it('should return inactive status when session does not exist', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(false);

			const result = await service.checkAgentHealth('test-session', 'developer');

			expect(result.success).toBe(true);
			expect(result.data?.agent.running).toBe(false);
			expect(result.data?.agent.status).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE);
		});

		it('should include timestamp in response', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			const result = await service.checkAgentHealth('test-session');

			expect(result.data?.timestamp).toBeDefined();
			expect(new Date(result.data!.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
		});
	});

	describe('loadRegistrationPrompt (private method)', () => {
		it('should load prompt from file and replace placeholders', async () => {
			const promptTemplate = 'Register as {{ROLE}} with session {{SESSION_ID}} and member {{MEMBER_ID}} using {{AGENT_SKILLS_PATH}}/core/register-self/execute.sh';
			mockReadFile.mockResolvedValue(promptTemplate);

			// Access private method via reflection
			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('dev', 'test-session', 'member-123');

			expect(result).toContain('test-session');
			expect(result).toContain('member-123');
			expect(result).not.toContain('{{AGENT_SKILLS_PATH}}');
			expect(result).toContain('config/skills/agent/core/register-self/execute.sh');
		});

		it('should remove member ID parameter when not provided', async () => {
			const promptTemplate = 'Register {"sessionName": "{{SESSION_ID}}", "memberId": "{{MEMBER_ID}}"}';
			mockReadFile.mockResolvedValue(promptTemplate);

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('orchestrator', 'test-session');

			expect(result).toContain('test-session');
			expect(result).not.toContain('{{MEMBER_ID}}');
		});

		it('should use fallback prompt when file not found', async () => {
			mockReadFile.mockRejectedValue(new Error('File not found'));

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('dev', 'test-session');

			expect(result).toContain('register-self');
			expect(result).toContain('"role":"dev"');
			expect(result).toContain('"sessionName":"test-session"');
		});
	});

	describe('checkAgentRegistration (private method)', () => {
		it('should return true for active orchestrator', async () => {
			mockStorageService.getOrchestratorStatus.mockResolvedValue({
				agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
			} as any);

			const checkAgentRegistration = (service as any).checkAgentRegistration.bind(service);
			const result = await checkAgentRegistration('test-session', 'orchestrator');

			expect(result).toBe(true);
		});

		it('should return false for inactive orchestrator', async () => {
			mockStorageService.getOrchestratorStatus.mockResolvedValue({
				agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
			} as any);

			const checkAgentRegistration = (service as any).checkAgentRegistration.bind(service);
			const result = await checkAgentRegistration('test-session', 'orchestrator');

			expect(result).toBe(false);
		});

		it('should check team member registration in teams.json', async () => {
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [{
					sessionName: 'test-session',
					role: 'developer',
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
				}],
			}] as any);

			const checkAgentRegistration = (service as any).checkAgentRegistration.bind(service);
			const result = await checkAgentRegistration('test-session', 'developer');

			expect(result).toBe(true);
		});

		it('should return false when team member not found', async () => {
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [],
			}] as any);

			const checkAgentRegistration = (service as any).checkAgentRegistration.bind(service);
			const result = await checkAgentRegistration('test-session', 'developer');

			expect(result).toBe(false);
		});
	});

	describe('session state persistence registration', () => {
		it('should register session for persistence after creating a new session', async () => {
			// Ensure session does not exist initially
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)  // Initial check
				.mockReturnValueOnce(true);  // After creation check
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);

			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
				teamId: 'team-123',
			});

			const mockPersistence = (sessionModule.getSessionStatePersistence as jest.Mock).mock.results[0]?.value;
			expect(mockPersistence.registerSession).toHaveBeenCalledWith(
				'test-session',
				expect.objectContaining({
					cwd: '/test/project',
					args: [],
				}),
				'claude-code',
				'developer',
				'team-123',
				undefined
			);
		});

		it('should pass memberId to persistence registration', async () => {
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);

			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
				teamId: 'team-123',
				memberId: 'member-xyz',
			});

			const mockPersistence = (sessionModule.getSessionStatePersistence as jest.Mock).mock.results[0]?.value;
			expect(mockPersistence.registerSession).toHaveBeenCalledWith(
				'test-session',
				expect.objectContaining({
					cwd: '/test/project',
					args: [],
				}),
				'claude-code',
				'developer',
				'team-123',
				'member-xyz'
			);
		});

		it('should register recovered session for persistence', async () => {
			// Session already exists and runtime is running
			mockSessionHelper.sessionExists.mockReturnValue(true);
			mockRuntimeService.detectRuntimeWithCommand.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');
			// Mock capturePane to show processing indicators so sendPromptRobustly succeeds
			mockSessionHelper.capturePane.mockReturnValue('⠋ Thinking... registering agent');

			// Mock successful registration check
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [{
					sessionName: 'test-session',
					role: 'developer',
					agentStatus: 'active',
				}],
			}] as any);

			await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				projectPath: '/test/project',
				teamId: 'team-456',
			});

			const mockPersistence = (sessionModule.getSessionStatePersistence as jest.Mock).mock.results[0]?.value;
			expect(mockPersistence.registerSession).toHaveBeenCalledWith(
				'test-session',
				expect.objectContaining({
					cwd: '/test/project',
				}),
				expect.any(String),
				'developer',
				'team-456',
				undefined
			);
		});

		it('should not fail session creation if persistence registration fails', async () => {
			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register {{SESSION_ID}}');

			// Make persistence throw
			(sessionModule.getSessionStatePersistence as jest.Mock).mockImplementation(() => {
				throw new Error('Persistence unavailable');
			});

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
			});

			// Session creation should still succeed
			expect(result.success).toBe(true);
		});
	});

	describe('session resume via --resume CLI flag', () => {
		it('should inject --resume flag for restored Claude Code sessions with stored session ID', async () => {
			// Mark session as restored with a stored session ID
			(sessionModule.getSessionStatePersistence as jest.Mock).mockReturnValue({
				registerSession: jest.fn(),
				unregisterSession: jest.fn(),
				isSessionRegistered: jest.fn().mockReturnValue(false),
				isRestoredSession: jest.fn().mockReturnValue(true),
				getSessionId: jest.fn().mockReturnValue('abc-123-session-uuid'),
				updateSessionId: jest.fn(),
			});

			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000,
				undefined, // memberId
				RUNTIME_TYPES.CLAUDE_CODE
			);

			// executeRuntimeInitScript should have been called with --resume flag
			const initCalls = mockRuntimeService.executeRuntimeInitScript.mock.calls;
			expect(initCalls.length).toBeGreaterThanOrEqual(1);
			const flags = initCalls[0][2]; // third argument is runtimeFlags
			expect(flags).toContain('--resume');
			expect(flags).toContain('abc-123-session-uuid');
		});

		it('should not inject --resume flag when no stored session ID exists', async () => {
			// Session is restored but no session ID stored
			(sessionModule.getSessionStatePersistence as jest.Mock).mockReturnValue({
				registerSession: jest.fn(),
				unregisterSession: jest.fn(),
				isSessionRegistered: jest.fn().mockReturnValue(false),
				isRestoredSession: jest.fn().mockReturnValue(true),
				getSessionId: jest.fn().mockReturnValue(undefined),
				updateSessionId: jest.fn(),
			});

			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000,
				undefined, // memberId
				RUNTIME_TYPES.CLAUDE_CODE
			);

			// executeRuntimeInitScript should NOT have --resume flag
			const initCalls = mockRuntimeService.executeRuntimeInitScript.mock.calls;
			expect(initCalls.length).toBeGreaterThanOrEqual(1);
			const flags = initCalls[0][2];
			expect(flags).not.toContain('--resume');
		});

		it('should not inject --resume flag for non-restored sessions', async () => {
			// Session is NOT restored (default mock)
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000,
				undefined, // memberId
				RUNTIME_TYPES.CLAUDE_CODE
			);

			// executeRuntimeInitScript should NOT have --resume flag
			const initCalls = mockRuntimeService.executeRuntimeInitScript.mock.calls;
			expect(initCalls.length).toBeGreaterThanOrEqual(1);
			const flags = initCalls[0][2];
			expect(flags).not.toContain('--resume');
		});

		it('should not inject --resume flag for non-Claude runtimes', async () => {
			(sessionModule.getSessionStatePersistence as jest.Mock).mockReturnValue({
				registerSession: jest.fn(),
				unregisterSession: jest.fn(),
				isSessionRegistered: jest.fn().mockReturnValue(false),
				isRestoredSession: jest.fn().mockReturnValue(true),
				getSessionId: jest.fn().mockReturnValue('abc-123-session-uuid'),
				updateSessionId: jest.fn(),
			});

			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			await service.initializeAgentWithRegistration(
				'test-session',
				'developer',
				'/test/path',
				90000,
				undefined, // memberId
				RUNTIME_TYPES.GEMINI_CLI
			);

			// executeRuntimeInitScript should NOT have --resume flag for Gemini
			const initCalls = mockRuntimeService.executeRuntimeInitScript.mock.calls;
			expect(initCalls.length).toBeGreaterThanOrEqual(1);
			const flags = initCalls[0][2];
			expect(flags).not.toContain('--resume');
		});

		it('should succeed even if settings service throws', async () => {
			// Force getSettingsService to throw
			const { getSettingsService } = require('../settings/settings.service.js');
			getSettingsService.mockReturnValueOnce({
				getSettings: jest.fn().mockRejectedValue(new Error('Settings unavailable')),
			});

			(sessionModule.getSessionStatePersistence as jest.Mock).mockReturnValue({
				registerSession: jest.fn(),
				unregisterSession: jest.fn(),
				isSessionRegistered: jest.fn().mockReturnValue(false),
				isRestoredSession: jest.fn().mockReturnValue(true),
				getSessionId: jest.fn().mockReturnValue('abc-123'),
				updateSessionId: jest.fn(),
			});

			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile.mockResolvedValue('Register with {{SESSION_ID}}');

			const result = await service.initializeAgentWithRegistration(
				'test-session',
				'orchestrator',
				'/test/path',
				90000,
				undefined, // memberId
				RUNTIME_TYPES.CLAUDE_CODE
			);

			// Should still succeed — resume flag resolution failure is non-fatal
			expect(result.success).toBe(true);
		});
	});

		describe('waitForRegistration (private method)', () => {
		it('should return true when registration is confirmed', async () => {
			mockStorageService.getOrchestratorStatus.mockResolvedValue({
				agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
			} as any);

			const waitForRegistration = (service as any).waitForRegistration.bind(service);
			const result = await waitForRegistration('test-session', 'orchestrator', 10000);

			expect(result).toBe(true);
		});

		it('should timeout if registration is not confirmed', async () => {
			mockStorageService.getOrchestratorStatus.mockResolvedValue({
				agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
			} as any);

			const waitForRegistration = (service as any).waitForRegistration.bind(service);
			const startTime = Date.now();
			const result = await waitForRegistration('test-session', 'orchestrator', 1000);
			const elapsed = Date.now() - startTime;

			expect(result).toBe(false);
			expect(elapsed).toBeGreaterThanOrEqual(900);
		});
	});

	describe('isMessageStuckAtPrompt (private method)', () => {
		it('should detect CHAT prefix message stuck at prompt', async () => {
			// capturePane shows the message text still on the last line
			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n❯ [CHAT:abc-123] Hello orchestrator\n'
			);

			const isStuck = (service as any).isMessageStuckAtPrompt.bind(service);
			const result = await isStuck('test-session', '[CHAT:abc-123] Hello orchestrator');

			expect(result).toBe(true);
		});

		it('should return false for clean prompt (no message text)', async () => {
			mockSessionHelper.capturePane.mockReturnValue(
				'Previous output\n❯ \n'
			);

			const isStuck = (service as any).isMessageStuckAtPrompt.bind(service);
			const result = await isStuck('test-session', '[CHAT:abc-123] Hello orchestrator');

			expect(result).toBe(false);
		});

		it('should detect plain message without CHAT prefix', async () => {
			mockSessionHelper.capturePane.mockReturnValue(
				'❯ Register as developer with session test\n'
			);

			const isStuck = (service as any).isMessageStuckAtPrompt.bind(service);
			const result = await isStuck('test-session', 'Register as developer with session test');

			expect(result).toBe(true);
		});

		it('should return false when capturePane returns empty output', async () => {
			mockSessionHelper.capturePane.mockReturnValue('');

			const isStuck = (service as any).isMessageStuckAtPrompt.bind(service);
			const result = await isStuck('test-session', 'Hello');

			expect(result).toBe(false);
		});
	});

	describe('stuck Enter detection in message delivery', () => {
		// Helper to create a mock session with configurable onData behavior
		const createMockSession = (outputSequence: Array<{ output: string; delayMs: number }>) => {
			return {
				name: 'test-session',
				pid: 1234,
				cwd: '/test',
				onData: jest.fn().mockImplementation((callback: (data: string) => void) => {
					outputSequence.forEach(({ output, delayMs }) => {
						setTimeout(() => callback(output), delayMs);
					});
					return jest.fn();
				}),
				onExit: jest.fn().mockReturnValue(jest.fn()),
				write: jest.fn(),
				resize: jest.fn(),
				kill: jest.fn(),
			};
		};

		it('should detect stuck message and return false on timeout', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Each attempt: 1 pre-send + 1 beforeOutput + 3 intervals = 5 capturePane calls.
			// All return prompt → stuck after 3 intervals exhausted on every attempt.
			mockSessionHelper.capturePane.mockReturnValue('❯ \n');

			const result = await service.sendMessageToAgent(
				'test-session',
				'[CHAT:abc] Hello orchestrator'
			);

			expect(result.success).toBe(false);
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
		});

		it('should succeed when Enter accepted after retry', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Each attempt: 1 pre-send + 1 beforeOutput + 3 intervals = 5 calls.
			// Attempt 1: calls 1-5 → all prompt → stuck, cleanup
			// Attempt 2: calls 6 (pre-send) + 7 (beforeOutput) → prompt,
			//   call 8 (1st interval) → processing indicator → success
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				if (capturePaneCount <= 7) return '❯ \n';
				return '⏺ Processing...\n';
			});

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(true);
		}, 30000);

		it('should accept when prompt gone on first progressive check (no false negative)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Call 1: pre-send — at prompt
			// Call 2: beforeOutput capture
			// Call 3: 1st interval — ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                // beforeOutput capture
				.mockReturnValueOnce('⏺ Processing...\n');  // 1st interval: processing → success

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(true);
		}, 40000);

		it('should clear leftover input on retry when at prompt', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Each attempt: 1 pre-send + 1 beforeOutput + 3 intervals = 5 calls.
			// Attempt 1: calls 1-5 → all prompt → stuck, cleanup + clearCurrentCommandLine
			// Attempt 2: calls 6-7 → prompt, call 8 → processing → success
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				if (capturePaneCount <= 7) return '❯ \n';
				return '⏺ Processing...\n';
			});

			const result = await service.sendMessageToAgent('test-session', 'Hello stuck message');

			// clearCurrentCommandLine should have been called during retry after stuck detection
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
			// Second attempt succeeds
			expect(result.success).toBe(true);
		}, 30000);

		it('should run retry cleanup on every failed attempt, not just first', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Claude Code: 3 capturePane calls per attempt (pre-send, post-send, re-check)
			// All attempts always show prompt → stuck on every attempt
			mockSessionHelper.capturePane.mockReturnValue('❯ \n');

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(false);
			// clearCurrentCommandLine should be called on every failed attempt
			// With 3 attempts all stuck, expect at least 2 cleanup calls
			// (first attempt skips Ctrl+C but cleanup still runs after stuck detection)
			expect(mockSessionHelper.clearCurrentCommandLine.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('resolveRuntimeFlags (private method)', () => {
		it('should return flags from role skills', async () => {
			// findSkillJsonPath uses access() for existence checks
			mockAccess.mockImplementation((filePath: string) => {
				// chrome-browser found in marketplace
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});
			// readFile handles content reads (role.json + skill.json)
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: ['chrome-browser'],
					}));
				}
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--chrome'] },
					}));
				}
				return Promise.resolve('{}');
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			const flags = await resolveRuntimeFlags('generalist', 'claude-code');

			expect(flags).toEqual(['--chrome']);
		});

		it('should apply skill overrides and exclusions', async () => {
			// All three skills found in agent/core/
			mockAccess.mockImplementation((filePath: string) => {
				if (filePath.includes('agent/core/') && filePath.includes('skill.json')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: ['skill-alpha', 'skill-beta'],
					}));
				}
				if (filePath.includes('agent/core/skill-alpha/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--alpha'] },
					}));
				}
				if (filePath.includes('agent/core/skill-beta/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--beta'] },
					}));
				}
				if (filePath.includes('agent/core/skill-gamma/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--gamma'] },
					}));
				}
				return Promise.resolve('{}');
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			// Exclude skill-alpha, add skill-gamma
			const flags = await resolveRuntimeFlags(
				'generalist', 'claude-code',
				['skill-gamma'],
				['skill-alpha']
			);

			expect(flags).toContain('--gamma');
			expect(flags).toContain('--beta');
			expect(flags).not.toContain('--alpha');
		});

		it('should return empty for non-matching runtime', async () => {
			// chrome-browser found in marketplace
			mockAccess.mockImplementation((filePath: string) => {
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: ['chrome-browser'],
					}));
				}
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--chrome'] },
					}));
				}
				return Promise.resolve('{}');
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			// Query for gemini-cli runtime — chrome-browser's flags are claude-code only
			const flags = await resolveRuntimeFlags('generalist', 'gemini-cli');

			expect(flags).toEqual([]);
		});

		it('should handle missing role config gracefully', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			const flags = await resolveRuntimeFlags('nonexistent-role', 'claude-code');

			expect(flags).toEqual([]);
		});

		it('should handle missing skill config gracefully', async () => {
			// access rejects for all skill paths (default mock)
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: ['nonexistent-skill'],
					}));
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			const flags = await resolveRuntimeFlags('generalist', 'claude-code');

			expect(flags).toEqual([]);
		});

		it('should find skills in marketplace subdirectory via skillOverrides', async () => {
			// chrome-browser found in marketplace, not in core
			mockAccess.mockImplementation((filePath: string) => {
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: [],
					}));
				}
				if (filePath.includes('agent/marketplace/chrome-browser/skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--chrome'] },
					}));
				}
				return Promise.resolve('{}');
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			const flags = await resolveRuntimeFlags(
				'generalist', 'claude-code',
				['chrome-browser'],
			);

			expect(flags).toEqual(['--chrome']);
		});

		it('should deduplicate flags from multiple skills', async () => {
			// Both skills found in agent/core/
			mockAccess.mockImplementation((filePath: string) => {
				if (filePath.includes('agent/core/') && filePath.includes('skill.json')) {
					return Promise.resolve(undefined);
				}
				return Promise.reject(new Error('ENOENT: no such file'));
			});
			mockReadFile.mockImplementation((filePath: string) => {
				if (filePath.includes('role.json')) {
					return Promise.resolve(JSON.stringify({
						assignedSkills: ['skill-a', 'skill-b'],
					}));
				}
				if (filePath.includes('agent/core/') && filePath.includes('skill.json')) {
					return Promise.resolve(JSON.stringify({
						runtime: { runtime: 'claude-code', flags: ['--chrome'] },
					}));
				}
				return Promise.resolve('{}');
			});

			const resolveRuntimeFlags = (service as any).resolveRuntimeFlags.bind(service);
			const flags = await resolveRuntimeFlags('generalist', 'claude-code');

			expect(flags).toEqual(['--chrome']);
		});
	});

	describe('isGeminiInShellMode (private method)', () => {
		let isGeminiInShellMode: (output: string) => boolean;

		beforeEach(() => {
			isGeminiInShellMode = (service as any).isGeminiInShellMode.bind(service);
		});

		it('should return false for normal Gemini CLI prompt', () => {
			expect(isGeminiInShellMode('│ > Type your message... │')).toBe(false);
		});

		it('should return false for empty/null input', () => {
			expect(isGeminiInShellMode('')).toBe(false);
			expect(isGeminiInShellMode(null as any)).toBe(false);
			expect(isGeminiInShellMode(undefined as any)).toBe(false);
		});

		it('should detect shell mode from bordered ! prompt', () => {
			expect(isGeminiInShellMode('│ ! │')).toBe(true);
		});

		it('should detect shell mode from bordered ! prompt with text', () => {
			expect(isGeminiInShellMode('│ ! ls -la │')).toBe(true);
		});

		it('should detect shell mode from stripped ! prompt', () => {
			expect(isGeminiInShellMode('! ')).toBe(true);
		});

		it('should detect shell mode from bare ! character', () => {
			expect(isGeminiInShellMode('!')).toBe(true);
		});

		it('should detect shell mode on last line of multi-line output', () => {
			const output = [
				'Welcome to Gemini CLI',
				'Model: gemini-2.5-pro',
				'│ ! │',
			].join('\n');
			expect(isGeminiInShellMode(output)).toBe(true);
		});

		it('should not detect shell mode from normal > prompt', () => {
			const output = [
				'Welcome to Gemini CLI',
				'│ > Type your message │',
			].join('\n');
			expect(isGeminiInShellMode(output)).toBe(false);
		});
	});

	describe('isClaudeAtPrompt (private method) with Codex runtime', () => {
		let isClaudeAtPrompt: (output: string, runtimeType?: any) => boolean;

		beforeEach(() => {
			isClaudeAtPrompt = (service as any).isClaudeAtPrompt.bind(service);
		});

		it('should detect Codex prompt with `›` indicator', () => {
			const output = [
				'OpenAI Codex (v0.104.0)',
				'87% context left',
				'› Type your message or @path/to/file',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CODEX_CLI)).toBe(true);
		});

		it('should not treat Claude quote line as Codex prompt', () => {
			const output = [
				'Assistant response:',
				'> quoted markdown line',
				'More text',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CODEX_CLI)).toBe(false);
		});
	});

	describe('isClaudeAtPrompt — prompt detection and busy indicators', () => {
		let isClaudeAtPrompt: (output: string, runtimeType?: any) => boolean;

		beforeEach(() => {
			isClaudeAtPrompt = (service as any).isClaudeAtPrompt.bind(service);
		});

		it('should detect ❯ prompt with status bar below as idle', () => {
			const output = [
				'Previous output text',
				'────────────────────────────────────────',
				'❯',
				'────────────────────────────────────────',
				'⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should detect ❯❯ bypass permissions prompt as idle', () => {
			const output = [
				'Previous output',
				'❯❯ bypass permissions on (shift+tab to cycle)',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should detect single ❯ on its own line', () => {
			const output = [
				'Some previous output',
				'────────────────────────────────────────',
				'❯',
				'────────────────────────────────────────',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(true);
		});

		it('should return false when busy with esc to interrupt and no ❯ prompt', () => {
			// Agent is processing — no ❯ prompt visible, status bar shows "esc to interrupt"
			const output = [
				'Tool output line 1',
				'Tool output line 2',
				'Tool output line 3',
				'────────────────────────────────────────',
				'────────────────────────────────────────',
			].join('\n');

			// No prompt, no processing indicators → returns false
			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});

		it('should return false when processing indicators (⏺) are present', () => {
			const output = [
				'⏺ Writing Edit...',
				'  Updated 3 lines',
				'More output',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});

		it('should return false when spinner chars are present', () => {
			const output = [
				'Some output',
				'⠋ Thinking...',
			].join('\n');

			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});

		it('should return false when "esc to interrupt" is in terminal output', () => {
			const output = [
				'Some tool output...',
				'more output here',
				'⏵⏵ bypass permissions on · esc to interrupt · ctrl+t',
			].join('\n');

			// No ❯ prompt visible + esc to interrupt = busy
			expect(isClaudeAtPrompt(output, RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});

		it('should return false for empty output', () => {
			expect(isClaudeAtPrompt('', RUNTIME_TYPES.CLAUDE_CODE)).toBe(false);
		});
	});

	describe('sendMessageWithRetry — busy agent protection', () => {
		it('should not force-deliver when agent is busy (low idle time)', async () => {
			// Simulate agent actively processing — PTY output within the busy threshold
			mockGetIdleTimeMs.mockReturnValue(1000); // 1s idle < 5s threshold = busy

			// No prompt visible (agent is working)
			mockSessionHelper.capturePane.mockReturnValue('Tool output line 1\nTool output line 2');

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(false);
			// Should not have called sendMessage (no force delivery when busy)
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('should not force-deliver when idle time is zero (active output)', async () => {
			// Simulate agent with very recent PTY output
			mockGetIdleTimeMs.mockReturnValue(0); // Just produced output = busy

			mockSessionHelper.capturePane.mockReturnValue('⏺ Running Bash command...\n  $ npm test');

			const result = await service.sendMessageToAgent('test-session', 'Hello');

			expect(result.success).toBe(false);
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});
	});

	describe('escapeGeminiShellMode (private method)', () => {
		let escapeGeminiShellMode: (sessionName: string, helper: any) => Promise<boolean>;

		beforeEach(() => {
			escapeGeminiShellMode = (service as any).escapeGeminiShellMode.bind(service);
		});

		it('should send Escape and return true when shell mode exits', async () => {
			// First capturePane: still in shell mode (but isGeminiInShellMode will see normal prompt)
			mockSessionHelper.capturePane.mockReturnValue('│ > Type your message │');

			const result = await escapeGeminiShellMode('crewly-orc', mockSessionHelper);

			expect(result).toBe(true);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalledWith('crewly-orc');
		});

		it('should retry and return false after max attempts if still in shell mode', async () => {
			// capturePane always shows shell mode
			mockSessionHelper.capturePane.mockReturnValue('│ ! │');

			const result = await escapeGeminiShellMode('crewly-orc', mockSessionHelper);

			expect(result).toBe(false);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalledTimes(3); // MAX_ESCAPE_ATTEMPTS
		});
	});

	describe('sendMessageToAgent with Gemini shell mode', () => {
		beforeEach(() => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
		});

		it('should detect and escape shell mode before sending message to Gemini CLI', async () => {
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				// Call 1 (prompt check in sendMessageWithRetry): shell mode detected
				if (callCount === 1) return '│ ! │';
				// Call 2 (escapeGeminiShellMode verification): normal mode now
				if (callCount === 2) return '│ > Type your message │';
				// Call 3 (before-send snapshot for TUI output-change detection)
				if (callCount === 3) return '│ > │';
				// Call 4 (isTextStuckAtTuiPrompt check): no message stuck at prompt
				if (callCount === 4) return '│ > │\n⠋ Thinking...';
				// Call 5+ (afterOutput TUI Phase 2 check): processing output changed
				return '⠋ Thinking about your request...\nReading files...';
			});

			const result = await service.sendMessageToAgent(
				'crewly-orc',
				'Hello!',
				RUNTIME_TYPES.GEMINI_CLI
			);

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalled();
		});

		it('should not attempt shell mode escape for Claude Code runtime', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ ')              // pre-send: prompt check
				.mockReturnValueOnce('❯ ')              // beforeOutput capture
				.mockReturnValueOnce('⏺ Processing');   // 1st interval: ⏺ found → success

			const result = await service.sendMessageToAgent(
				'crewly-orc',
				'Hello',
				RUNTIME_TYPES.CLAUDE_CODE
			);

			expect(result.success).toBe(true);
			// sendEscape should NOT have been called for shell mode escape
			// (it might be called for other reasons like stuck message retry, but not before message send)
			expect(mockSessionHelper.sendEscape).not.toHaveBeenCalled();
		});
	});

	describe('trackSentMessage', () => {
		it('should track a message with extracted snippet', () => {
			service.trackSentMessage('test-session', 'Hello, this is a test message for tracking');

			const tracker = (service as any).sentMessageTracker;
			expect(tracker.has('test-session')).toBe(true);
			const entries = tracker.get('test-session');
			expect(entries).toHaveLength(1);
			expect(entries[0].snippet).toBe('Hello, this is a test message for tracking');
			expect(entries[0].recovered).toBe(false);
		});

		it('should strip [CHAT:uuid] prefix when extracting snippet', () => {
			service.trackSentMessage('test-session', '[CHAT:abc-123] Hello, this is a chat message for tracking');

			const tracker = (service as any).sentMessageTracker;
			const entries = tracker.get('test-session');
			expect(entries[0].snippet).toBe('Hello, this is a chat message for tracking');
		});

		it('should normalize newlines in snippet for terminal comparison', () => {
			// Enhanced scheduler messages contain \n from addContinuationInstructions().
			// The snippet must have newlines collapsed to spaces so includes() works
			// when comparing against join(' ')-ed terminal output.
			const enhancedMessage = '🔄 [SCHEDULED CHECK-IN - Please continue previous work after this]\n\nCheck on Emily: task progress';
			service.trackSentMessage('test-session', enhancedMessage);

			const tracker = (service as any).sentMessageTracker;
			const entries = tracker.get('test-session');
			// Newlines should be collapsed to single spaces
			expect(entries[0].snippet).not.toContain('\n');
			expect(entries[0].snippet).toContain('this] Check on Emi');
		});

		it('should skip messages with snippet shorter than 10 chars', () => {
			service.trackSentMessage('test-session', 'Hi');

			const tracker = (service as any).sentMessageTracker;
			expect(tracker.has('test-session')).toBe(false);
		});

		it('should limit snippet to 80 chars', () => {
			const longMessage = 'A'.repeat(200);
			service.trackSentMessage('test-session', longMessage);

			const tracker = (service as any).sentMessageTracker;
			const entries = tracker.get('test-session');
			expect(entries[0].snippet.length).toBe(80);
		});

		it('should clean up entries older than 5 minutes', () => {
			const tracker = (service as any).sentMessageTracker;
			// Manually add an old entry
			tracker.set('test-session', [{
				snippet: 'old message that should be cleaned up',
				sentAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
				recovered: false,
			}]);

			// Track a new message — should clean up the old one
			service.trackSentMessage('test-session', 'New message for tracking purposes');

			const entries = tracker.get('test-session');
			expect(entries).toHaveLength(1);
			expect(entries[0].snippet).toBe('New message for tracking purposes');
		});

		it('should start the stuck message detector', () => {
			service.trackSentMessage('test-session', 'Hello, this is a message for tracking');

			const timer = (service as any).stuckMessageDetectorTimer;
			expect(timer).not.toBeNull();

			// Clean up the timer
			service.stopStuckMessageDetector();
		});
	});

	describe('scanForStuckMessages (tracked-message scanning)', () => {
		beforeEach(() => {
			// Ensure session helper is available for scanning
			(service as any)._sessionHelper = mockSessionHelper;
			mockSessionHelper.sessionExists.mockReturnValue(true);
		});

		it('should detect tracked message stuck at bottom of terminal and press Enter', async () => {
			const tracker = (service as any).sentMessageTracker;
			const snippet = 'This scheduled check-in message is stuck';
			tracker.set('test-session', [{
				snippet,
				sentAt: Date.now() - 20000, // 20s ago (> 15s threshold)
				recovered: false,
			}]);

			// Terminal shows the message at the bottom (stuck)
			mockSessionHelper.capturePane.mockReturnValue(
				'Some previous output\n' +
				'More output\n' +
				`❯ ${snippet}\n`
			);

			// Trigger the scan
			await (service as any).scanForStuckMessages();

			// Should have pressed Enter twice (primary + backup)
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('test-session');
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(2);

			// Entry should be marked as recovered
			const entries = tracker.get('test-session');
			expect(entries[0].recovered).toBe(true);
		});

		it('should detect stuck message when terminal has multi-line pasted text with empty lines', async () => {
			// This tests the exact scenario: enhanced scheduler message contains \n\n,
			// which creates empty lines in the terminal. The scanner must still detect
			// the normalized snippet in the space-joined bottom text.
			const tracker = (service as any).sentMessageTracker;
			// Snippet is already normalized (trackSentMessage does this)
			const snippet = '🔄 [SCHEDULED CHECK-IN - Please continue previous work after this] Check on Emily';
			tracker.set('test-session', [{
				snippet,
				sentAt: Date.now() - 20000,
				recovered: false,
			}]);

			// Terminal shows multi-line pasted text with empty lines between sections
			mockSessionHelper.capturePane.mockReturnValue(
				'Previous response output\n' +
				'❯ 🔄 [SCHEDULED CHECK-IN - Please continue previous work after this]\n' +
				'\n' + // empty line from \n\n in original message
				'Check on Emily: 查看排期圈未回复评论任务进度\n' +
				'\n' +
				'⚡ IMPORTANT: After responding to this check-in...\n' +
				'❯❯ bypass permissions on (shift+tab to cycle)\n'
			);

			await (service as any).scanForStuckMessages();

			// Should detect and press Enter
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('test-session');
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledTimes(2);

			const entries = tracker.get('test-session');
			expect(entries[0].recovered).toBe(true);
		});

		it('should NOT act on messages younger than 15 seconds', async () => {
			const tracker = (service as any).sentMessageTracker;
			tracker.set('test-session', [{
				snippet: 'This message was just sent recently',
				sentAt: Date.now() - 5000, // 5s ago (< 15s threshold)
				recovered: false,
			}]);

			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n' +
				'❯ This message was just sent recently\n'
			);

			await (service as any).scanForStuckMessages();

			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
		});

		it('should NOT act on already-recovered messages', async () => {
			const tracker = (service as any).sentMessageTracker;
			tracker.set('test-session', [{
				snippet: 'Previously recovered stuck message text',
				sentAt: Date.now() - 30000,
				recovered: true, // Already recovered
			}]);

			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n' +
				'❯ Previously recovered stuck message text\n'
			);

			await (service as any).scanForStuckMessages();

			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
		});

		it('should NOT act when message text is not at bottom of terminal', async () => {
			const tracker = (service as any).sentMessageTracker;
			tracker.set('test-session', [{
				snippet: 'This message was successfully delivered',
				sentAt: Date.now() - 20000,
				recovered: false,
			}]);

			// Terminal shows different content (message was accepted and processed)
			mockSessionHelper.capturePane.mockReturnValue(
				'Agent is working...\n' +
				'⠋ Thinking about the task\n'
			);

			await (service as any).scanForStuckMessages();

			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
		});

		it('should clean up entries for sessions that no longer exist', async () => {
			const tracker = (service as any).sentMessageTracker;
			tracker.set('dead-session', [{
				snippet: 'Message to dead session for testing',
				sentAt: Date.now() - 20000,
				recovered: false,
			}]);

			mockSessionHelper.sessionExists.mockImplementation((name: string) => name !== 'dead-session');

			await (service as any).scanForStuckMessages();

			expect(tracker.has('dead-session')).toBe(false);
		});
	});
});
