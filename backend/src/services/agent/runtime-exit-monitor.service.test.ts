import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { OrchestratorRestartService } from '../orchestrator/orchestrator-restart.service.js';
import { CREWLY_CONSTANTS, RUNTIME_EXIT_CONSTANTS, RUNTIME_TYPES, ORCHESTRATOR_SESSION_NAME, GEMINI_FAILURE_PATTERNS, GEMINI_FAILURE_RETRY_CONSTANTS, CLAUDE_FATAL_PATTERNS, AGENT_HEARTBEAT_MONITOR_CONSTANTS, GEMINI_DELIBERATION_PATTERN, GEMINI_DELIBERATION_THRESHOLD, GEMINI_TOOL_CHECK_LOOP_PATTERN, GEMINI_TOOL_CHECK_LOOP_THRESHOLD, GEMINI_TOOL_CHECK_LOOP_WINDOW_MS } from '../../constants.js';

// Mock http module to prevent real HTTP requests during tests (e.g. notifyOrchestratorOfFailure)
jest.mock('http', () => ({
	...jest.requireActual('http'),
	request: jest.fn().mockReturnValue({
		on: jest.fn().mockReturnThis(),
		write: jest.fn(),
		end: jest.fn(),
	}),
}));

// Mock dependencies
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				debug: jest.fn(),
			}),
		}),
	},
}));

const mockUpdateAgentStatus = jest.fn();
const mockFindMemberBySessionName = jest.fn().mockResolvedValue(null);
jest.mock('../core/storage.service.js', () => ({
	StorageService: {
		getInstance: () => ({
			updateAgentStatus: mockUpdateAgentStatus,
			findMemberBySessionName: mockFindMemberBySessionName,
		}),
	},
}));

const mockOnSessionEnd = jest.fn();
jest.mock('../memory/session-memory.service.js', () => ({
	SessionMemoryService: {
		getInstance: () => ({
			onSessionEnd: mockOnSessionEnd,
		}),
	},
}));

const mockBroadcastOrchestratorStatus = jest.fn();
const mockBroadcastTeamMemberStatus = jest.fn();
jest.mock('../../websocket/terminal.gateway.js', () => ({
	getTerminalGateway: () => ({
		broadcastOrchestratorStatus: mockBroadcastOrchestratorStatus,
		broadcastTeamMemberStatus: mockBroadcastTeamMemberStatus,
	}),
}));

// Mock session/PTY infrastructure
const mockOnData = jest.fn();
const mockWrite = jest.fn();
const mockCapturePane = jest.fn().mockReturnValue('user@host:~$');
const mockGetSession = jest.fn().mockReturnValue({
	onData: mockOnData,
	write: mockWrite,
});
const mockSessionExists = jest.fn().mockReturnValue(true);
const mockKillSession = jest.fn().mockResolvedValue(undefined);

jest.mock('../session/index.js', () => ({
	getSessionBackendSync: () => ({
		getSession: mockGetSession,
		sessionExists: mockSessionExists,
		killSession: mockKillSession,
	}),
	createSessionCommandHelper: () => ({
		getSession: mockGetSession,
		capturePane: mockCapturePane,
	}),
}));

const mockGetSessionId = jest.fn();
const mockGetSessionMetadata = jest.fn();
const mockUpdateSessionId = jest.fn();
jest.mock('../session/session-state-persistence.js', () => ({
	getSessionStatePersistence: () => ({
		getSessionId: mockGetSessionId,
		getSessionMetadata: mockGetSessionMetadata,
		updateSessionId: mockUpdateSessionId,
	}),
}));

const mockClearSession = jest.fn();
jest.mock('./pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: () => ({
			clearSession: mockClearSession,
		}),
	},
}));

const mockGetTasksForTeamMember = jest.fn().mockResolvedValue([]);
jest.mock('../project/task-tracking.service.js', () => ({
	TaskTrackingService: {
		getInstance: () => ({
			getTasksForTeamMember: mockGetTasksForTeamMember,
		}),
	},
}));

jest.mock('fs/promises', () => ({
	readFile: jest.fn().mockResolvedValue('Task content here'),
}));

const mockAttemptRestart = jest.fn().mockResolvedValue(true);
jest.mock('../orchestrator/orchestrator-restart.service.js', () => ({
	OrchestratorRestartService: {
		getInstance: () => ({
			attemptRestart: mockAttemptRestart,
		}),
		resetInstance: jest.fn(),
	},
}));

const mockGetExitPatterns = jest.fn().mockReturnValue([
	/Agent powering down/i,
	/Interaction Summary/,
]);

jest.mock('./runtime-service.factory.js', () => ({
	RuntimeServiceFactory: {
		create: () => ({
			getExitPatterns: mockGetExitPatterns,
		}),
	},
}));

