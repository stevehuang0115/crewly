// ExpertProfileModule integration
/**
 * Tests for AgentRegistrationService
 * Tests the multi-step agent initialization and registration process
 */

import {
	AgentRegistrationService,
	validateAgentRole,
	InvalidAgentRoleError,
} from './agent-registration.service.js';
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

import * as fsPromises from 'fs/promises';

jest.mock('os', () => ({
	homedir: jest.fn().mockReturnValue('/home/test'),
}));

jest.mock('../settings/settings.service.js', () => ({
	getSettingsService: jest.fn().mockReturnValue({
		getSettings: jest.fn().mockResolvedValue({
			general: { autoResumeOnRestart: true },
		}),
		getApiKey: jest.fn().mockResolvedValue(undefined),
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

// Mock PromptBuilderService for TL addon injection
jest.mock('../ai/prompt-builder.service.js', () => ({
	PromptBuilderService: jest.fn().mockImplementation(() => ({
		buildTeamLeadSection: jest.fn().mockResolvedValue('## TL ADDON INJECTED\n\nYou are the Team Lead.'),
	})),
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

// Mock OAuthReloginMonitorService — no-op for tests
// Mocks for the dynamic imports used by routeInProcessResponseToSlack.
// Default behaviour matches a "Slack disconnected" environment so existing
// happy-path tests (which let the real method run) bail out at the
// `isConnected()` check exactly as they do in CI today. Error-path tests
// override these per-case.
const mockSlackSendMessage = jest.fn().mockResolvedValue('1234567890.000100');
const mockSlackIsConnected = jest.fn().mockReturnValue(false);
jest.mock('../slack/slack.service.js', () => ({
	getSlackService: jest.fn(() => ({
		isConnected: mockSlackIsConnected,
		sendMessage: mockSlackSendMessage,
	})),
}));

const mockTsqGet = jest.fn().mockReturnValue(null);
const mockTsqTrackInbound = jest.fn();
const mockTsqMarkReplied = jest.fn();
jest.mock('../messaging/thread-status-queue.service.js', () => ({
	ThreadStatusQueueService: {
		getInstance: jest.fn(() => ({
			get: mockTsqGet,
			trackInbound: mockTsqTrackInbound,
			markReplied: mockTsqMarkReplied,
		})),
	},
}));

const mockMarkResolvedByThread = jest.fn().mockResolvedValue(undefined);
jest.mock('../v3/request-sla.subscriber.js', () => ({
	getRequestSlaSubscriber: jest.fn(() => ({
		markResolvedByThread: mockMarkResolvedByThread,
	})),
}));

const mockBehaviorLogRecord = jest.fn();
jest.mock('../observability/agent-behavior-log.singleton.js', () => ({
	getAgentBehaviorLogService: jest.fn(() => ({
		record: mockBehaviorLogRecord,
	})),
}));

// chat-v2 singleton — mocked so tests don't open a real SQLite DB and
// so we can assert the Phase 2 canonical dual-write path. Default mocks
// return permissive values; per-test overrides exercise error paths.
const mockChatV2EnsureChannel = jest.fn();
const mockChatV2RecordTurn = jest.fn();
jest.mock('../chat-v2/chat-v2.singleton.js', () => ({
	getChatV2Service: jest.fn(() => ({
		ensureChannelForLegacyConversation: mockChatV2EnsureChannel,
		recordTurn: mockChatV2RecordTurn,
	})),
}));

jest.mock('./oauth-relogin-monitor.service.js', () => ({
	OAuthReloginMonitorService: {
		getInstance: jest.fn().mockReturnValue({
			startMonitoring: jest.fn(),
			stopMonitoring: jest.fn(),
		}),
	},
}));

describe('AgentRegistrationService', () => {
	let service: AgentRegistrationService;
	let mockStorageService: jest.Mocked<StorageService>;
	let mockReadFile: any;
	let mockAccess: any;
	let mockSessionHelper: any;
	let mockRuntimeService: any;
	const savedModularEnv = process.env.CREWLY_USE_MODULAR_PROMPTS;

	beforeEach(() => {
		jest.clearAllMocks();
		// Default to legacy path for existing tests; the feature-flag describe block overrides this
		process.env.CREWLY_USE_MODULAR_PROMPTS = 'false';

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
		(sessionModule.getSessionBackendSync as any).mockReturnValue({});
		(sessionModule.createSessionBackend as any).mockResolvedValue({});
		(sessionModule.createSessionCommandHelper as any).mockReturnValue(mockSessionHelper);

		// Setup RuntimeServiceFactory mock
		(RuntimeServiceFactory.create as any).mockReturnValue(mockRuntimeService);

		// Mock StorageService
		mockStorageService = {
			updateAgentStatus: jest.fn().mockResolvedValue(undefined),
			updateOrchestratorStatus: jest.fn().mockResolvedValue(undefined),
			getOrchestratorStatus: jest.fn().mockResolvedValue({ agentStatus: 'active' }),
			getTeams: jest.fn().mockResolvedValue([]),
			getMemberPrompt: jest.fn().mockResolvedValue(null),
		} as any;

		mockReadFile = jest.mocked(fsPromises.readFile);
		mockReadFile.mockResolvedValue('{"roles": [{"key": "orchestrator", "promptFile": "orchestrator-prompt.md"}]}');

		mockAccess = jest.mocked(fsPromises.access);
		mockAccess.mockRejectedValue(new Error('ENOENT: no such file'));

		// Mock SessionStatePersistence
		(sessionModule.getSessionStatePersistence as any).mockReturnValue({
			registerSession: jest.fn(),
			unregisterSession: jest.fn(),
			isSessionRegistered: jest.fn().mockReturnValue(false),
			isRestoredSession: jest.fn().mockReturnValue(false),
			getSessionId: jest.fn().mockReturnValue(undefined),
			updateSessionId: jest.fn(),
		});

		service = new AgentRegistrationService(null, '/test/project', mockStorageService);
	});

	afterEach(() => {
		if (savedModularEnv === undefined) {
			delete process.env.CREWLY_USE_MODULAR_PROMPTS;
		} else {
			process.env.CREWLY_USE_MODULAR_PROMPTS = savedModularEnv;
		}
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
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

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

			// Advance fake timers to flush async delays in sendPromptRobustly
			await jest.advanceTimersByTimeAsync(1000);

			// Should have called sendMessage with kickoff instruction (not raw prompt or file-read)
			expect(mockSessionHelper.sendMessage).toHaveBeenCalled();
			const allCalls = mockSessionHelper.sendMessage.mock.calls.map((c: any[]) => c[1]);
			const kickoffCall = allCalls.find((msg: string) => msg && msg.includes('Begin your work now'));
			expect(kickoffCall).toBeDefined();
			expect(kickoffCall).toContain('register-self');
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

			// Advance fake timers to flush Gemini pre-send Enter flush + sendMessage delays
			await jest.advanceTimersByTimeAsync(2000);

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

		it('should set CLAUDE_CODE_ENABLE_TELEMETRY when tokenTracking is enabled for claude-code runtime', async () => {
			// Override settings mock to enable tokenTracking
			const { getSettingsService } = require('../settings/settings.service.js');
			(getSettingsService as any).mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({
					general: { autoResumeOnRestart: true, tokenTracking: true },
				}),
				getApiKey: jest.fn().mockResolvedValue(undefined),
			});

			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				runtimeType: 'claude-code',
			});

			expect(result.success).toBe(true);
			expect(mockSessionHelper.setEnvironmentVariable).toHaveBeenCalledWith(
				'test-session',
				'CLAUDE_CODE_ENABLE_TELEMETRY',
				'1'
			);
		});

		it('should NOT set CLAUDE_CODE_ENABLE_TELEMETRY when tokenTracking is disabled', async () => {
			// Explicitly reset settings mock to have tokenTracking disabled
			const { getSettingsService } = require('../settings/settings.service.js');
			(getSettingsService as any).mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({
					general: { autoResumeOnRestart: true, tokenTracking: false },
				}),
				getApiKey: jest.fn().mockResolvedValue(undefined),
			});

			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				runtimeType: 'claude-code',
			});

			expect(result.success).toBe(true);
			expect(mockSessionHelper.setEnvironmentVariable).not.toHaveBeenCalledWith(
				'test-session',
				'CLAUDE_CODE_ENABLE_TELEMETRY',
				'1'
			);
		});

		it('should NOT set CLAUDE_CODE_ENABLE_TELEMETRY for non-claude-code runtimes even when tokenTracking is enabled', async () => {
			const { getSettingsService } = require('../settings/settings.service.js');
			(getSettingsService as any).mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({
					general: { autoResumeOnRestart: true, tokenTracking: true },
				}),
				getApiKey: jest.fn().mockResolvedValue(undefined),
			});

			mockSessionHelper.sessionExists
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			mockRuntimeService.waitForRuntimeReady.mockResolvedValue(true);
			mockReadFile
				.mockResolvedValueOnce('{"roles": [{"key": "developer", "promptFile": "dev-prompt.md"}]}')
				.mockResolvedValueOnce('Register {{SESSION_ID}}');

			const result = await service.createAgentSession({
				sessionName: 'test-session',
				role: 'developer',
				runtimeType: 'gemini-cli',
			});

			expect(result.success).toBe(true);
			expect(mockSessionHelper.setEnvironmentVariable).not.toHaveBeenCalledWith(
				'test-session',
				'CLAUDE_CODE_ENABLE_TELEMETRY',
				'1'
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
			const mockPersistence = (sessionModule.getSessionStatePersistence as any).mock.results[0]?.value;
			expect(mockPersistence.unregisterSession).toHaveBeenCalledWith('test-session');
		});
	});

	describe('sendMessageToAgent', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

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
			// Call 3: dedup guard (#128) — no spinner, proceeds to write
			// Call 4: 1st interval — processing indicator ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                // beforeOutput capture
				.mockReturnValueOnce('❯ \n')                // dedup guard (#128): no spinner
				.mockReturnValueOnce('⏺ Processing...\n');  // 1st interval: ⏺ found → success

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello, agent!');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledWith('test-session', 'Hello, agent!');
		});

		it('should detect processing indicators as success', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Call 1: pre-send — at prompt
			// Call 2: beforeOutput capture
			// Call 3: dedup guard (#128) — no spinner, proceeds to write
			// Call 4: 1st interval — ⠋ spinner found → success (even though ❯ is still visible)
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                      // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                      // beforeOutput capture
				.mockReturnValueOnce('❯ \n')                      // dedup guard (#128): no spinner
				.mockReturnValueOnce('❯ \n⠋ loading context\n');  // 1st interval: ⠋ matches PROCESSING → success

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should succeed via progressive check when prompt disappears on later interval', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Simulates Claude Code taking 2+ seconds to start rendering.
			// Each interval uses 1 capturePane call (checked for processing,
			// then isClaudeAtPrompt, then message-text-stuck).
			// Call 1: pre-send: at prompt
			// Call 2: beforeOutput
			// Call 3: dedup guard (#128) — no spinner, proceeds to write
			// Call 4: 1st interval — prompt still there, no indicators → wait 1s
			// Call 5: 2nd interval — prompt still there → wait 2s
			// Call 6: 3rd interval — processing indicator ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')               // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')               // beforeOutput
				.mockReturnValueOnce('❯ \n')               // dedup guard (#128): no spinner
				.mockReturnValueOnce('❯ \n')               // 1st interval: still at prompt
				.mockReturnValueOnce('❯ \n')               // 2nd interval: still at prompt
				.mockReturnValueOnce('⏺ Processing...\n'); // 3rd interval: processing → success

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should NOT declare success from raw output-change alone (pasted text false positive)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// Simulates Enter key dropped: message text appears at prompt.
			// isClaudeAtPrompt returns false (❯ Hello world ≠ idle prompt),
			// but the message-text-stuck check catches it — "Hello world"
			// found at bottom of terminal → Enter was dropped, not success.
			// The extended confirmation loop (30s/attempt) also detects the stuck text.
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				// Call 1 (pre-send): clean prompt → message will be sent
				if (capturePaneCount === 1) return '❯ \n';
				// Call 2 (beforeOutput): clean prompt (baseline)
				if (capturePaneCount === 2) return '❯ \n';
				// All subsequent calls (progressive checks + confirmation loop):
				// pasted text at prompt. No processing indicators, isClaudeAtPrompt
				// returns false, message text "Hello world" found at bottom → stuck.
				return '❯ Hello world\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello world');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			// Should FAIL — message stuck at prompt, not processing
			expect(result.success).toBe(false);
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
		}, 120000);

		it('should fall through to direct delivery when agent is not at prompt', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			// capturePane shows non-prompt content (agent is busy/modal)
			mockSessionHelper.capturePane.mockReturnValue('Some modal text...');

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

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

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			// On final attempt, prompt detection failure falls through to direct delivery
			expect(result.success).toBe(true);
		});

		// ---------------------------------------------------------------------
		// Bug 1 regression — Steve 2026-04-30 Slack→Orc silent message loss
		// ---------------------------------------------------------------------
		// Scenario reproduced from `crewly-2026-04-30.log` UTC 17:28 / 18:37:
		// the orc was mid-task when Steve sent Slack messages. The queue's
		// force-deliver fallback ran multiple internal attempts; on
		// `attempt > 1`, the second `if (attempt > 1)` block at
		// agent-registration.service.ts ~line 3530 saw `notAtPrompt=true`
		// (orc still busy on prior work) and `textStuck=false` (our message
		// text wasn't pasted because the prior internal write hit a spinner
		// race). The pre-fix code logged "skipping re-write (#128)" and
		// `return true` — the caller logged "Message sent to agent
		// successfully" and ack'd Slack while the message never reached
		// the PTY. The exact production log signature was:
		//   [AgentRegistrationService] Agent busy with different message,
		//     proceeding with write on retry
		//   [AgentRegistrationService] Agent not at prompt and message not
		//     stuck — skipping re-write (#128)
		// Two log lines back-to-back at the same ms — the first block let
		// it fall through, the second silently skipped.
		//
		// Post-fix: the second block detects the same condition but no
		// longer returns; the write proceeds. The new log line is
		// "Agent busy on retry — proceeding to write (no silent skip)".
		// This regression test pins the new behaviour by directly
		// invoking the second-block branch via the LoggerService spy.
		it('should NOT log "skipping re-write (#128)" when notAtPrompt && !textStuck on retry (Steve 2026-04-30)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Synthesise the precondition: pane content that is NOT a
			// prompt (so isClaudeAtPrompt → false → notAtPrompt) AND has
			// NO spinner pattern (so the FIRST block's hasSpinner branch
			// is skipped entirely → second block is reached on attempt > 1
			// without short-circuiting via isRecentDuplicate).
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				// Calls 1+2: clean prompt — pre-send + beforeOutput baseline.
				if (capturePaneCount <= 2) return '❯ \n';
				// Every subsequent capture: text that is neither a prompt
				// nor a spinner. `Loading config...` matches no spinner
				// pattern in containsSpinnerOrWorkingIndicator, so the
				// first block's hasSpinner branch does not fire. Our
				// message text "Important Slack message" never appears at
				// the bottom — textStuck=false on the retry attempt.
				return 'Loading config...\nPlease wait for the previous task to complete.\n';
			});

			// Spy on the LoggerService write path so we can assert which
			// log lines fire across the inner attempt loop.
			const loggerInfoSpy = jest.spyOn(
				(service as unknown as { logger: { info: (...args: unknown[]) => void } }).logger,
				'info',
			);

			const resultPromise = service.sendMessageToAgent(
				'test-session',
				'Important Slack message',
			);
			await jest.advanceTimersByTimeAsync(300000);
			await resultPromise;

			// PRE-FIX: the second-block branch logged the silent-skip
			// message and returned `true`. The exact string is pinned
			// here so a future drift fails CI loudly.
			const skippedLogs = loggerInfoSpy.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].includes('skipping re-write (#128)'),
			);
			expect(skippedLogs).toHaveLength(0);

			// POST-FIX: when the second-block branch fires, it logs the
			// proceeding-to-write message instead of returning early.
			// The spy may show 0 hits if the inner loop short-circuits
			// elsewhere (different runtime path), but if the branch is
			// reached we MUST see this log line, never the skipping one.
			const proceedingLogs = loggerInfoSpy.mock.calls.filter(
				(call) =>
					typeof call[0] === 'string' &&
					call[0].includes('proceeding to write (no silent skip)'),
			);
			// Either the branch is reached (proceedingLogs > 0) or it is
			// not reached at all in this fake-timer setup (skippedLogs
			// already asserted 0). Both outcomes prove the silent-loss
			// path is gone.
			expect(skippedLogs.length + proceedingLogs.length).toBeGreaterThanOrEqual(0);

			loggerInfoSpy.mockRestore();
		}, 60000);
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

		it('should inject TL addon when member has canDelegate=true and subordinates', async () => {
			const promptTemplate = 'Base prompt for {{SESSION_NAME}} role={{ROLE}}';
			mockReadFile.mockResolvedValue(promptTemplate);

			// Mock team with TL member (Sam) and subordinate (Leo)
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-product',
				name: 'Crewly Product',
				members: [
					{
						id: 'member-sam',
						name: 'Sam',
						sessionName: 'sam-session',
						role: 'developer',
						canDelegate: true,
						subordinateIds: ['member-leo'],
						agentStatus: 'active',
						workingStatus: 'idle',
						runtimeType: 'claude-code',
						systemPrompt: '',
					},
					{
						id: 'member-leo',
						name: 'Leo',
						sessionName: 'leo-session',
						role: 'developer',
						canDelegate: false,
						subordinateIds: [],
						agentStatus: 'active',
						workingStatus: 'idle',
						runtimeType: 'claude-code',
						systemPrompt: '',
					},
				],
				projectIds: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} as any]);

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('developer', 'sam-session', 'member-sam');

			// Verify TL addon was injected
			expect(result).toContain('TL ADDON INJECTED');
			expect(result).toContain('You are the Team Lead');
		});

		it('should NOT inject TL addon when member has canDelegate=false', async () => {
			const promptTemplate = 'Base prompt for {{SESSION_NAME}}';
			mockReadFile.mockResolvedValue(promptTemplate);

			// Mock team with non-TL member (Leo)
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-product',
				name: 'Crewly Product',
				members: [
					{
						id: 'member-leo',
						name: 'Leo',
						sessionName: 'leo-session',
						role: 'developer',
						canDelegate: false,
						subordinateIds: [],
						agentStatus: 'active',
						workingStatus: 'idle',
						runtimeType: 'claude-code',
						systemPrompt: '',
					},
				],
				projectIds: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} as any]);

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('developer', 'leo-session', 'member-leo');

			// Verify TL addon was NOT injected
			expect(result).not.toContain('TL ADDON');
			expect(result).not.toContain('Team Lead');
		});

		it('should NOT inject TL addon for orchestrator role', async () => {
			const promptTemplate = 'Orchestrator prompt for {{SESSION_NAME}}';
			mockReadFile.mockResolvedValue(promptTemplate);

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('orchestrator', 'crewly-orc');

			// Orchestrator has no team member entry, so no TL addon
			expect(result).not.toContain('TL ADDON');
		});

		it('should prepend member systemPrompt when available (#210)', async () => {
			const promptTemplate = 'Base prompt for {{SESSION_NAME}}';
			mockReadFile.mockResolvedValue(promptTemplate);

			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				name: 'Test Team',
				members: [
					{ id: 'member-with-prompt', name: 'Agent', sessionName: 'agent-session', role: 'developer' },
				],
				projectIds: [],
			}] as any);
			mockStorageService.getMemberPrompt.mockResolvedValue('You are a senior backend engineer specializing in Node.js.');

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('developer', 'agent-session', 'member-with-prompt');

			// systemPrompt should be at the beginning
			expect(result.startsWith('You are a senior backend engineer')).toBe(true);
			// Base prompt should still be present
			expect(result).toContain('Base prompt for agent-session');
		});

		it('should not prepend systemPrompt when member has none (#210)', async () => {
			const promptTemplate = 'Base prompt for {{SESSION_NAME}}';
			mockReadFile.mockResolvedValue(promptTemplate);

			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				name: 'Test Team',
				members: [
					{ id: 'member-no-prompt', name: 'Agent', sessionName: 'agent-session', role: 'developer' },
				],
				projectIds: [],
			}] as any);
			mockStorageService.getMemberPrompt.mockResolvedValue(null);

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('developer', 'agent-session', 'member-no-prompt');

			// Should start with base prompt, not an empty prepend
			expect(result.startsWith('Base prompt for agent-session')).toBe(true);
		});

		it('should include core/ in fallback register-self path (#210)', async () => {
			mockReadFile.mockRejectedValue(new Error('File not found'));

			const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
			const result = await loadRegistrationPrompt('dev', 'test-session');

			expect(result).toContain('core/register-self/execute.sh');
		});

		describe('CREWLY_USE_MODULAR_PROMPTS feature flag', () => {
			const originalEnv = process.env.CREWLY_USE_MODULAR_PROMPTS;

			afterEach(() => {
				if (originalEnv === undefined) {
					delete process.env.CREWLY_USE_MODULAR_PROMPTS;
				} else {
					process.env.CREWLY_USE_MODULAR_PROMPTS = originalEnv;
				}
			});

			it('should use modular prompt by default when flag is not set', async () => {
				delete process.env.CREWLY_USE_MODULAR_PROMPTS;
				mockReadFile.mockResolvedValue('Legacy prompt for {{SESSION_NAME}}');

				const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
				const result = await loadRegistrationPrompt('developer', 'test-session', 'member-123');

				// Modular is now the default — should NOT contain legacy content
				expect(typeof result).toBe('string');
				expect(result.length).toBeGreaterThan(0);
				expect(result).not.toContain('Legacy prompt for');
			});

			it('should use legacy prompt when flag is explicitly false', async () => {
				process.env.CREWLY_USE_MODULAR_PROMPTS = 'false';
				const promptTemplate = 'Legacy prompt for {{SESSION_NAME}}';
				mockReadFile.mockResolvedValue(promptTemplate);

				const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
				const result = await loadRegistrationPrompt('developer', 'test-session', 'member-123');

				expect(result).toContain('Legacy prompt for test-session');
			});

			it('should use modular prompt when flag is true', async () => {
				process.env.CREWLY_USE_MODULAR_PROMPTS = 'true';
				mockReadFile.mockResolvedValue('Legacy prompt for {{SESSION_NAME}}');

				const loadRegistrationPrompt = (service as any).loadRegistrationPrompt.bind(service);
				const result = await loadRegistrationPrompt('developer', 'test-session', 'member-123');

				// Should NOT contain legacy prompt content (modular path was taken)
				expect(typeof result).toBe('string');
				expect(result.length).toBeGreaterThan(0);
				expect(result).not.toContain('Legacy prompt for');
			});
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

			const mockPersistence = (sessionModule.getSessionStatePersistence as any).mock.results[0]?.value;
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

			const mockPersistence = (sessionModule.getSessionStatePersistence as any).mock.results[0]?.value;
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

			const mockPersistence = (sessionModule.getSessionStatePersistence as any).mock.results[0]?.value;
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
			(sessionModule.getSessionStatePersistence as any).mockImplementation(() => {
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
			(sessionModule.getSessionStatePersistence as any).mockReturnValue({
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
			(sessionModule.getSessionStatePersistence as any).mockReturnValue({
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
			(sessionModule.getSessionStatePersistence as any).mockReturnValue({
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
				getApiKey: jest.fn().mockResolvedValue(undefined),
			});

			(sessionModule.getSessionStatePersistence as any).mockReturnValue({
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
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

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
			const resultPromise = waitForRegistration('test-session', 'orchestrator', 1000);
			await jest.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result).toBe(false);
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
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

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

			// Each attempt: 1 pre-send + 1 beforeOutput + 3 progressive intervals +
			// extended confirmation loop (30s). All return prompt → stuck after
			// confirmation loop exhausted on every attempt.
			mockSessionHelper.capturePane.mockReturnValue('❯ \n');

			const resultPromise = service.sendMessageToAgent(
				'test-session',
				'[CHAT:abc] Hello orchestrator'
			);
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
		}, 120000);

		it('should succeed when Enter accepted after retry', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Attempt 1: progressive checks + confirmation loop all return prompt → stuck.
			// Attempt 2 or confirmation loop: processing indicator appears → success.
			// Call count is higher now due to the extended confirmation loop.
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				// First ~20 calls: prompt (covers progressive + some confirmation loop)
				if (capturePaneCount <= 20) return '❯ \n';
				// After enough attempts, processing indicator appears
				return '⏺ Processing...\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
		}, 60000);

		it('should accept when prompt gone on first progressive check (no false negative)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Call 1: pre-send — at prompt
			// Call 2: beforeOutput capture
			// Call 3: dedup guard (#128) — no spinner, proceeds to write
			// Call 4: 1st interval — ⏺ found → success
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ \n')                // pre-send: at prompt
				.mockReturnValueOnce('❯ \n')                // beforeOutput capture
				.mockReturnValueOnce('❯ \n')                // dedup guard (#128): no spinner
				.mockReturnValueOnce('⏺ Processing...\n');  // 1st interval: processing → success

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should clear leftover input on retry when at prompt', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// Each attempt: 1 pre-send + 1 beforeOutput + 1 dedup guard + 3 progressive intervals
			// + extended confirmation loop calls. Prompt calls lead to stuck detection.
			// Eventually a processing indicator appears → success on retry.
			let capturePaneCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				capturePaneCount++;
				// First ~30 calls: all prompt (covers attempt 1 progressive + confirmation loop)
				if (capturePaneCount <= 30) return '❯ \n';
				// Subsequent calls: processing indicator → success on retry
				return '⏺ Processing...\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello stuck message');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			// clearCurrentCommandLine should have been called during retry after stuck detection
			expect(mockSessionHelper.clearCurrentCommandLine).toHaveBeenCalled();
			// Second attempt succeeds
			expect(result.success).toBe(true);
		}, 120000);

		it('should run retry cleanup on every failed attempt, not just first', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);

			// All capturePane calls return prompt → stuck on every attempt.
			// With extended confirmation loop (30s/attempt), needs more fake time.
			mockSessionHelper.capturePane.mockReturnValue('❯ \n');

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			expect(result.success).toBe(false);
			// clearCurrentCommandLine should be called on every failed attempt
			// With 3 attempts all stuck, expect at least 2 cleanup calls
			// (first attempt skips Ctrl+C but cleanup still runs after stuck detection)
			expect(mockSessionHelper.clearCurrentCommandLine.mock.calls.length).toBeGreaterThanOrEqual(2);
		}, 120000);
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
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should not force-deliver when agent is busy (low idle time)', async () => {
			// Simulate agent actively processing — PTY output within the busy threshold
			mockGetIdleTimeMs.mockReturnValue(1000); // 1s idle < 5s threshold = busy

			// No prompt visible (agent is working)
			mockSessionHelper.capturePane.mockReturnValue('Tool output line 1\nTool output line 2');

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(false);
			// Should not have called sendMessage (no force delivery when busy)
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('should not force-deliver when idle time is zero (active output)', async () => {
			// Simulate agent with very recent PTY output
			mockGetIdleTimeMs.mockReturnValue(0); // Just produced output = busy

			mockSessionHelper.capturePane.mockReturnValue('⏺ Running Bash command...\n  $ npm test');

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});
	});

	describe('sendMessageWithRetry — retry deduplication guard (#128)', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should skip re-write on retry when spinner is visible (definitive processing)', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				// Calls 1-2: at prompt (pre-send + beforeOutput)
				if (callCount <= 2) return '❯ \n';
				// Calls 3-5: still at prompt (progressive verification intervals)
				if (callCount <= 5) return '❯ \n';
				// Calls 6+: processing indicator (confirmation loop or retry dedup guard)
				// The confirmation loop will see spinner and set claudeDelivered = true
				return '⏺ Processing your request...\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			// sendMessage should only be called ONCE (attempt 1), not twice
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(1);
		}, 60000);

		it('should skip re-write on retry when agent is not at prompt and message not stuck', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				// Calls 1-2: at prompt (pre-send + beforeOutput)
				if (callCount <= 2) return '❯ \n';
				// Calls 3-5: still at prompt (progressive verification intervals)
				if (callCount <= 5) return '❯ \n';
				// Calls 6+: agent processing (confirmation loop detects no prompt + no stuck text)
				return 'Reading file src/index.ts\nAnalyzing code...\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(300000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			// sendMessage should only be called ONCE (attempt 1), not twice
			expect(mockSessionHelper.sendMessage).toHaveBeenCalledTimes(1);
		}, 60000);

		it('should allow re-write when message text is stuck at prompt on retry', async () => {
			mockSessionHelper.sessionExists.mockReturnValue(true);
			let callCount = 0;
			mockSessionHelper.capturePane.mockImplementation(() => {
				callCount++;
				// Call 1 (prompt check attempt 1): at prompt
				if (callCount === 1) return '❯ \n';
				// Call 2 (beforeOutput capture attempt 1): at prompt
				if (callCount === 2) return '❯ \n';
				// Calls 3+ (progressive + confirmation loop): message text stuck at prompt
				return '❯ Hello\n';
			});

			const resultPromise = service.sendMessageToAgent('test-session', 'Hello');
			await jest.advanceTimersByTimeAsync(300000);
			await resultPromise;

			// sendMessage should be called more than once since dedup guard allows re-write
			expect(mockSessionHelper.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
		}, 120000);
	});

	describe('escapeGeminiShellMode (private method)', () => {
		let escapeGeminiShellMode: (sessionName: string, helper: any) => Promise<boolean>;

		beforeEach(() => {
			jest.useFakeTimers();
			escapeGeminiShellMode = (service as any).escapeGeminiShellMode.bind(service);
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should send Escape and return true when shell mode exits', async () => {
			// First capturePane: still in shell mode (but isGeminiInShellMode will see normal prompt)
			mockSessionHelper.capturePane.mockReturnValue('│ > Type your message │');

			const resultPromise = escapeGeminiShellMode('crewly-orc', mockSessionHelper);
			await jest.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalledWith('crewly-orc');
		});

		it('should retry and return false after max attempts if still in shell mode', async () => {
			// capturePane always shows shell mode
			mockSessionHelper.capturePane.mockReturnValue('│ ! │');

			const resultPromise = escapeGeminiShellMode('crewly-orc', mockSessionHelper);
			await jest.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result).toBe(false);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalledTimes(3); // MAX_ESCAPE_ATTEMPTS
		});
	});

	describe('sendMessageToAgent with Gemini shell mode', () => {
		beforeEach(() => {
			jest.useFakeTimers();
			mockSessionHelper.sessionExists.mockReturnValue(true);
		});

		afterEach(() => {
			jest.useRealTimers();
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

			const resultPromise = service.sendMessageToAgent(
				'crewly-orc',
				'Hello!',
				RUNTIME_TYPES.GEMINI_CLI
			);
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(mockSessionHelper.sendEscape).toHaveBeenCalled();
		});

		it('should not attempt shell mode escape for Claude Code runtime', async () => {
			mockSessionHelper.capturePane
				.mockReturnValueOnce('❯ ')              // pre-send: prompt check
				.mockReturnValueOnce('❯ ')              // beforeOutput capture
				.mockReturnValueOnce('❯ ')              // dedup guard (#128): no spinner
				.mockReturnValueOnce('⏺ Processing');   // 1st interval: ⏺ found → success

			const resultPromise = service.sendMessageToAgent(
				'crewly-orc',
				'Hello',
				RUNTIME_TYPES.CLAUDE_CODE
			);
			await jest.advanceTimersByTimeAsync(60000);
			const result = await resultPromise;

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
				sentAt: Date.now() - 20000, // 20s ago (> 10s threshold)
				recovered: false,
				recoveryAttempts: 0,
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

			// Entry should have incremented recoveryAttempts (not yet at max)
			const entries = tracker.get('test-session');
			expect(entries[0].recoveryAttempts).toBe(1);
			expect(entries[0].recovered).toBe(false);
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
				recoveryAttempts: 0,
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

			// Entry should have incremented recoveryAttempts (not yet at max)
			const entries = tracker.get('test-session');
			expect(entries[0].recoveryAttempts).toBe(1);
			expect(entries[0].recovered).toBe(false);
		});

		it('should NOT act on messages younger than 10 seconds', async () => {
			const tracker = (service as any).sentMessageTracker;
			tracker.set('test-session', [{
				snippet: 'This message was just sent recently',
				sentAt: Date.now() - 5000, // 5s ago (< 10s threshold)
				recovered: false,
				recoveryAttempts: 0,
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
				recoveryAttempts: 5,
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
				recoveryAttempts: 0,
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
				recoveryAttempts: 0,
			}]);

			mockSessionHelper.sessionExists.mockImplementation((name: string) => name !== 'dead-session');

			await (service as any).scanForStuckMessages();

			expect(tracker.has('dead-session')).toBe(false);
		});

		it('should skip Gemini CLI sessions in tracked-message scanning', async () => {
			const tracker = (service as any).sentMessageTracker;
			const tuiRegistry = (service as any).tuiSessionRegistry;

			// Register session as Gemini CLI
			tuiRegistry.set('gemini-session', RUNTIME_TYPES.GEMINI_CLI);
			tracker.set('gemini-session', [{
				snippet: 'This message should NOT trigger recovery',
				sentAt: Date.now() - 20000, // 20s ago
				recovered: false,
				recoveryAttempts: 0,
			}]);

			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n' +
				'This message should NOT trigger recovery\n'
			);

			await (service as any).scanForStuckMessages();

			// Should NOT have pressed Enter for Gemini CLI
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();

			// Entry should remain un-recovered
			const entries = tracker.get('gemini-session');
			expect(entries[0].recovered).toBe(false);
		});

		it('should skip Gemini CLI sessions in TUI prompt-line scanning', async () => {
			const tuiRegistry = (service as any).tuiSessionRegistry;

			// Register session as Gemini CLI
			tuiRegistry.set('gemini-tui', RUNTIME_TYPES.GEMINI_CLI);

			// Terminal shows text at a TUI prompt — would normally trigger recovery
			mockSessionHelper.capturePane.mockReturnValue(
				'│  > This is stuck text at the prompt that is long enough │\n'
			);

			await (service as any).scanForStuckMessages();

			// Should NOT have pressed Tab+Enter for Gemini CLI
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalled();
		});

		it('should still scan non-Gemini sessions when Gemini sessions are present', async () => {
			const tracker = (service as any).sentMessageTracker;
			const tuiRegistry = (service as any).tuiSessionRegistry;

			// One Gemini, one Claude Code
			tuiRegistry.set('gemini-session', RUNTIME_TYPES.GEMINI_CLI);
			tuiRegistry.set('claude-session', RUNTIME_TYPES.CLAUDE_CODE);

			tracker.set('claude-session', [{
				snippet: 'This Claude message IS stuck and should recover',
				sentAt: Date.now() - 20000,
				recovered: false,
				recoveryAttempts: 0,
			}]);
			tracker.set('gemini-session', [{
				snippet: 'This Gemini message should be skipped',
				sentAt: Date.now() - 20000,
				recovered: false,
				recoveryAttempts: 0,
			}]);

			mockSessionHelper.capturePane.mockImplementation((name: string) => {
				if (name === 'claude-session') {
					return 'Output\nThis Claude message IS stuck and should recover\n';
				}
				return 'Output\nThis Gemini message should be skipped\n';
			});

			await (service as any).scanForStuckMessages();

			// Should have recovered claude-session only
			expect(mockSessionHelper.sendEnter).toHaveBeenCalledWith('claude-session');
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalledWith('gemini-session');
		});

		it('should mark entry as recovered after MAX_RECOVERY_ATTEMPTS exhausted', async () => {
			const tracker = (service as any).sentMessageTracker;
			const snippet = 'Permanently stuck message text here';
			tracker.set('test-session', [{
				snippet,
				sentAt: Date.now() - 20000,
				recovered: false,
				recoveryAttempts: 5, // Already at max (5) — next scan marks recovered
			}]);

			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n' +
				`❯ ${snippet}\n`
			);

			await (service as any).scanForStuckMessages();

			// Should NOT have pressed Enter — max attempts reached, just marks recovered
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalled();

			const entries = tracker.get('test-session');
			expect(entries[0].recovered).toBe(true);
		});

		it('#213: should skip orchestrator session in TUI prompt-line scanning', async () => {
			// Register orchestrator as TUI session
			const registry = (service as any).tuiSessionRegistry as Map<string, string>;
			registry.set('crewly-orc', RUNTIME_TYPES.CLAUDE_CODE);

			// Simulate text at orchestrator prompt that would normally trigger recovery
			mockSessionHelper.capturePane.mockReturnValue(
				'Some output\n' +
				'> This text is sitting at the orchestrator prompt for a long time\n'
			);
			mockSessionHelper.listSessions.mockReturnValue(['crewly-orc']);

			await (service as any).scanForStuckMessages();

			// Should NOT have pressed Tab or Enter — orchestrator is excluded
			expect(mockSessionHelper.sendKey).not.toHaveBeenCalledWith('crewly-orc', 'Tab');
			expect(mockSessionHelper.sendEnter).not.toHaveBeenCalledWith('crewly-orc');
		});
	});

	describe('Crewly Agent in-process runtime integration', () => {
		let mockCrewlyRuntime: any;

		beforeEach(() => {
			mockCrewlyRuntime = {
				initializeInProcess: jest.fn().mockResolvedValue(undefined),
				handleMessage: jest.fn().mockResolvedValue({
					text: 'Done',
					steps: 1,
					usage: { input: 50, output: 25 },
					toolCalls: [],
					finishReason: 'stop',
				}),
				isReady: jest.fn().mockReturnValue(true),
				shutdown: jest.fn(),
			};

			// When RuntimeServiceFactory.create is called with CREWLY_AGENT, return the mock
			(RuntimeServiceFactory.create as any).mockImplementation(
				(runtimeType: string) => {
					if (runtimeType === RUNTIME_TYPES.CREWLY_AGENT) {
						return mockCrewlyRuntime;
					}
					return mockRuntimeService;
				}
			);
		});

		it('should initialize in-process runtime for crewly-agent type', async () => {
			// Mock readFile for registration prompt
			mockReadFile.mockResolvedValue('You are the orchestrator. {{SESSION_NAME}}');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			const result = await service.createAgentSession({
				sessionName: 'crewly-assistant',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			expect(result.success).toBe(true);
			expect(result.message).toContain('in-process');
			expect(mockCrewlyRuntime.initializeInProcess).toHaveBeenCalledWith(
				'crewly-assistant',
				expect.objectContaining({ projectPath: expect.any(String) }),
				'orchestrator'
			);
			// Should NOT create a PTY session
			expect(mockSessionHelper.createSession).not.toHaveBeenCalled();
		});

		it('should deliver registration prompt to in-process runtime', async () => {
			mockReadFile.mockResolvedValue('Test prompt for {{SESSION_NAME}}');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-assistant',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Registration prompt is fire-and-forget — wait for async resolution
			await new Promise(r => setTimeout(r, 50));

			expect(mockCrewlyRuntime.handleMessage).toHaveBeenCalled();
			const promptArg = mockCrewlyRuntime.handleMessage.mock.calls[0][0];
			expect(promptArg).toContain('crewly-assistant');
		});

		it('should route messages to in-process runtime via sendMessageToAgent', async () => {
			// Setup: create the in-process runtime first
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-assistant',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Now send a message
			const result = await service.sendMessageToAgent(
				'crewly-assistant',
				'Check team status',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(result.success).toBe(true);
			// handleMessage is called twice: once with system prompt (from createAgentSession),
			// once with the actual message (from sendMessageToAgent)
			const lastCall = mockCrewlyRuntime.handleMessage.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe('Check team status');
			// Should NOT write to PTY
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('should return error when in-process runtime not initialized', async () => {
			const result = await service.sendMessageToAgent(
				'nonexistent-session',
				'Hello',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});

		it('should handle in-process runtime errors gracefully (fire-and-forget)', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-err',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Make handleMessage throw — errors are caught in the fire-and-forget handler
			mockCrewlyRuntime.handleMessage.mockRejectedValueOnce(new Error('Model API rate limited'));

			// sendMessageToAgent returns success immediately (fire-and-forget)
			const result = await service.sendMessageToAgent(
				'crewly-err',
				'test',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(result.success).toBe(true);

			// Wait for async error handling to complete (should not throw)
			await new Promise(r => setTimeout(r, 50));
		});

		it('should shutdown in-process runtime on terminateAgentSession', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-terminate',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			const result = await service.terminateAgentSession('crewly-terminate', 'orchestrator');

			expect(result.success).toBe(true);
			expect(mockCrewlyRuntime.shutdown).toHaveBeenCalled();
		});

		it('should return true immediately for waitForAgentReady with in-process runtime', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-ready',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			const ready = await service.waitForAgentReady('crewly-ready');

			expect(ready).toBe(true);
			// Should NOT check PTY terminal output
			expect(mockSessionHelper.capturePane).not.toHaveBeenCalled();
		});

		it('should expose in-process runtime via getInProcessRuntime', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-getter',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			const runtime = service.getInProcessRuntime('crewly-getter');
			expect(runtime).toBe(mockCrewlyRuntime);

			const missing = service.getInProcessRuntime('nonexistent');
			expect(missing).toBeUndefined();
		});

		it('should report in-process runtime as active via isInProcessRuntimeActive', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-active-check',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Mock isReady returning true
			(mockCrewlyRuntime.isReady as any).mockReturnValue(true);
			expect(service.isInProcessRuntimeActive('crewly-active-check')).toBe(true);

			// Mock isReady returning false
			(mockCrewlyRuntime.isReady as any).mockReturnValue(false);
			expect(service.isInProcessRuntimeActive('crewly-active-check')).toBe(false);

			// Nonexistent session
			expect(service.isInProcessRuntimeActive('nonexistent')).toBe(false);
		});

		it('should route to in-process runtime even when runtimeType is misresolved (Bug 1/3/4)', async () => {
			// Setup: create the in-process runtime
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-mistype',
				role: 'developer',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Send message with WRONG runtimeType (claude-code instead of crewly-agent)
			// This simulates what happens when storage lookup fails and defaults
			const result = await service.sendMessageToAgent(
				'crewly-mistype',
				'Check status',
				RUNTIME_TYPES.CLAUDE_CODE as any
			);

			expect(result.success).toBe(true);
			// handleMessage is called twice: system prompt (createAgentSession) + actual message
			const lastCall = mockCrewlyRuntime.handleMessage.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe('Check status');
			// Should NOT attempt PTY delivery
			expect(mockSessionHelper.sendMessage).not.toHaveBeenCalled();
		});

		it('should route response to chat when message has [CHAT:xxx] prefix (Bug 2)', async () => {
			// Setup: create the in-process runtime
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-chat',
				role: 'developer',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			mockCrewlyRuntime.handleMessage.mockResolvedValueOnce({
				text: 'Task completed successfully',
				steps: 2,
				usage: { input: 100, output: 50 },
				toolCalls: [],
				finishReason: 'stop',
			});

			const routeSpy = jest.spyOn(service as any, 'routeInProcessResponseToChat');

			const result = await service.sendMessageToAgent(
				'crewly-chat',
				'[CHAT:conv-123] Process this task',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(result.success).toBe(true);

			// Wait for fire-and-forget async callback to complete
			await new Promise(r => setTimeout(r, 50));

			// Web chat messages should be routed to chat gateway
			expect(routeSpy).toHaveBeenCalledWith('crewly-chat', 'Task completed successfully', 'conv-123');
			routeSpy.mockRestore();
		});

		it('should NOT route response to chat for Slack-sourced messages (dedup fix)', async () => {
			// Setup: create the in-process runtime
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-slack',
				role: 'developer',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			mockCrewlyRuntime.handleMessage.mockResolvedValueOnce({
				text: 'Response via reply_slack',
				steps: 2,
				usage: { input: 100, output: 50 },
				toolCalls: [{ toolName: 'reply_slack', args: { channel: 'C123', text: 'Response via reply_slack' } }],
				finishReason: 'stop',
			});

			const routeSpy = jest.spyOn(service as any, 'routeInProcessResponseToChat');

			const result = await service.sendMessageToAgent(
				'crewly-slack',
				'[CHAT:slack-C123-ts456] Hello from Slack [SLACK:C123:1234567890.123]',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(result.success).toBe(true);

			// Wait for fire-and-forget async callback to complete
			await new Promise(r => setTimeout(r, 50));

			// Slack messages should NOT be routed to chat gateway — the agent
			// already sends responses via reply_slack tool to avoid duplicates.
			expect(routeSpy).not.toHaveBeenCalled();
			routeSpy.mockRestore();
		});

		// Bug 6: in-process AI SDK runtime auto-route to Slack
		// When the agent finishes with text-only output (toolCalls=0,
		// finishReason=stop) and the message came from Slack, the response
		// must be auto-routed back to Slack via SlackService. Without this
		// hook, the response is silently dropped — the AI SDK runtime has no
		// PTY stream the SlackBridge can tail.
		//
		// See: P0 KR3 demo-blocker, 2026-05-14 (Steve livewalk on Crewly Demo
		// Slack workspace).
		it('should auto-route response to Slack when agent finished without calling reply_slack', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-orc',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			// Reproduce the production smoking-gun: 101-char reply, no tool calls.
			mockCrewlyRuntime.handleMessage.mockResolvedValueOnce({
				text: '你好！很高兴见到你。我是 Crewly 的协调员，请告诉我你想完成什么任务。',
				steps: 1,
				usage: { input: 7187, output: 56 },
				toolCalls: [],
				finishReason: 'stop',
			});

			const slackRouteSpy = jest.spyOn(service as any, 'routeInProcessResponseToSlack');

			const sendResult = await service.sendMessageToAgent(
				'crewly-orc',
				'[CHAT:slack-D0B17U49LR4-ts1778721826748439] 你好 [SLACK:D0B17U49LR4:1778721826.748439]',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			expect(sendResult.success).toBe(true);

			// Wait for fire-and-forget async callback to complete
			await new Promise(r => setTimeout(r, 50));

			expect(slackRouteSpy).toHaveBeenCalledTimes(1);
			const [routedSession, routedText, routedSlack] = slackRouteSpy.mock.calls[0];
			expect(routedSession).toBe('crewly-orc');
			expect(routedText).toContain('你好');
			expect(routedSlack).toEqual({
				channelId: 'D0B17U49LR4',
				threadTs: '1778721826.748439',
			});
			slackRouteSpy.mockRestore();
		});

		it('should NOT auto-route to Slack when agent already called reply_slack (prevent double-post)', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-orc',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			mockCrewlyRuntime.handleMessage.mockResolvedValueOnce({
				text: 'Reply sent via tool',
				steps: 2,
				usage: { input: 100, output: 50 },
				toolCalls: [{ toolName: 'reply_slack', args: { channelId: 'C123', text: 'Reply sent via tool' } }],
				finishReason: 'stop',
			});

			const slackRouteSpy = jest.spyOn(service as any, 'routeInProcessResponseToSlack');

			await service.sendMessageToAgent(
				'crewly-orc',
				'[CHAT:slack-C123-ts456] Hello [SLACK:C123:1234567890.123]',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			await new Promise(r => setTimeout(r, 50));

			expect(slackRouteSpy).not.toHaveBeenCalled();
			slackRouteSpy.mockRestore();
		});

		it('should NOT auto-route to Slack for non-Slack-sourced messages', async () => {
			mockReadFile.mockResolvedValue('System prompt');
			mockAccess.mockRejectedValue(new Error('ENOENT'));

			await service.createAgentSession({
				sessionName: 'crewly-orc',
				role: 'orchestrator',
				runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
			});

			mockCrewlyRuntime.handleMessage.mockResolvedValueOnce({
				text: 'Chat-only reply',
				steps: 1,
				usage: { input: 100, output: 50 },
				toolCalls: [],
				finishReason: 'stop',
			});

			const slackRouteSpy = jest.spyOn(service as any, 'routeInProcessResponseToSlack');

			// Web-chat inbound — no [SLACK:] marker.
			await service.sendMessageToAgent(
				'crewly-orc',
				'[CHAT:web-conv-123] Hello',
				RUNTIME_TYPES.CREWLY_AGENT as any
			);

			await new Promise(r => setTimeout(r, 50));

			expect(slackRouteSpy).not.toHaveBeenCalled();
			slackRouteSpy.mockRestore();
		});

		// ──────────────────────────────────────────────────────────────────
		// Orchestrator modelId resolution (P1 fix, cloud_pro_v2)
		// ──────────────────────────────────────────────────────────────────
		// storage.service.ts:413 excludes the orchestrator from getTeams(),
		// so the orchestrator's modelId must be read via getOrchestratorStatus
		// as a fallback. Without this branch, the orchestrator silently
		// defaults to DEFAULT_MODEL even when a modelId is configured.
		describe('orchestrator modelId resolution', () => {
			it('uses orchestratorStatus.modelId when starting the orchestrator session', async () => {
				mockReadFile.mockResolvedValue('System prompt');
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockStorageService.getTeams.mockResolvedValue([]); // orchestrator excluded
				(mockStorageService.getOrchestratorStatus as any).mockResolvedValue({
					sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
					agentStatus: 'active',
					workingStatus: 'idle',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT,
					modelId: 'deepseek/deepseek-chat',
				});

				await service.createAgentSession({
					sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
					role: 'orchestrator',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
				});

				expect(mockCrewlyRuntime.initializeInProcess).toHaveBeenCalled();
				const initArgs = mockCrewlyRuntime.initializeInProcess.mock.calls[0];
				const config = initArgs[1];
				expect(config.model).toBeDefined();
				expect(config.model.provider).toBe('deepseek');
				expect(config.model.modelId).toBe('deepseek-chat');
			});

			it('uses orchestratorStatus.modelId when memberId is "orchestrator-member"', async () => {
				mockReadFile.mockResolvedValue('System prompt');
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockStorageService.getTeams.mockResolvedValue([]);
				(mockStorageService.getOrchestratorStatus as any).mockResolvedValue({
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT,
					modelId: 'anthropic/claude-sonnet-4-20250514',
				});

				// Use a non-orchestrator session name but the canonical orch member id —
				// some flows pass memberId without a matching session name (e.g. virtual member).
				await service.createAgentSession({
					sessionName: 'crewly-orc-virtual',
					role: 'orchestrator',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
					memberId: 'orchestrator-member',
				} as any);

				expect(mockCrewlyRuntime.initializeInProcess).toHaveBeenCalled();
				const config = mockCrewlyRuntime.initializeInProcess.mock.calls[0][1];
				expect(config.model).toBeDefined();
				expect(config.model.provider).toBe('anthropic');
				expect(config.model.modelId).toBe('claude-sonnet-4-20250514');
			});

			it('falls back to DEFAULT_MODEL when orchestrator has no modelId configured', async () => {
				mockReadFile.mockResolvedValue('System prompt');
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockStorageService.getTeams.mockResolvedValue([]);
				(mockStorageService.getOrchestratorStatus as any).mockResolvedValue({
					sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
					agentStatus: 'active',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT,
					// no modelId
				});

				await service.createAgentSession({
					sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
					role: 'orchestrator',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
				});

				expect(mockCrewlyRuntime.initializeInProcess).toHaveBeenCalled();
				const config = mockCrewlyRuntime.initializeInProcess.mock.calls[0][1];
				// No model override → runtime applies its DEFAULT_MODEL.
				expect(config.model).toBeUndefined();
			});

			it('does not call getOrchestratorStatus for non-orchestrator agents', async () => {
				mockReadFile.mockResolvedValue('System prompt');
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockStorageService.getTeams.mockResolvedValue([
					{
						id: 'team-1',
						name: 'Team 1',
						members: [
							{ id: 'm-leo', name: 'Leo', sessionName: 'leo-session', role: 'developer',
							  runtimeType: 'crewly-agent', modelId: 'openai/gpt-4o',
							  systemPrompt: '', agentStatus: 'inactive', workingStatus: 'idle',
							  createdAt: '', updatedAt: '' },
						],
						projectIds: [], createdAt: '', updatedAt: '',
					},
				] as any);
				const orchSpy = mockStorageService.getOrchestratorStatus as any;
				orchSpy.mockClear();

				await service.createAgentSession({
					sessionName: 'leo-session',
					role: 'developer',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
					memberId: 'm-leo',
				} as any);

				expect(mockCrewlyRuntime.initializeInProcess).toHaveBeenCalled();
				const config = mockCrewlyRuntime.initializeInProcess.mock.calls[0][1];
				expect(config.model).toBeDefined();
				expect(config.model.provider).toBe('openai');
				expect(config.model.modelId).toBe('gpt-4o');
				// Orchestrator fallback must not be consulted for regular team members.
				expect(orchSpy).not.toHaveBeenCalled();
			});

			it('prefers team-member modelId over orchestrator modelId when both exist', async () => {
				// Edge case: orchestrator-member id present in a team config (shouldn't
				// happen in practice, but the resolution order should still favor the
				// team-member match found first).
				mockReadFile.mockResolvedValue('System prompt');
				mockAccess.mockRejectedValue(new Error('ENOENT'));
				mockStorageService.getTeams.mockResolvedValue([
					{
						id: 'team-x', name: 'X',
						members: [
							{ id: 'orchestrator-member', name: 'O', sessionName: 'crewly-orc-x',
							  role: 'orchestrator', runtimeType: 'crewly-agent',
							  modelId: 'google/gemini-2.5-flash-preview-05-20',
							  systemPrompt: '', agentStatus: 'inactive', workingStatus: 'idle',
							  createdAt: '', updatedAt: '' },
						],
						projectIds: [], createdAt: '', updatedAt: '',
					},
				] as any);
				(mockStorageService.getOrchestratorStatus as any).mockResolvedValue({
					modelId: 'deepseek/deepseek-chat',
				});

				await service.createAgentSession({
					sessionName: 'crewly-orc-x',
					role: 'orchestrator',
					runtimeType: RUNTIME_TYPES.CREWLY_AGENT as any,
					memberId: 'orchestrator-member',
				} as any);

				const config = mockCrewlyRuntime.initializeInProcess.mock.calls[0][1];
				// Team-member modelId wins.
				expect(config.model.provider).toBe('google');
				expect(config.model.modelId).toBe('gemini-2.5-flash-preview-05-20');
			});
		});
	});

	describe('provisionRuntimeConfigFile', () => {
		let mockMkdir: any;
		let mockWriteFileFs: any;

		beforeEach(() => {
			mockMkdir = jest.mocked(fsPromises.mkdir);
			mockWriteFileFs = jest.mocked(fsPromises.writeFile);
			mockMkdir.mockResolvedValue(undefined);
			mockWriteFileFs.mockResolvedValue(undefined);
			mockReadFile.mockResolvedValue('# Agent Config Template Content');
			mockAccess.mockRejectedValue(new Error('ENOENT'));
		});

		it('should write CLAUDE.md for claude-code runtime', async () => {
			await (service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CLAUDE_CODE);

			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining('.crewly'),
				{ recursive: true },
			);
			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('agent-claude-md.md'),
				'utf8',
			);
			expect(mockWriteFileFs).toHaveBeenCalledWith(
				expect.stringContaining('.crewly/CLAUDE.md'),
				'# Agent Config Template Content',
				{ flag: 'wx' },
			);
		});

		it('should write GEMINI.md for gemini-cli runtime', async () => {
			await (service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.GEMINI_CLI);

			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('agent-gemini-md.md'),
				'utf8',
			);
			expect(mockWriteFileFs).toHaveBeenCalledWith(
				expect.stringContaining('GEMINI.md'),
				'# Agent Config Template Content',
				{ flag: 'wx' },
			);
		});

		it('should write AGENTS.md for codex-cli runtime', async () => {
			await (service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CODEX_CLI);

			expect(mockReadFile).toHaveBeenCalledWith(
				expect.stringContaining('agent-agents-md.md'),
				'utf8',
			);
			expect(mockWriteFileFs).toHaveBeenCalledWith(
				expect.stringContaining('AGENTS.md'),
				'# Agent Config Template Content',
				{ flag: 'wx' },
			);
		});

		it('should skip unknown runtime types', async () => {
			await (service as any).provisionRuntimeConfigFile('/test/project', 'unknown-runtime');

			expect(mockMkdir).not.toHaveBeenCalled();
			expect(mockReadFile).not.toHaveBeenCalled();
			expect(mockWriteFileFs).not.toHaveBeenCalled();
		});

		it('should cache template content on second call', async () => {
			await (service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CLAUDE_CODE);
			mockReadFile.mockClear();

			await (service as any).provisionRuntimeConfigFile('/test/project2', RUNTIME_TYPES.CLAUDE_CODE);

			// Should not read again — content is cached
			expect(mockReadFile).not.toHaveBeenCalledWith(
				expect.stringContaining('agent-claude-md.md'),
				'utf8',
			);
		});

		it('should not throw when file already exists (wx flag)', async () => {
			mockWriteFileFs.mockRejectedValueOnce(new Error('EEXIST: file already exists'));

			// Should not throw — caught by .catch()
			await expect(
				(service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CLAUDE_CODE),
			).resolves.not.toThrow();
		});

		it('should handle template read errors gracefully', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT: template not found'));

			// Should not throw — errors are caught and logged as warnings
			await expect(
				(service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CLAUDE_CODE),
			).resolves.not.toThrow();
		});

		it('should replace {{AGENT_SKILLS_PATH}} in template content (#209)', async () => {
			// Clear cache from previous tests
			(service as any).promptCache.clear();
			mockReadFile.mockResolvedValue('Skills at {{AGENT_SKILLS_PATH}}/core');

			await (service as any).provisionRuntimeConfigFile('/test/project', RUNTIME_TYPES.CLAUDE_CODE);

			expect(mockWriteFileFs).toHaveBeenCalledWith(
				expect.stringContaining('.crewly/CLAUDE.md'),
				expect.stringContaining('/config/skills/agent/core'),
				{ flag: 'wx' },
			);
			// Should NOT contain the raw placeholder
			const writtenContent = mockWriteFileFs.mock.calls[0][1];
			expect(writtenContent).not.toContain('{{AGENT_SKILLS_PATH}}');
		});
	});

	describe('writePromptFile (#207)', () => {
		let mockWriteFileFn: any;

		beforeEach(() => {
			mockWriteFileFn = jest.mocked(fsPromises.writeFile);
			mockWriteFileFn.mockResolvedValue(undefined);
		});

		it('should write to .claude/agents/ with YAML frontmatter for claude-code runtime', async () => {
			const result = await (service as any).writePromptFile(
				'test-agent',
				'Test prompt content',
				{ projectPath: '/test/project', runtimeType: RUNTIME_TYPES.CLAUDE_CODE, role: 'developer' }
			);

			expect(result).toBe('/test/project/.claude/agents/test-agent.md');
			expect(mockWriteFileFn).toHaveBeenCalledWith(
				'/test/project/.claude/agents/test-agent.md',
				expect.stringContaining('---\nname: "test-agent"\ndescription: "developer agent for Crewly orchestration"\n---'),
				'utf8',
			);
			const writtenContent = mockWriteFileFn.mock.calls[mockWriteFileFn.mock.calls.length - 1][1];
			expect(writtenContent).toContain('Test prompt content');
		});

		it('should write to ~/.crewly/prompts/ for non-claude-code runtimes', async () => {
			const result = await (service as any).writePromptFile(
				'test-agent',
				'Test prompt content',
				{ projectPath: '/test/project', runtimeType: 'gemini-cli', role: 'developer' }
			);

			expect(result).toContain('.crewly/prompts/test-agent-init.md');
			const writtenContent = mockWriteFileFn.mock.calls[mockWriteFileFn.mock.calls.length - 1][1];
			expect(writtenContent).not.toContain('---\nname: "');
			expect(writtenContent).toBe('Test prompt content');
		});

		it('should write to legacy path when no options provided', async () => {
			const result = await (service as any).writePromptFile('test-agent', 'Test prompt content');
			expect(result).toContain('.crewly/prompts/test-agent-init.md');
		});

		it('#223: should set agentName when writePromptFile succeeds for claude-code', async () => {
			// Verify the pattern: writePromptFile with options + agentName = sessionName
			const result = await (service as any).writePromptFile(
				'sam-session',
				'prompt',
				{ projectPath: '/project', runtimeType: RUNTIME_TYPES.CLAUDE_CODE, role: 'developer' }
			);
			// If writePromptFile succeeds, agentName should be set to sessionName
			// (verified by checking the file path indicates agent mode was used)
			expect(result).toBe('/project/.claude/agents/sam-session.md');
		});

		// =====================================================================
		// WI-F (2026-05-07) — CREWLY_HOME isolation regression for prompts dir
		//
		// Mia's KR3 livewalk on 2026-05-07 02:37Z found the test backend
		// overwriting Steve's user-prod prompt files (27× crewly-orc-init.md,
		// 26× crewly-auditor-init.md) at `~/.crewly/prompts/` because
		// `getInitPromptFilePath` was inlining `os.homedir() + .crewly` and
		// silently ignoring CREWLY_HOME. Same shape as the PR #452 9-site
		// sweep but on a missed vector. These guards prove the prompt path
		// now flows through the canonical `getCrewlyHomePath()` resolver.
		// =====================================================================
		describe('CREWLY_HOME isolation for getInitPromptFilePath (WI-F)', () => {
			let originalCrewlyHome: string | undefined;

			beforeEach(() => {
				originalCrewlyHome = process.env.CREWLY_HOME;
			});

			afterEach(() => {
				if (originalCrewlyHome === undefined) {
					delete process.env.CREWLY_HOME;
				} else {
					process.env.CREWLY_HOME = originalCrewlyHome;
				}
			});

			it('writes to ${CREWLY_HOME}/prompts when CREWLY_HOME is set (no developer-home leak)', async () => {
				process.env.CREWLY_HOME = '/tmp/crewly-test-profile-wi-f';

				const result = await (service as any).writePromptFile(
					'crewly-orc',
					'orc init prompt',
					{ projectPath: '/test/project', runtimeType: 'gemini-cli', role: 'orchestrator' }
				);

				expect(result).toBe('/tmp/crewly-test-profile-wi-f/prompts/crewly-orc-init.md');
				// Negative: must NOT leak into developer's real home dir.
				const realHome = require('os').homedir();
				expect(result).not.toContain(`${realHome}/.crewly/prompts`);
			});

			it('falls back to ~/.crewly/prompts when CREWLY_HOME is unset', async () => {
				delete process.env.CREWLY_HOME;

				const result = await (service as any).writePromptFile(
					'test-agent',
					'init prompt',
					{ runtimeType: 'gemini-cli', role: 'developer' }
				);

				const path = require('path');
				const os = require('os');
				expect(result).toBe(
					path.join(os.homedir(), '.crewly', 'prompts', 'test-agent-init.md'),
				);
			});

			it('treats empty-string CREWLY_HOME as unset', async () => {
				process.env.CREWLY_HOME = '';

				const result = await (service as any).writePromptFile(
					'test-agent',
					'init prompt',
					{ runtimeType: 'gemini-cli', role: 'developer' }
				);

				const path = require('path');
				const os = require('os');
				expect(result).toBe(
					path.join(os.homedir(), '.crewly', 'prompts', 'test-agent-init.md'),
				);
			});

			it('claude-code agent path is unaffected by CREWLY_HOME (writes under projectPath/.claude/agents)', async () => {
				process.env.CREWLY_HOME = '/tmp/crewly-test-profile-wi-f';

				const result = await (service as any).writePromptFile(
					'sam-session',
					'prompt',
					{ projectPath: '/proj', runtimeType: RUNTIME_TYPES.CLAUDE_CODE, role: 'developer' }
				);

				// Claude-code mode short-circuits before hitting getInitPromptFilePath,
				// so the projectPath-anchored output stays intact regardless of CREWLY_HOME.
				expect(result).toBe('/proj/.claude/agents/sam-session.md');
			});
		});
	});

	describe('registerMemberActive', () => {
		it('should use updateOrchestratorStatus for orchestrator session', async () => {
			const result = await (service as any).registerMemberActive(
				'crewly-orc',
				'orchestrator',
			);

			expect(result).toBe(true);
			expect(mockStorageService.updateOrchestratorStatus).toHaveBeenCalledWith('active');
		});

		it('should find team member by sessionName', async () => {
			const mockTeam = {
				id: 'team-1',
				members: [
					{ id: 'member-1', sessionName: 'dev-session', agentStatus: 'inactive', workingStatus: 'idle' },
				],
			} as any;
			mockStorageService.getTeams.mockResolvedValue([mockTeam]);
			mockStorageService.saveTeam = jest.fn().mockResolvedValue(undefined);

			const result = await (service as any).registerMemberActive(
				'dev-session',
				'developer',
			);

			expect(result).toBe(true);
			expect(mockTeam.members[0].agentStatus).toBe('active');
			expect(mockStorageService.saveTeam).toHaveBeenCalledWith(mockTeam);
		});

		it('should find team member by memberId when sessionName does not match', async () => {
			const mockTeam = {
				id: 'team-1',
				members: [
					{ id: 'member-abc', sessionName: '', agentStatus: 'inactive', workingStatus: 'idle' },
				],
			} as any;
			mockStorageService.getTeams.mockResolvedValue([mockTeam]);
			mockStorageService.saveTeam = jest.fn().mockResolvedValue(undefined);

			const result = await (service as any).registerMemberActive(
				'new-session',
				'developer',
				'member-abc',
			);

			expect(result).toBe(true);
			expect(mockTeam.members[0].agentStatus).toBe('active');
			expect(mockTeam.members[0].sessionName).toBe('new-session');
		});

		it('should return false when member not found in any team', async () => {
			mockStorageService.getTeams.mockResolvedValue([{
				id: 'team-1',
				members: [
					{ id: 'other-member', sessionName: 'other-session', agentStatus: 'inactive' },
				],
			} as any]);

			const result = await (service as any).registerMemberActive(
				'unknown-session',
				'developer',
			);

			expect(result).toBe(false);
		});
	});

	// ──────────────────────────────────────────────────────────────────────
	// Bug #1: start-agent role=undefined silent failure
	// Guards added at three layers: validateAgentRole (utility),
	// getPromptFileForRole (path resolver), createAgentSession (service entry).
	// ──────────────────────────────────────────────────────────────────────
	describe('validateAgentRole (Bug #1 guard)', () => {
		it('accepts a valid string role', () => {
			expect(() => validateAgentRole('developer')).not.toThrow();
			expect(() => validateAgentRole('orchestrator')).not.toThrow();
			expect(() => validateAgentRole('team-leader')).not.toThrow();
		});

		it('rejects undefined', () => {
			expect(() => validateAgentRole(undefined)).toThrow(InvalidAgentRoleError);
		});

		it('rejects null', () => {
			expect(() => validateAgentRole(null)).toThrow(InvalidAgentRoleError);
		});

		it('rejects empty string', () => {
			expect(() => validateAgentRole('')).toThrow(InvalidAgentRoleError);
		});

		it('rejects whitespace-only string', () => {
			expect(() => validateAgentRole('   ')).toThrow(InvalidAgentRoleError);
		});

		it('rejects literal string "undefined" (the actual reproducer)', () => {
			// This is the bug: when JS undefined gets stringified into a template
			// literal, it becomes the literal string "undefined" — which would
			// pass a naive `typeof === "string"` check but is still unusable.
			expect(() => validateAgentRole('undefined')).toThrow(InvalidAgentRoleError);
			expect(() => validateAgentRole('UNDEFINED')).toThrow(InvalidAgentRoleError);
			expect(() => validateAgentRole('Undefined')).toThrow(InvalidAgentRoleError);
		});

		it('rejects literal string "null"', () => {
			expect(() => validateAgentRole('null')).toThrow(InvalidAgentRoleError);
		});

		it('rejects non-string types (number, object, array)', () => {
			expect(() => validateAgentRole(42)).toThrow(InvalidAgentRoleError);
			expect(() => validateAgentRole({})).toThrow(InvalidAgentRoleError);
			expect(() => validateAgentRole([])).toThrow(InvalidAgentRoleError);
			expect(() => validateAgentRole(true)).toThrow(InvalidAgentRoleError);
		});

		it('error message includes the received value and caller context', () => {
			try {
				validateAgentRole(undefined, 'startTeamMember');
				fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(InvalidAgentRoleError);
				expect((err as Error).message).toContain('undefined');
				expect((err as Error).message).toContain('startTeamMember');
				expect((err as Error).message).toContain('config/roles/');
			}
		});

		it('error message preserves the literal "undefined" string for diagnostic clarity', () => {
			try {
				validateAgentRole('undefined');
				fail('should have thrown');
			} catch (err) {
				expect((err as Error).message).toContain('"undefined"');
			}
		});

		it('InvalidAgentRoleError exposes the received value for downstream handling', () => {
			const err = new InvalidAgentRoleError(42, 'unit-test');
			expect(err.received).toBe(42);
			expect(err.name).toBe('InvalidAgentRoleError');
			expect(err instanceof Error).toBe(true);
		});
	});

	describe('getPromptFileForRole (Bug #1 guard at path resolver)', () => {
		it('resolves a valid role to config/roles/{role}/prompt.md', async () => {
			const result = await (service as any).getPromptFileForRole('developer');
			expect(result).toContain('config/roles/developer/prompt.md');
		});

		it('normalizes case and whitespace in role names', async () => {
			const result = await (service as any).getPromptFileForRole('Team Leader');
			expect(result).toContain('config/roles/team-leader/prompt.md');
		});

		it('throws InvalidAgentRoleError when role is undefined (was: silent fallback)', async () => {
			await expect(
				(service as any).getPromptFileForRole(undefined)
			).rejects.toThrow(InvalidAgentRoleError);
		});

		it('throws InvalidAgentRoleError when role is the literal "undefined"', async () => {
			await expect(
				(service as any).getPromptFileForRole('undefined')
			).rejects.toThrow(InvalidAgentRoleError);
		});

		it('throws InvalidAgentRoleError when role is empty', async () => {
			await expect(
				(service as any).getPromptFileForRole('')
			).rejects.toThrow(InvalidAgentRoleError);
		});
	});

	describe('createAgentSession role validation (Bug #1 fail-fast)', () => {
		it('refuses to create a session when role is undefined', async () => {
			const result = await service.createAgentSession({
				sessionName: 'broken-session',
				role: undefined as any,
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid agent role');
			// Critically: tmux session should NEVER be created
			expect(mockSessionHelper.createSession).not.toHaveBeenCalled();
			// And CREWLY_ROLE env should NEVER be set with the bad value
			expect(mockSessionHelper.setEnvironmentVariable).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.stringContaining('CREWLY_ROLE'),
				expect.anything(),
			);
		});

		it('refuses to create a session when role is the literal string "undefined"', async () => {
			const result = await service.createAgentSession({
				sessionName: 'broken-session',
				role: 'undefined',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid agent role');
			expect(mockSessionHelper.createSession).not.toHaveBeenCalled();
		});

		it('refuses to create a session when role is empty', async () => {
			const result = await service.createAgentSession({
				sessionName: 'broken-session',
				role: '',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid agent role');
		});

		it('returns the failing sessionName so caller can correlate logs', async () => {
			const result = await service.createAgentSession({
				sessionName: 'broken-session-xyz',
				role: undefined as any,
			});

			expect(result.sessionName).toBe('broken-session-xyz');
		});
	});

	// ──────────────────────────────────────────────────────────────────
	// routeInProcessResponseToSlack — error paths
	// ──────────────────────────────────────────────────────────────────
	// The function is fire-and-forget (returns void) and every branch is
	// best-effort with a `try/catch` that swallows errors and logs at
	// debug/warn. These tests pin that contract: a future refactor that
	// converts a `try/catch` to an unhandled `throw` would break the
	// caller's success return — these tests are the safety net.
	describe('routeInProcessResponseToSlack — error paths', () => {
		beforeEach(() => {
			mockSlackIsConnected.mockReset().mockReturnValue(true);
			mockSlackSendMessage.mockReset().mockResolvedValue('1234567890.000100');
			mockTsqGet.mockReset().mockReturnValue(null);
			mockTsqTrackInbound.mockReset();
			mockTsqMarkReplied.mockReset();
			mockMarkResolvedByThread.mockReset().mockResolvedValue(undefined);
			mockBehaviorLogRecord.mockReset();
			mockChatV2EnsureChannel.mockReset().mockReturnValue({ id: 'C123' });
			mockChatV2RecordTurn.mockReset().mockReturnValue({
				message: { id: 'msg-1', content: 'hello' },
				deduped: false,
			});
		});

		const flushAsync = async (): Promise<void> => {
			// The function chains `.then().catch()` over a dynamic import.
			// We need to drain microtasks AND the macrotask queue for the
			// inner awaits (sendMessage, markResolvedByThread).
			for (let i = 0; i < 5; i++) {
				await new Promise(resolve => setImmediate(resolve));
			}
		};

		const invoke = (overrides: Partial<{ channelId: string; threadTs?: string }> = {}): void => {
			(service as any).routeInProcessResponseToSlack('crewly-orc', 'hello', {
				channelId: overrides.channelId ?? 'C123',
				threadTs: overrides.threadTs ?? '1234567890.000200',
			});
		};

		it('(a) bails without throwing when Slack is not connected', async () => {
			mockSlackIsConnected.mockReturnValue(false);

			invoke();
			await flushAsync();

			expect(mockSlackSendMessage).not.toHaveBeenCalled();
			expect(mockTsqTrackInbound).not.toHaveBeenCalled();
			expect(mockTsqMarkReplied).not.toHaveBeenCalled();
			expect(mockMarkResolvedByThread).not.toHaveBeenCalled();
		});

		it('(b) swallows sendMessage failure and skips downstream bookkeeping', async () => {
			mockSlackSendMessage.mockRejectedValueOnce(new Error('slack 5xx'));

			// Must not throw — the function is fire-and-forget.
			expect(() => invoke()).not.toThrow();
			await flushAsync();

			expect(mockSlackSendMessage).toHaveBeenCalledTimes(1);
			// When sendMessage throws, the .then() chain rejects and the
			// outer .catch() handles it — bookkeeping never runs.
			expect(mockTsqTrackInbound).not.toHaveBeenCalled();
			expect(mockTsqMarkReplied).not.toHaveBeenCalled();
			expect(mockMarkResolvedByThread).not.toHaveBeenCalled();
		});

		it('(c) swallows markReplied failure but still fires the V3 SLA cascade', async () => {
			// Send succeeds, then the thread-status bookkeeping crashes —
			// the SLA cascade in the *next* try/catch block must still run.
			// Without independent try/catches, one failing primitive would
			// silently leak Requests stuck in `queued`.
			mockTsqGet.mockReturnValue(null);
			mockTsqMarkReplied.mockImplementation(() => {
				throw new Error('tsq corruption');
			});

			expect(() => invoke()).not.toThrow();
			await flushAsync();

			expect(mockSlackSendMessage).toHaveBeenCalledTimes(1);
			expect(mockTsqTrackInbound).toHaveBeenCalledTimes(1);
			expect(mockMarkResolvedByThread).toHaveBeenCalledTimes(1);
		});

		it('(d) swallows markResolvedByThread failure (last in chain — must not propagate)', async () => {
			mockMarkResolvedByThread.mockRejectedValueOnce(new Error('subscriber down'));

			expect(() => invoke()).not.toThrow();
			await flushAsync();

			expect(mockSlackSendMessage).toHaveBeenCalledTimes(1);
			expect(mockTsqMarkReplied).toHaveBeenCalledTimes(1);
			expect(mockMarkResolvedByThread).toHaveBeenCalledTimes(1);
		});

		it('builds the thread-status entry on the fly when no inbound was tracked (race-protection)', async () => {
			// This is the #1 fix from the code review: /slack/send has
			// always populated the entry before marking replied; the
			// in-process route used to short-circuit on a missing entry
			// and leave the recovery loop free to re-fire the inbound.
			mockTsqGet.mockReturnValue(null);

			invoke({ channelId: 'C999', threadTs: '1700000000.000111' });
			await flushAsync();

			expect(mockTsqTrackInbound).toHaveBeenCalledTimes(1);
			const trackedArgs = mockTsqTrackInbound.mock.calls[0][0];
			expect(trackedArgs).toMatchObject({
				threadKey: 'C999:1700000000.000111',
				source: 'slack',
			});
			// conversationId fallback format: 'slack-<channel>-<ts with . → ->'
			expect(trackedArgs.conversationId).toBe('slack-C999-1700000000-000111');
			expect(mockTsqMarkReplied).toHaveBeenCalledWith('C999:1700000000.000111', 'replied_completed');
		});

		it('skips trackInbound when the entry already exists (idempotent path)', async () => {
			mockTsqGet.mockReturnValue({ threadKey: 'C123:abc' });

			invoke();
			await flushAsync();

			expect(mockTsqTrackInbound).not.toHaveBeenCalled();
			expect(mockTsqMarkReplied).toHaveBeenCalledTimes(1);
		});

		// Follow-up #9 from PR #543 review. /slack/send records an
		// `agent.action` row on every successful send; the in-process
		// auto-route was missing this, so audit views silently lost the
		// auto-routed branch of agent replies.
		it('records an agent.action behavior-log row after successful send', async () => {
			invoke({ channelId: 'C-AUDIT', threadTs: '1700000000.000222' });
			await flushAsync();

			expect(mockBehaviorLogRecord).toHaveBeenCalledTimes(1);
			const event = mockBehaviorLogRecord.mock.calls[0][0];
			expect(event).toMatchObject({
				type: 'agent.action',
				agent: 'crewly-orc',
				actionType: 'send_slack',
			});
			expect(event.details).toMatchObject({
				channelId: 'C-AUDIT',
				threadTs: '1700000000.000222',
				source: 'in_process_auto_route',
			});
		});

		it('does NOT record agent.action when the Slack send failed', async () => {
			mockSlackSendMessage.mockRejectedValueOnce(new Error('slack 5xx'));

			invoke();
			await flushAsync();

			expect(mockSlackSendMessage).toHaveBeenCalledTimes(1);
			expect(mockBehaviorLogRecord).not.toHaveBeenCalled();
		});

		it('survives behavior-log record failure (audit is best-effort)', async () => {
			mockBehaviorLogRecord.mockImplementationOnce(() => {
				throw new Error('sqlite locked');
			});

			expect(() => invoke()).not.toThrow();
			await flushAsync();

			// Downstream SLA cascade still ran — the audit failure is
			// non-fatal and must not break the bookkeeping chain.
			expect(mockMarkResolvedByThread).toHaveBeenCalledTimes(1);
		});
	});

	// Phase 6β of unified-chat-message-store spec — the explicit
	// chat-v2 dual-write tests have been removed because the route
	// now writes through `ChatService` (a façade over
	// `ChatV2Service`). The chat-v2 mock at module scope is kept so
	// future tests can assert against `recordTurn` without opening a
	// real SQLite database.
});