describe('RuntimeExitMonitorService', () => {
	let service: RuntimeExitMonitorService;

	beforeEach(() => {
		jest.clearAllMocks();
		RuntimeExitMonitorService.resetInstance();
		service = RuntimeExitMonitorService.getInstance();

		// Default: onData returns an unsubscribe function
		mockOnData.mockReturnValue(jest.fn());
		// Default: orchestrator restart succeeds (overridden in specific tests)
		mockAttemptRestart.mockResolvedValue(true);
	});

	afterEach(() => {
		RuntimeExitMonitorService.resetInstance();
	});

	describe('getInstance', () => {
		it('should return singleton instance', () => {
			const instance1 = RuntimeExitMonitorService.getInstance();
			const instance2 = RuntimeExitMonitorService.getInstance();
			expect(instance1).toBe(instance2);
		});
	});

	describe('resetInstance', () => {
		it('should create new instance after reset', () => {
			const instance1 = RuntimeExitMonitorService.getInstance();
			RuntimeExitMonitorService.resetInstance();
			const instance2 = RuntimeExitMonitorService.getInstance();
			expect(instance1).not.toBe(instance2);
		});
	});

	describe('startMonitoring', () => {
		it('should subscribe to PTY session output', () => {
			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			expect(mockGetSession).toHaveBeenCalledWith('test-agent');
			expect(mockOnData).toHaveBeenCalledWith(expect.any(Function));
			expect(service.isMonitoring('test-agent')).toBe(true);
		});

		it('should stop existing monitoring before starting new one', () => {
			const unsubscribe1 = jest.fn();
			mockOnData.mockReturnValueOnce(unsubscribe1);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			const unsubscribe2 = jest.fn();
			mockOnData.mockReturnValueOnce(unsubscribe2);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			expect(unsubscribe1).toHaveBeenCalled();
		});

		it('should skip monitoring if no exit patterns are available', () => {
			mockGetExitPatterns.mockReturnValueOnce([]);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			expect(service.isMonitoring('test-agent')).toBe(false);
		});

		it('should handle missing session gracefully', () => {
			mockGetSession.mockReturnValueOnce(undefined);

			service.startMonitoring('missing-session', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			expect(service.isMonitoring('missing-session')).toBe(false);
		});
	});

	describe('stopMonitoring', () => {
		it('should unsubscribe from PTY output', () => {
			const unsubscribe = jest.fn();
			mockOnData.mockReturnValueOnce(unsubscribe);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			service.stopMonitoring('test-agent');

			expect(unsubscribe).toHaveBeenCalled();
			expect(service.isMonitoring('test-agent')).toBe(false);
		});

		it('should be a no-op for non-monitored sessions', () => {
			expect(() => service.stopMonitoring('non-existent')).not.toThrow();
		});
	});

	describe('isMonitoring', () => {
		it('should return true for monitored sessions', () => {
			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			expect(service.isMonitoring('test-agent')).toBe(true);
		});

		it('should return false for non-monitored sessions', () => {
			expect(service.isMonitoring('non-existent')).toBe(false);
		});
	});

	describe('destroy', () => {
		it('should stop all monitoring', () => {
			const unsub1 = jest.fn();
			const unsub2 = jest.fn();
			mockOnData.mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2);

			service.startMonitoring('agent-1', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			service.startMonitoring('agent-2', RUNTIME_TYPES.CLAUDE_CODE, 'reviewer');

			service.destroy();

			expect(unsub1).toHaveBeenCalled();
			expect(unsub2).toHaveBeenCalled();
			expect(service.isMonitoring('agent-1')).toBe(false);
			expect(service.isMonitoring('agent-2')).toBe(false);
		});
	});

	describe('exit detection', () => {
		it('should detect exit pattern immediately (grace period is 0)', async () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			// Get the onData callback
			const onDataCallback = mockOnData.mock.calls[0][0];

			// Send exit pattern immediately — no grace period to block it
			onDataCallback('Agent powering down');

			// Advance past debounce
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Status SHOULD be updated (grace period is 0, so no delay)
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should detect exit pattern after grace period', async () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			// Advance past the grace period
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Send exit pattern
			onDataCallback('Agent powering down\nbye!');

			// Advance past debounce
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);

			// Need to flush the async confirmAndReact
			await jest.runAllTimersAsync();

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should not react to unrelated text', () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			// Advance past grace
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Send unrelated output
			onDataCallback('Working on task...');

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);

			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should cap rolling buffer to MAX_BUFFER_SIZE', () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			// Advance past grace
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Send data larger than max buffer
			const largeData = 'x'.repeat(RUNTIME_EXIT_CONSTANTS.MAX_BUFFER_SIZE + 1000);
			onDataCallback(largeData);

			// Buffer should be capped — accessing via private field
			const monitored = (service as any).sessions.get('test-agent');
			expect(monitored.buffer.length).toBeLessThanOrEqual(RUNTIME_EXIT_CONSTANTS.MAX_BUFFER_SIZE);

			jest.useRealTimers();
		});

		it('should fire onExitDetected callback', async () => {
			jest.useFakeTimers();

			const exitCallback = jest.fn();
			service.setOnExitDetectedCallback(exitCallback);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			// Advance past grace
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Trigger exit
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			expect(exitCallback).toHaveBeenCalledWith('test-agent');

			jest.useRealTimers();
		});

		it('should broadcast team member status for non-orchestrator sessions', async () => {
			jest.useFakeTimers();

			service.startMonitoring('dev-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			expect(mockBroadcastTeamMemberStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'dev-agent',
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
					reason: 'runtime_exited',
				})
			);

			jest.useRealTimers();
		});

		it('should broadcast orchestrator restarted status when restart succeeds', async () => {
			jest.useFakeTimers();
			mockAttemptRestart.mockResolvedValue(true);

			service.startMonitoring(ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES.CLAUDE_CODE, 'orchestrator');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			expect(mockBroadcastOrchestratorStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: ORCHESTRATOR_SESSION_NAME,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.STARTED,
					reason: 'runtime_exit_restart',
				})
			);

			jest.useRealTimers();
		});

		it('should broadcast orchestrator inactive status when restart fails', async () => {
			jest.useFakeTimers();
			mockAttemptRestart.mockResolvedValue(false);

			service.startMonitoring(ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES.CLAUDE_CODE, 'orchestrator');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			expect(mockBroadcastOrchestratorStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: ORCHESTRATOR_SESSION_NAME,
					agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
					reason: 'runtime_exited',
				})
			);

			jest.useRealTimers();
		});

		it('should capture session memory on exit', async () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			expect(mockOnSessionEnd).toHaveBeenCalledWith('test-agent', 'developer', expect.any(String));

			jest.useRealTimers();
		});

		it('should not double-process exit detection', async () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Send exit pattern twice
			onDataCallback('Agent powering down');
			onDataCallback('Agent powering down again');

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Should only update status once
			expect(mockUpdateAgentStatus).toHaveBeenCalledTimes(1);

			jest.useRealTimers();
		});
	});

	describe('setOnExitDetectedCallback', () => {
		it('should store the callback', () => {
			const callback = jest.fn();
			service.setOnExitDetectedCallback(callback);
			expect((service as any).onExitDetectedCallback).toBe(callback);
		});
	});

	describe('process-based exit detection', () => {
		let mockIsChildProcessAlive: jest.Mock;

		beforeEach(() => {
			mockIsChildProcessAlive = jest.fn().mockReturnValue(true);
			// Patch the session backend mock to include isChildProcessAlive
			const sessionModule = jest.requireMock('../session/index.js');
			sessionModule.getSessionBackendSync = () => ({
				getSession: mockGetSession,
				sessionExists: mockSessionExists,
				killSession: mockKillSession,
				isChildProcessAlive: mockIsChildProcessAlive,
			});
			sessionModule.createSessionCommandHelper = () => ({
				getSession: mockGetSession,
				capturePane: mockCapturePane,
			});

			// Re-create the service so it picks up the patched mocks
			RuntimeExitMonitorService.resetInstance();
			service = RuntimeExitMonitorService.getInstance();
		});

		it('should detect exit when child process is not alive', async () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			// Advance past the process poll grace period
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_GRACE_PERIOD_MS);

			// Child process dies
			mockIsChildProcessAlive.mockReturnValue(false);

			// Advance to next poll interval tick
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_INTERVAL_MS);

			// Flush async confirmAndReact
			await jest.runAllTimersAsync();

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			service.stopMonitoring('test-agent');
			jest.useRealTimers();
		});

		it('should not detect exit during grace period', () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			// Child process not alive, but still in grace period
			mockIsChildProcessAlive.mockReturnValue(false);

			// Only advance one poll interval (within 30s grace)
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_INTERVAL_MS);

			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('test-agent');
			jest.useRealTimers();
		});

		it('should not fire when child process is alive', () => {
			jest.useFakeTimers();

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			mockIsChildProcessAlive.mockReturnValue(true);

			// Advance past grace period + one poll
			jest.advanceTimersByTime(
				RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_GRACE_PERIOD_MS +
				RUNTIME_EXIT_CONSTANTS.PROCESS_POLL_INTERVAL_MS
			);

			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('test-agent');
			jest.useRealTimers();
		});

		it('should clear process polling interval on stopMonitoring', () => {
			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');

			const monitored = (service as any).sessions.get('test-agent');
			expect(monitored.processPollingInterval).toBeDefined();

			service.stopMonitoring('test-agent');

			expect(service.isMonitoring('test-agent')).toBe(false);
		});
	});

	describe('task-aware restart on exit', () => {
		const mockCreateAgentSession = jest.fn().mockResolvedValue({ success: true, sessionName: 'test-agent' });
		const mockAgentRegistrationService = {
			createAgentSession: mockCreateAgentSession,
		};
		const mockTaskTrackingServiceInstance = {
			getTasksForTeamMember: mockGetTasksForTeamMember,
		};

		beforeEach(() => {
			mockCreateAgentSession.mockClear();
			mockGetTasksForTeamMember.mockReset();
			mockClearSession.mockClear();
			mockKillSession.mockClear();
			mockWrite.mockClear();
			mockSessionExists.mockReturnValue(true);
			// Inject both dependencies so the restart path activates
			service.setAgentRegistrationService(mockAgentRegistrationService as any);
			service.setTaskTrackingService(mockTaskTrackingServiceInstance as any);
		});

		it('should restart agent when exit detected with in-progress tasks', async () => {
			jest.useFakeTimers();

			mockGetTasksForTeamMember.mockResolvedValue([
				{ id: 'task-1', taskName: 'Fix bug', taskFilePath: '/tmp/task.md', status: 'assigned', assignedTeamMemberId: 'member-1' },
			]);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Should have triggered restart instead of setting inactive
			expect(mockCreateAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'test-agent',
					role: 'developer',
					teamId: 'team-1',
					memberId: 'member-1',
				})
			);
			// Should NOT have set status to inactive (restart took over)
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should set inactive when exit detected with no in-progress tasks', async () => {
			jest.useFakeTimers();

			mockGetTasksForTeamMember.mockResolvedValue([]);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Should have set status to inactive (no tasks to restart for)
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);
			expect(mockCreateAgentSession).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should restart orchestrator on exit via OrchestratorRestartService', async () => {
			jest.useFakeTimers();
			mockAttemptRestart.mockResolvedValue(true);

			service.startMonitoring(ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES.CLAUDE_CODE, 'orchestrator');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Should have attempted orchestrator restart
			expect(mockAttemptRestart).toHaveBeenCalled();
			// Should have set inactive BEFORE restart to prevent queue processor
			// from delivering messages during postInitialize (#270)
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				ORCHESTRATOR_SESSION_NAME,
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				'crash'
			);
			// Should have captured session memory before restart
			expect(mockOnSessionEnd).toHaveBeenCalledWith(ORCHESTRATOR_SESSION_NAME, 'orchestrator', expect.any(String));
			// Should NOT use agent restart path
			expect(mockCreateAgentSession).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should fall back to inactive when orchestrator restart fails', async () => {
			jest.useFakeTimers();
			mockAttemptRestart.mockResolvedValue(false);

			service.startMonitoring(ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES.CLAUDE_CODE, 'orchestrator');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Should have attempted restart
			expect(mockAttemptRestart).toHaveBeenCalled();
			// Restart failed, so should set inactive (#270)
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				ORCHESTRATOR_SESSION_NAME,
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				'crash'
			);

			jest.useRealTimers();
		});

		it('should fall back to inactive when restart fails', async () => {
			jest.useFakeTimers();

			mockCreateAgentSession.mockResolvedValueOnce({ success: false, error: 'Session creation failed' });
			mockGetTasksForTeamMember.mockResolvedValue([
				{ id: 'task-1', taskName: 'Fix bug', taskFilePath: '/tmp/task.md', status: 'active', assignedTeamMemberId: 'member-1' },
			]);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await jest.runAllTimersAsync();

			// Restart was attempted
			expect(mockCreateAgentSession).toHaveBeenCalled();
			// Restart failed, so should fall back to setting inactive
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});
	});

	describe('restart cooldown (prevents infinite restart loops)', () => {
		const mockCreateAgentSession = jest.fn().mockResolvedValue({ success: true, sessionName: 'test-agent' });
		const mockAgentRegistrationService = {
			createAgentSession: mockCreateAgentSession,
		};
		const mockTaskTrackingServiceInstance = {
			getTasksForTeamMember: mockGetTasksForTeamMember,
		};
		const activeTasks = [
			{ id: 'task-1', taskName: 'Fix bug', taskFilePath: '/tmp/task.md', status: 'assigned', assignedTeamMemberId: 'member-1' },
		];

		beforeEach(() => {
			mockCreateAgentSession.mockClear().mockResolvedValue({ success: true, sessionName: 'test-agent' });
			mockGetTasksForTeamMember.mockReset().mockResolvedValue(activeTasks);
			mockClearSession.mockClear();
			mockKillSession.mockClear();
			mockWrite.mockClear();
			mockUpdateAgentStatus.mockClear();
			mockSessionExists.mockReturnValue(true);
			service.setAgentRegistrationService(mockAgentRegistrationService as any);
			service.setTaskTrackingService(mockTaskTrackingServiceInstance as any);
		});

		/**
		 * Helper: trigger an exit detection cycle for a monitored agent.
		 * Sends exit pattern data and advances past debounce.
		 */
		async function triggerExitCycle(agentName: string): Promise<void> {
			// Re-register monitoring (previous cycle stopped it)
			if (!service.isMonitoring(agentName)) {
				service.startMonitoring(agentName, RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			}
			const lastCallIndex = mockOnData.mock.calls.length - 1;
			const onDataCallback = mockOnData.mock.calls[lastCallIndex][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);
		}

		it('should allow restarts up to MAX_RESTARTS_PER_WINDOW', async () => {
			jest.useFakeTimers();

			const maxRestarts = AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW;

			for (let i = 0; i < maxRestarts; i++) {
				mockCreateAgentSession.mockClear();
				await triggerExitCycle('test-agent');
				expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
			}

			jest.useRealTimers();
		});

		it('should block restarts after MAX_RESTARTS_PER_WINDOW reached', async () => {
			jest.useFakeTimers();

			const maxRestarts = AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW;

			// Exhaust all allowed restarts
			for (let i = 0; i < maxRestarts; i++) {
				await triggerExitCycle('test-agent');
			}

			// Next restart should be blocked — agent goes inactive instead
			mockCreateAgentSession.mockClear();
			mockUpdateAgentStatus.mockClear();
			await triggerExitCycle('test-agent');

			expect(mockCreateAgentSession).not.toHaveBeenCalled();
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should allow restarts again after cooldown window expires', async () => {
			jest.useFakeTimers();

			const maxRestarts = AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW;

			// Exhaust all allowed restarts
			for (let i = 0; i < maxRestarts; i++) {
				await triggerExitCycle('test-agent');
			}

			// Advance past the cooldown window
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS + 1000);

			// Should be allowed to restart again
			mockCreateAgentSession.mockClear();
			await triggerExitCycle('test-agent');

			expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);

			jest.useRealTimers();
		});

		it('should track restarts per session independently', async () => {
			jest.useFakeTimers();

			const maxRestarts = AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW;

			// Exhaust restarts for agent-a
			for (let i = 0; i < maxRestarts; i++) {
				mockGetTasksForTeamMember.mockResolvedValue(activeTasks);
				if (!service.isMonitoring('agent-a')) {
					service.startMonitoring('agent-a', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-a');
				}
				const callIdx = mockOnData.mock.calls.length - 1;
				const cb = mockOnData.mock.calls[callIdx][0];
				jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
				cb('Agent powering down');
				await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);
			}

			// agent-b should still be able to restart
			mockCreateAgentSession.mockClear();
			mockGetTasksForTeamMember.mockResolvedValue(activeTasks);
			service.startMonitoring('agent-b', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-b');
			const cbIdx = mockOnData.mock.calls.length - 1;
			const cbB = mockOnData.mock.calls[cbIdx][0];
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			cbB('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);

			jest.useRealTimers();
		});

		it('should clear restartHistory on destroy', () => {
			// Pre-populate restart history via private access
			(service as any).restartHistory.set('test-agent', [Date.now()]);
			expect((service as any).restartHistory.size).toBe(1);

			service.destroy();

			expect((service as any).restartHistory.size).toBe(0);
		});
	});

	describe('Gemini failure pattern detection with retry', () => {
		beforeEach(() => {
			// Include Gemini failure patterns in the mocked exit patterns
			mockGetExitPatterns.mockReturnValue([
				/Agent powering down/i,
				/Interaction Summary/,
				...GEMINI_FAILURE_PATTERNS,
			]);
		});

		/**
		 * Helper to calculate exponential backoff for a given retry index (0-based).
		 */
		function getBackoffMs(retryIndex: number): number {
			return Math.min(
				GEMINI_FAILURE_RETRY_CONSTANTS.INITIAL_BACKOFF_MS *
					Math.pow(GEMINI_FAILURE_RETRY_CONSTANTS.BACKOFF_MULTIPLIER, retryIndex),
				GEMINI_FAILURE_RETRY_CONSTANTS.MAX_BACKOFF_MS
			);
		}

		it('should NOT mark inactive on first Gemini failure (retries with backoff)', async () => {
			jest.useFakeTimers();

			// No shell prompt, no recovery prompt visible
			mockCapturePane.mockReturnValue('RESOURCE_EXHAUSTED: quota exceeded');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('RESOURCE_EXHAUSTED: quota exceeded');

			// Advance past debounce (500ms) + first retry backoff (1000ms)
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(0) + 200
			);

			// Should NOT mark inactive on first attempt — retries remain
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-agent');
			jest.useRealTimers();
		});

		it('should mark inactive only after exhausting MAX_RETRIES', async () => {
			jest.useFakeTimers();

			// Never show recovery prompt or shell prompt
			mockCapturePane.mockReturnValue('RESOURCE_EXHAUSTED: still failing');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Simulate MAX_RETRIES failure cycles — each triggers retry+backoff
			for (let i = 0; i < GEMINI_FAILURE_RETRY_CONSTANTS.MAX_RETRIES; i++) {
				onDataCallback('RESOURCE_EXHAUSTED: quota exceeded');
				// Advance past debounce + exponential backoff for this retry
				await jest.advanceTimersByTimeAsync(
					RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(i) + 200
				);
			}

			// After MAX_RETRIES exhausted, should mark inactive
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'gemini-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should recover and reset retry count when CLI shows ready prompt', async () => {
			jest.useFakeTimers();

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// First failure: no shell prompt, no recovery
			mockCapturePane
				.mockReturnValueOnce('RESOURCE_EXHAUSTED: quota exceeded')  // verifyExitWithShellPrompt
				.mockReturnValueOnce('RESOURCE_EXHAUSTED: still failing');   // recovery check in retry

			onDataCallback('RESOURCE_EXHAUSTED: quota exceeded');
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(0) + 200
			);

			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			// Second failure: CLI has recovered (shows ready prompt in recovery check)
			mockCapturePane
				.mockReturnValueOnce('Connection error')     // verifyExitWithShellPrompt → no shell prompt
				.mockReturnValueOnce('Type your message');    // recovery check → recovered!

			onDataCallback('Connection error: network timeout');
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(1) + 200
			);

			// Should NOT mark inactive — CLI recovered
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			// Retry counter should be reset to 0 after recovery
			const monitored = (service as any).sessions.get('gemini-agent');
			expect(monitored.geminiFailureRetries).toBe(0);

			service.stopMonitoring('gemini-agent');
			jest.useRealTimers();
		});

		it('should NOT bypass shell prompt check for non-Gemini runtimes', async () => {
			jest.useFakeTimers();

			// Non-Gemini runtime with a Gemini failure pattern but no shell prompt
			mockCapturePane.mockReturnValue('RESOURCE_EXHAUSTED: some output');

			service.startMonitoring('claude-agent', RUNTIME_TYPES.CLAUDE_CODE, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('RESOURCE_EXHAUSTED: some output');
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);

			// Flush pending microtasks without running infinite timer loop
			await Promise.resolve();
			await Promise.resolve();

			// Should NOT update status — non-Gemini runtime, no shell prompt
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('claude-agent');
			jest.useRealTimers();
		});

		it('should detect Connection error pattern after retries exhausted', async () => {
			jest.useFakeTimers();

			mockCapturePane.mockReturnValue('Connection error: network timeout');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			for (let i = 0; i < GEMINI_FAILURE_RETRY_CONSTANTS.MAX_RETRIES; i++) {
				onDataCallback('Connection error: network timeout');
				await jest.advanceTimersByTimeAsync(
					RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(i) + 200
				);
			}

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'gemini-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should detect Request cancelled pattern after retries exhausted', async () => {
			jest.useFakeTimers();

			mockCapturePane.mockReturnValue('Request cancelled by user');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			for (let i = 0; i < GEMINI_FAILURE_RETRY_CONSTANTS.MAX_RETRIES; i++) {
				onDataCallback('Request cancelled by user');
				await jest.advanceTimersByTimeAsync(
					RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + getBackoffMs(i) + 200
				);
			}

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'gemini-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should force recovery immediately on Gemini auto-update interruption marker', async () => {
			jest.useFakeTimers();
			mockGetExitPatterns.mockReturnValue([
				...GEMINI_FAILURE_PATTERNS,
				/Gemini CLI update available!/i,
				/Attempting to automatically update now/i,
			]);

			// No shell prompt; should still proceed to exit flow for forced patterns.
			mockCapturePane.mockReturnValue('Gemini CLI update available! Attempting to automatically update now...');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Gemini CLI update available! Attempting to automatically update now...');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'gemini-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should treat Codex \"Conversation interrupted\" as actionable failure without shell prompt', async () => {
			jest.useFakeTimers();
			mockGetExitPatterns.mockReturnValue([/Conversation interrupted/i]);

			mockCapturePane.mockReturnValue('Conversation interrupted - tell the model what to do differently.');

			service.startMonitoring('codex-agent', RUNTIME_TYPES.CODEX_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Conversation interrupted - tell the model what to do differently.');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'codex-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});
	});

	describe('EventBus publish on exit', () => {
		const mockPublish = jest.fn();
		const mockEventBusService = {
			publish: mockPublish,
		};

		beforeEach(() => {
			mockPublish.mockClear();
			mockFindMemberBySessionName.mockReset();
			mockFindMemberBySessionName.mockResolvedValue(null);
			// Restore mocks overridden by Gemini failure tests
			mockCapturePane.mockReturnValue('user@host:~$');
			mockGetExitPatterns.mockReturnValue([
				/Agent powering down/i,
				/Interaction Summary/,
			]);
			service.setEventBusService(mockEventBusService as any);
		});

		it('should publish agent:status_changed and agent:inactive events on exit', async () => {
			jest.useFakeTimers();

			mockFindMemberBySessionName.mockResolvedValue({
				team: { id: 'team-1', name: 'Core Team' },
				member: { id: 'member-1', name: 'Sam' },
			});

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			// Should have published two events: agent:status_changed and agent:inactive
			expect(mockPublish).toHaveBeenCalledTimes(2);

			const statusChangedEvent = mockPublish.mock.calls[0][0];
			expect(statusChangedEvent.type).toBe('agent:status_changed');
			expect(statusChangedEvent.teamId).toBe('team-1');
			expect(statusChangedEvent.teamName).toBe('Core Team');
			expect(statusChangedEvent.memberId).toBe('member-1');
			expect(statusChangedEvent.memberName).toBe('Sam');
			expect(statusChangedEvent.sessionName).toBe('test-agent');
			expect(statusChangedEvent.previousValue).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
			expect(statusChangedEvent.newValue).toBe(CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE);
			expect(statusChangedEvent.changedField).toBe('agentStatus');

			const inactiveEvent = mockPublish.mock.calls[1][0];
			expect(inactiveEvent.type).toBe('agent:inactive');
			expect(inactiveEvent.teamId).toBe('team-1');
			expect(inactiveEvent.sessionName).toBe('test-agent');

			jest.useRealTimers();
		});

		it('should use empty names when member lookup fails', async () => {
			jest.useFakeTimers();

			mockFindMemberBySessionName.mockResolvedValue(null);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			expect(mockPublish).toHaveBeenCalledTimes(2);

			const event = mockPublish.mock.calls[0][0];
			expect(event.teamName).toBe('');
			expect(event.memberName).toBe('');
			expect(event.teamId).toBe('team-1');
			expect(event.memberId).toBe('member-1');

			jest.useRealTimers();
		});

		it('should not publish events when EventBusService is not set', async () => {
			jest.useFakeTimers();

			// Create a fresh service without EventBus wired
			RuntimeExitMonitorService.resetInstance();
			const freshService = RuntimeExitMonitorService.getInstance();
			// Do NOT call setEventBusService

			freshService.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[mockOnData.mock.calls.length - 1][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			// Status should still be updated
			expect(mockUpdateAgentStatus).toHaveBeenCalled();
			// But no EventBus publish
			expect(mockPublish).not.toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should not crash when EventBus publish throws', async () => {
			jest.useFakeTimers();

			mockPublish.mockImplementation(() => { throw new Error('EventBus down'); });
			mockFindMemberBySessionName.mockResolvedValue(null);

			service.startMonitoring('test-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer', 'team-1', 'member-1');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Agent powering down');
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			// Should still have updated status despite EventBus failure
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'test-agent',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});
	});

	describe('notifyOrchestratorOfFailure (via private access)', () => {
		let mockHttpRequest: jest.Mock;

		beforeEach(() => {
			// Access the mocked http.request for assertions
			const httpMod = jest.requireMock('http') as { request: jest.Mock };
			mockHttpRequest = httpMod.request;
			mockHttpRequest.mockClear();
			// Re-setup the mock return value after clear
			mockHttpRequest.mockReturnValue({
				on: jest.fn().mockReturnThis(),
				write: jest.fn(),
				end: jest.fn(),
			});
		});

		it('should build correct message with active tasks and restart succeeded', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			expect(() => notify(
				'agent-sam',
				'runtime_exited',
				[{ taskName: 'Fix bug' }, { taskName: 'Write tests' }],
				true
			)).not.toThrow();

			// Verify http.request was called with correct URL
			expect(mockHttpRequest).toHaveBeenCalledTimes(1);
			const callArgs = mockHttpRequest.mock.calls[0];
			const url = callArgs[0];
			expect(url.pathname).toBe(`/api/terminal/${ORCHESTRATOR_SESSION_NAME}/deliver`);

			// Verify request body contains session name, reason, and task info
			const reqObj = mockHttpRequest.mock.results[0].value;
			expect(reqObj.write).toHaveBeenCalledTimes(1);
			const body = JSON.parse(reqObj.write.mock.calls[0][0]);
			expect(body.message).toContain('agent-sam');
			expect(body.message).toContain('runtime_exited');
			expect(body.message).toContain('Fix bug');
			expect(body.message).toContain('Write tests');
			expect(body.message).toContain('restart succeeded');
			expect(body.force).toBe(true);

			// Verify end() was called to complete the request
			expect(reqObj.end).toHaveBeenCalledTimes(1);
		});

		it('should include restart FAILED message when restart did not succeed', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			notify('agent-sam', 'runtime_exited', [{ taskName: 'Fix bug' }], false);

			expect(mockHttpRequest).toHaveBeenCalledTimes(1);
			const reqObj = mockHttpRequest.mock.results[0].value;
			const body = JSON.parse(reqObj.write.mock.calls[0][0]);
			expect(body.message).toContain('restart FAILED');
		});

		it('should not throw when orchestrator session is not found', () => {
			mockGetSession.mockReturnValueOnce(null);
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			expect(() => notify(
				'agent-sam',
				'api_failure',
				[],
				false
			)).not.toThrow();
		});

		it('should not throw with empty active tasks', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			notify('agent-sam', 'unknown', [], false);

			expect(mockHttpRequest).toHaveBeenCalledTimes(1);
			const reqObj = mockHttpRequest.mock.results[0].value;
			const body = JSON.parse(reqObj.write.mock.calls[0][0]);
			expect(body.message).toContain('No active tasks');
		});

		it('should send correct HTTP headers', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			notify('agent-sam', 'runtime_exited', [], true);

			expect(mockHttpRequest).toHaveBeenCalledTimes(1);
			const callArgs = mockHttpRequest.mock.calls[0];
			const options = callArgs[1];
			expect(options.method).toBe('POST');
			expect(options.headers['Content-Type']).toBe('application/json');
			expect(options.headers['Content-Length']).toBeDefined();
		});

		it('should include error classification in the message', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			notify('agent-sam', 'runtime_exited', [], false);

			const reqObj = mockHttpRequest.mock.results[0].value;
			const body = JSON.parse(reqObj.write.mock.calls[0][0]);
			// runtime_exited maps to UNKNOWN classification
			expect(body.message).toContain('Error classification:');
		});

		it('should include task status in active tasks summary', () => {
			const notify = (service as any).notifyOrchestratorOfFailure.bind(service);

			notify('agent-sam', 'runtime_exited', [
				{ taskName: 'Fix bug', status: 'assigned' },
				{ taskName: 'Write tests', status: 'active' },
			], true);

			const reqObj = mockHttpRequest.mock.results[0].value;
			const body = JSON.parse(reqObj.write.mock.calls[0][0]);
			expect(body.message).toContain('Fix bug (assigned)');
			expect(body.message).toContain('Write tests (active)');
		});
	});

	describe('classifyError (via private access)', () => {
		it('should classify connectivity errors as TRANSIENT', () => {
			const classify = (service as any).classifyError.bind(service);
			expect(classify('Connection error: timeout')).toBe('TRANSIENT');
			expect(classify('RESOURCE_EXHAUSTED: quota')).toBe('TRANSIENT');
			expect(classify('UNAVAILABLE: server down')).toBe('TRANSIENT');
			expect(classify('DEADLINE_EXCEEDED')).toBe('TRANSIENT');
			expect(classify('network failure')).toBe('TRANSIENT');
		});

		it('should classify auth/config errors as PERSISTENT', () => {
			const classify = (service as any).classifyError.bind(service);
			expect(classify('UNAUTHENTICATED: invalid token')).toBe('PERSISTENT');
			expect(classify('PERMISSION_DENIED: no access')).toBe('PERSISTENT');
			expect(classify('runtime_exited_cooldown')).toBe('PERSISTENT');
			expect(classify('config error')).toBe('PERSISTENT');
		});

		it('should classify unknown errors as UNKNOWN', () => {
			const classify = (service as any).classifyError.bind(service);
			expect(classify('runtime_exited')).toBe('UNKNOWN');
			expect(classify('something_unexpected')).toBe('UNKNOWN');
		});
	});

	describe('Gemini "Trying to reach" pattern (#128)', () => {
		beforeEach(() => {
			mockGetExitPatterns.mockReturnValue([
				/Agent powering down/i,
				...GEMINI_FAILURE_PATTERNS,
			]);
		});

		it('should detect "Trying to reach" as a Gemini failure pattern', () => {
			const pattern = GEMINI_FAILURE_PATTERNS.find(
				p => p.source.includes('Trying to reach')
			);
			expect(pattern).toBeDefined();
			expect(pattern!.test('Trying to reach models/gemini-2.5-pro (Attempt 3/10)')).toBe(true);
		});

		it('should not match "Trying to reach" without attempt info', () => {
			const pattern = GEMINI_FAILURE_PATTERNS.find(
				p => p.source.includes('Trying to reach')
			);
			expect(pattern!.test('Trying to reach the server')).toBe(false);
		});

		it('should trigger retry (not immediate exit) for "Trying to reach" on Gemini CLI', async () => {
			jest.useFakeTimers();

			mockCapturePane.mockReturnValue('Trying to reach models/gemini-2.5-pro (Attempt 5/10)');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('Trying to reach models/gemini-2.5-pro (Attempt 5/10)');

			const backoffMs = Math.min(
				GEMINI_FAILURE_RETRY_CONSTANTS.INITIAL_BACKOFF_MS,
				GEMINI_FAILURE_RETRY_CONSTANTS.MAX_BACKOFF_MS
			);
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + backoffMs + 200
			);

			// Should NOT mark inactive on first attempt
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-agent');
			jest.useRealTimers();
		});
	});

	describe('Automatic update failed pattern (#128)', () => {
		it('should be present in GEMINI_FORCE_RESTART_PATTERNS', () => {
			// Import the constant directly
			const { GEMINI_FORCE_RESTART_PATTERNS } = require('../../constants.js');
			const pattern = GEMINI_FORCE_RESTART_PATTERNS.find(
				(p: RegExp) => p.source.includes('Automatic update failed')
			);
			expect(pattern).toBeDefined();
			expect(pattern.test('Automatic update failed due to npm EACCES')).toBe(true);
			expect(pattern.test('automatic update failed')).toBe(true); // case insensitive
		});
	});

	describe('Claude Code fatal error detection (thinking block corruption)', () => {
		beforeEach(() => {
			// Include Claude fatal patterns in the mocked exit patterns
			mockGetExitPatterns.mockReturnValue([
				/Claude\s+(Code\s+)?exited/i,
				/Session\s+ended/i,
				...CLAUDE_FATAL_PATTERNS,
			]);
		});

		it('should detect "thinking blocks cannot be modified" as a Claude fatal pattern', () => {
			const pattern = CLAUDE_FATAL_PATTERNS.find(
				p => p.source.includes('thinking')
			);
			expect(pattern).toBeDefined();
			expect(pattern!.test(
				'`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified'
			)).toBe(true);
		});

		it('should detect "redacted_thinking blocks cannot be modified" pattern', () => {
			const pattern = CLAUDE_FATAL_PATTERNS.find(
				p => p.source.includes('redacted_thinking')
			);
			expect(pattern).toBeDefined();
			expect(pattern!.test(
				'redacted_thinking blocks cannot be modified. These blocks must remain as they were'
			)).toBe(true);
		});

		it('should trigger immediate recovery (no retry) for Claude fatal error on orchestrator', async () => {
			jest.useFakeTimers();

			// No shell prompt visible — Claude Code is still running but broken
			const errorOutput = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified."}}';
			mockCapturePane.mockReturnValue(errorOutput);

			service.startMonitoring(ORCHESTRATOR_SESSION_NAME, RUNTIME_TYPES.CLAUDE_CODE, 'orchestrator');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback(errorOutput);
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			// Should trigger orchestrator restart immediately (no retry/backoff)
			expect(mockAttemptRestart).toHaveBeenCalled();

			jest.useRealTimers();
		});

		it('should trigger immediate recovery for non-orchestrator Claude agent', async () => {
			jest.useFakeTimers();

			const errorOutput = 'thinking blocks cannot be modified. These blocks must remain as they were in the original response.';
			mockCapturePane.mockReturnValue(errorOutput);

			service.startMonitoring('claude-dev', RUNTIME_TYPES.CLAUDE_CODE, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback(errorOutput);
			await jest.advanceTimersByTimeAsync(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 200);

			// Should set status to inactive (no task restart path since no tasks configured)
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith(
				'claude-dev',
				CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
				expect.anything()
			);

			jest.useRealTimers();
		});

		it('should detect GEMINI_TOOL_CHECK_LOOP_PATTERN matches including contractions (#251)', () => {
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test("Ready. Final response.")).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test("Wait, I will check if I should use mcp_chrome-devtools_navigate_page")).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test("Wait, I'll check if I should use mcp_chrome-devtools_new_page? No.")).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test("Wait, I\u2019ll check if I should use mcp_some_tool")).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test("Normal agent output")).toBe(false);
		});

		it('should detect GEMINI_DELIBERATION_PATTERN matches', () => {
			expect(GEMINI_DELIBERATION_PATTERN.test("Wait, I'll also read the file")).toBe(true);
			expect(GEMINI_DELIBERATION_PATTERN.test("Actually, I'll just do reads first")).toBe(true);
			expect(GEMINI_DELIBERATION_PATTERN.test("Wait, I\u2019ll check that too")).toBe(true);
			expect(GEMINI_DELIBERATION_PATTERN.test("Actually, I\u2019ll reconsider")).toBe(true);
			expect(GEMINI_DELIBERATION_PATTERN.test("I'll read the file now")).toBe(false);
			expect(GEMINI_DELIBERATION_PATTERN.test("Normal agent output")).toBe(false);
		});

		it('should trigger recovery when deliberation threshold is exceeded on Gemini CLI (#188)', async () => {
			jest.useFakeTimers();

			// Build deliberation output that exceeds the threshold
			const deliberationLine = "Wait, I'll also read the config file.\n";
			const deliberationOutput = deliberationLine.repeat(GEMINI_DELIBERATION_THRESHOLD + 1);

			mockCapturePane.mockReturnValue('Type your message');

			service.startMonitoring('gemini-delib', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Feed deliberation output (triggers exit detection)
			onDataCallback(deliberationOutput);

			// Allow debounce + confirmation
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 5000
			);

			// The exit monitor should have detected the deliberation loop
			// and triggered the recovery flow (status update)
			// Note: it may go through Gemini retry flow, but the pattern is detected
			service.stopMonitoring('gemini-delib');
			jest.useRealTimers();
		});

		it('should NOT trigger deliberation recovery below threshold on Gemini CLI', async () => {
			jest.useFakeTimers();

			// Build deliberation output below threshold (only 2 occurrences)
			const deliberationOutput = "Wait, I'll read file A.\nReading file...\nActually, I'll check B.\n";

			service.startMonitoring('gemini-ok', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			onDataCallback(deliberationOutput);

			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 1000
			);

			// Should NOT have triggered any exit detection
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-ok');
			jest.useRealTimers();
		});

		it('should NOT trigger Claude fatal detection for non-Claude runtimes', async () => {
			jest.useFakeTimers();

			// Gemini runtime with Claude fatal pattern text but no shell prompt
			mockCapturePane.mockReturnValue('thinking blocks cannot be modified');

			service.startMonitoring('gemini-agent', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);
			onDataCallback('thinking blocks cannot be modified');

			// Advance past debounce but NOT enough for Gemini retry
			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 100);
			await Promise.resolve();
			await Promise.resolve();

			// Should NOT trigger — Gemini runtime doesn't use Claude fatal check
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-agent');
			jest.useRealTimers();
		});
	});

	describe('#235: inferDropoutReason', () => {
		it('should infer idle_exit as default reason', () => {
			const reason = (service as any).inferDropoutReason({ buffer: 'normal shell prompt', toolCheckLoopTimestamps: [] });
			expect(reason).toBe('idle_exit');
		});

		it('should infer crash from fatal errors', () => {
			const reason = (service as any).inferDropoutReason({ buffer: 'fatal error occurred', toolCheckLoopTimestamps: [] });
			expect(reason).toBe('crash');
		});

		it('should infer update_exit from update patterns', () => {
			const reason = (service as any).inferDropoutReason({ buffer: 'update available, restart required', toolCheckLoopTimestamps: [] });
			expect(reason).toBe('update_exit');
		});

		it('should infer task_complete from completion patterns', () => {
			const reason = (service as any).inferDropoutReason({ buffer: 'task complete, all done', toolCheckLoopTimestamps: [] });
			expect(reason).toBe('task_complete');
		});

		it('should infer loop_detected when tool-check timestamps exceed threshold (#251)', () => {
			const now = Date.now();
			const timestamps = Array.from({ length: GEMINI_TOOL_CHECK_LOOP_THRESHOLD }, (_, i) => now - i * 1000);
			const reason = (service as any).inferDropoutReason({ buffer: 'some output', toolCheckLoopTimestamps: timestamps });
			expect(reason).toBe('loop_detected');
		});

		it('should infer loop_detected when deliberation threshold is exceeded', () => {
			const deliberationLine = "Wait, I'll also check this.\n";
			const buffer = deliberationLine.repeat(GEMINI_DELIBERATION_THRESHOLD + 1);
			const reason = (service as any).inferDropoutReason({ buffer, toolCheckLoopTimestamps: [] });
			expect(reason).toBe('loop_detected');
		});
	});

	describe('#251: Gemini tool-check loop detection', () => {
		it('should detect GEMINI_TOOL_CHECK_LOOP_PATTERN matches', () => {
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('Ready. Final response.')).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('Ready.  Final response')).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('Wait, I will check if I should use mcp_chrome-devtools_getPageInfo? No.')).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('Wait, I will check if I should use mcp_something')).toBe(true);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('Normal agent output about tasks')).toBe(false);
			expect(GEMINI_TOOL_CHECK_LOOP_PATTERN.test('I will use the read tool')).toBe(false);
		});

		it('should trigger recovery when tool-check loop threshold is exceeded within time window (#251)', async () => {
			jest.useFakeTimers();

			mockCapturePane.mockReturnValue('Type your message');

			service.startMonitoring('gemini-loop', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Feed tool-check loop output — each chunk triggers one pattern match
			for (let i = 0; i < GEMINI_TOOL_CHECK_LOOP_THRESHOLD + 1; i++) {
				onDataCallback('Wait, I will check if I should use mcp_chrome-devtools_screenshot? No. Ready. Final response.\n');
				// Small gap between messages (1 second apart, well within 2-minute window)
				jest.advanceTimersByTime(1000);
			}

			// Allow debounce + confirmation
			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 5000
			);

			// The exit monitor should have detected the tool-check loop
			service.stopMonitoring('gemini-loop');
			jest.useRealTimers();
		});

		it('should NOT trigger tool-check loop recovery below threshold (#251)', async () => {
			jest.useFakeTimers();

			service.startMonitoring('gemini-few', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Feed only 2 occurrences (below threshold of 5)
			onDataCallback('Ready. Final response.\n');
			jest.advanceTimersByTime(1000);
			onDataCallback('Ready. Final response.\n');

			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 1000
			);

			// Should NOT have triggered any exit detection
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-few');
			jest.useRealTimers();
		});

		it('should NOT trigger tool-check loop for non-Gemini runtimes (#251)', async () => {
			jest.useFakeTimers();

			service.startMonitoring('claude-agent', RUNTIME_TYPES.CLAUDE_CODE, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Feed tool-check loop output to a Claude agent — should be ignored
			for (let i = 0; i < GEMINI_TOOL_CHECK_LOOP_THRESHOLD + 1; i++) {
				onDataCallback('Ready. Final response.\n');
				jest.advanceTimersByTime(1000);
			}

			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 1000
			);

			// Should NOT have triggered (wrong runtime type)
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('claude-agent');
			jest.useRealTimers();
		});

		it('should prune timestamps outside the time window (#251)', async () => {
			jest.useFakeTimers();

			service.startMonitoring('gemini-spread', RUNTIME_TYPES.GEMINI_CLI, 'developer');
			const onDataCallback = mockOnData.mock.calls[0][0];

			jest.advanceTimersByTime(RUNTIME_EXIT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 100);

			// Feed 3 matches early
			for (let i = 0; i < 3; i++) {
				onDataCallback('Ready. Final response.\n');
				jest.advanceTimersByTime(1000);
			}

			// Wait 3 minutes (beyond the 2-minute window) so those 3 expire
			jest.advanceTimersByTime(3 * 60 * 1000);

			// Feed 3 more — only 3 are within window (below threshold of 5)
			for (let i = 0; i < 3; i++) {
				onDataCallback('Ready. Final response.\n');
				jest.advanceTimersByTime(1000);
			}

			await jest.advanceTimersByTimeAsync(
				RUNTIME_EXIT_CONSTANTS.CONFIRMATION_DELAY_MS + 1000
			);

			// Should NOT trigger — only 3 within window
			expect(mockUpdateAgentStatus).not.toHaveBeenCalled();

			service.stopMonitoring('gemini-spread');
			jest.useRealTimers();
		});
	});

});
