/**
 * Tests for OrchestratorHeartbeatMonitorService
 */

// Mock external dependencies
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				debug: jest.fn(),
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

jest.mock('../memory/memory.service.js', () => ({
	MemoryService: {
		getInstance: () => ({
			initializeForSession: jest.fn().mockResolvedValue(undefined),
		}),
	},
}));

jest.mock('../../websocket/terminal.gateway.js', () => ({
	getTerminalGateway: () => ({
		startOrchestratorChatMonitoring: jest.fn(),
	}),
}));

jest.mock('../slack/slack.service.js', () => ({
	getSlackService: () => ({
		sendNotification: jest.fn().mockResolvedValue(undefined),
	}),
}));

const mockIsAgentActive = jest.fn().mockResolvedValue(false);
jest.mock('./orchestrator-status.service.js', () => ({
	isAgentActive: (...args: unknown[]) => mockIsAgentActive(...(args as [])),
}));

const mockHandleUserMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../agent/auditor-scheduler.service.js', () => ({
	AuditorSchedulerService: {
		getInstance: () => ({
			handleUserMessage: mockHandleUserMessage,
		}),
	},
}));

import { OrchestratorHeartbeatMonitorService } from './orchestrator-heartbeat-monitor.service.js';
import { OrchestratorRestartService } from './orchestrator-restart.service.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { ORCHESTRATOR_HEARTBEAT_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/**
 * Helper to run performCheck and flush the internal paste delay timer.
 * sendHeartbeatRequest() now uses a setTimeout to delay between message
 * and Enter writes; with fake timers we must advance to resolve it.
 */
async function performCheckAndFlush(service: OrchestratorHeartbeatMonitorService): Promise<void> {
	const p = service.performCheck();
	await jest.advanceTimersByTimeAsync(5000);
	await p;
}

describe('OrchestratorHeartbeatMonitorService', () => {
	let service: OrchestratorHeartbeatMonitorService;
	let mockSessionBackend: {
		sessionExists: jest.Mock;
		getSession: jest.Mock;
		killSession: jest.Mock;
		isChildProcessAlive: jest.Mock;
		captureOutput: jest.Mock;
	};
	let mockSession: {
		write: jest.Mock;
		name: string;
	};
	let hasPendingWork: jest.Mock<boolean, []>;

	beforeEach(() => {
		jest.useFakeTimers();

		OrchestratorHeartbeatMonitorService.resetInstance();
		OrchestratorRestartService.resetInstance();
		PtyActivityTrackerService.resetInstance();

		service = OrchestratorHeartbeatMonitorService.getInstance();

		mockSession = {
			write: jest.fn(),
			name: ORCHESTRATOR_SESSION_NAME,
		};

		mockSessionBackend = {
			sessionExists: jest.fn().mockReturnValue(true),
			getSession: jest.fn().mockReturnValue(mockSession),
			killSession: jest.fn().mockResolvedValue(undefined),
			isChildProcessAlive: jest.fn().mockReturnValue(true),
			captureOutput: jest.fn().mockReturnValue(''),
		};
		hasPendingWork = jest.fn().mockReturnValue(true);

		service.setDependencies(mockSessionBackend as any, hasPendingWork);

		// Set up OrchestratorRestartService with mock dependencies
		const restartService = OrchestratorRestartService.getInstance();
		restartService.setDependencies(
			{ createAgentSession: jest.fn().mockResolvedValue({ success: true }) } as any,
			mockSessionBackend as any,
		);

		// Record initial API activity so the tracker has a baseline.
		// The heartbeat monitor now uses getApiIdleTimeMs() to verify responses.
		PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);
	});

	afterEach(() => {
		OrchestratorHeartbeatMonitorService.resetInstance();
		OrchestratorRestartService.resetInstance();
		PtyActivityTrackerService.resetInstance();
		jest.useRealTimers();
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = OrchestratorHeartbeatMonitorService.getInstance();
			const b = OrchestratorHeartbeatMonitorService.getInstance();
			expect(a).toBe(b);
		});

		it('should create a fresh instance after reset', () => {
			const a = OrchestratorHeartbeatMonitorService.getInstance();
			OrchestratorHeartbeatMonitorService.resetInstance();
			const b = OrchestratorHeartbeatMonitorService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('start/stop', () => {
		it('should start and stop the monitor', () => {
			expect(service.isRunning()).toBe(false);

			service.start();
			expect(service.isRunning()).toBe(true);

			service.stop();
			expect(service.isRunning()).toBe(false);
		});

		it('should not start twice', () => {
			service.start();
			service.start(); // Should warn but not crash
			expect(service.isRunning()).toBe(true);
		});
	});

	describe('getState', () => {
		it('should return initial state', () => {
			const state = service.getState();
			expect(state.isRunning).toBe(false);
			expect(state.heartbeatRequestSentAt).toBeNull();
			expect(state.heartbeatRequestCount).toBe(0);
			expect(state.autoRestartCount).toBe(0);
			expect(state.startedAt).toBeNull();
		});

		it('should update state after start', () => {
			service.start();
			const state = service.getState();
			expect(state.isRunning).toBe(true);
			expect(state.startedAt).not.toBeNull();
		});
	});

	describe('performCheck', () => {
		it('should skip during startup grace period', async () => {
			service.start();

			// Within grace period
			await service.performCheck();

			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should skip if session backend not set', async () => {
			OrchestratorHeartbeatMonitorService.resetInstance();
			const freshService = OrchestratorHeartbeatMonitorService.getInstance();
			// Don't set dependencies

			freshService.start();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			await freshService.performCheck();

			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should skip if orchestrator session does not exist', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);

			service.start();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			await service.performCheck();

			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should do nothing when orchestrator has recent activity', async () => {
			service.start();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record recent API activity (heartbeat monitor checks API idle time, not PTY)
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);

			await service.performCheck();

			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should send heartbeat request when orchestrator is idle', async () => {
			// Start then stop to set startedAt without interval interference
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Make orchestrator appear idle by advancing time past the threshold
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// performCheck triggers sendHeartbeatRequest which has an internal paste delay
			await performCheckAndFlush(service);

			// Message and Enter should be sent as separate writes (bracketed paste fix)
			expect(mockSession.write).toHaveBeenCalledWith(
				ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_MESSAGE
			);
			expect(mockSession.write).toHaveBeenCalledWith('\r');

			const state = service.getState();
			expect(state.heartbeatRequestSentAt).not.toBeNull();
			expect(state.heartbeatRequestCount).toBe(1);
		});

		it('should skip heartbeat request when idle and no pending work', async () => {
			hasPendingWork.mockReturnValue(false);

			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			await service.performCheck();

			expect(mockSession.write).not.toHaveBeenCalled();
			expect(service.getState().heartbeatRequestSentAt).toBeNull();
		});

		it('should clear pending state when orchestrator responds', async () => {
			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Make idle and trigger heartbeat request
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);
			expect(service.getState().heartbeatRequestSentAt).not.toBeNull();

			// Simulate orchestrator responding (must be API activity, not just PTY echo)
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);
			await service.performCheck();

			expect(service.getState().heartbeatRequestSentAt).toBeNull();
		});

		it('should trigger auto-restart after heartbeat request timeout', async () => {
			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			// Start then immediately stop to set startedAt without interval interference
			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Make idle and trigger heartbeat request
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);
			expect(service.getState().heartbeatRequestSentAt).not.toBeNull();

			// Advance past restart threshold without any response
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(restartSpy).toHaveBeenCalled();
			expect(service.getState().autoRestartCount).toBe(1);

			restartSpy.mockRestore();
		});

		it('should not trigger restart before restart threshold', async () => {
			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			// Start then immediately stop to set startedAt without interval interference
			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Make idle and trigger heartbeat request
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);
			expect(service.getState().heartbeatRequestSentAt).not.toBeNull();

			// Advance only partway through restart threshold
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS - 10000);
			await service.performCheck();

			expect(restartSpy).not.toHaveBeenCalled();

			restartSpy.mockRestore();
		});

		it('should handle session write errors gracefully', async () => {
			mockSessionBackend.getSession.mockReturnValue(null);

			service.start();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Should not throw (getSession returns null, so no timer is created)
			await expect(service.performCheck()).resolves.toBeUndefined();
		});

		it('should handle restart failure gracefully', async () => {
			const restartSpy = jest.spyOn(
				OrchestratorRestartService.getInstance(),
				'attemptRestart'
			).mockRejectedValue(new Error('restart failed'));

			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Trigger heartbeat request
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);

			// Trigger restart
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS + 1);

			// Should not throw
			await expect(service.performCheck()).resolves.toBeUndefined();

			restartSpy.mockRestore();
		});

		it('should trigger immediate restart when child process is dead', async () => {
			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Child process is dead
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			await service.performCheck();

			// Should trigger restart immediately without sending heartbeat
			expect(restartSpy).toHaveBeenCalled();
			expect(mockSession.write).not.toHaveBeenCalled();
			expect(service.getState().autoRestartCount).toBe(1);

			restartSpy.mockRestore();
		});

		it('should not trigger immediate restart when child process is alive', async () => {
			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Child process is alive
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Also make orchestrator idle so we can verify it proceeds to heartbeat logic
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);

			// Should NOT have triggered immediate restart
			expect(restartSpy).not.toHaveBeenCalled();
			// Should have proceeded to send heartbeat request instead
			expect(mockSession.write).toHaveBeenCalled();

			restartSpy.mockRestore();
		});

		it('should skip heartbeat request when child process is alive and PTY is active (#194)', async () => {
			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Child process is alive
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Make API idle past the PTY-active threshold (15 min)
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_PTY_ACTIVE_MS + 1);

			// Record PTY activity so it appears active (idle time < PTY_ACTIVE_WINDOW)
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);

			await service.performCheck();

			// Should NOT have sent heartbeat — child alive + PTY active means orchestrator is running a command
			expect(mockSession.write).not.toHaveBeenCalled();
			expect(service.getState().heartbeatRequestSentAt).toBeNull();
		});

		it('should send heartbeat request when child process is alive but PTY is idle (#194)', async () => {
			service.start();
			service.stop();

			// Advance past startup grace period
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Child process is alive
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Make idle past heartbeat threshold (both API and PTY)
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// PTY is NOT active (no recent activity) — so the child-alive check should not suppress
			await performCheckAndFlush(service);

			// Should have sent heartbeat — child alive but PTY idle suggests orchestrator may be stuck
			expect(mockSession.write).toHaveBeenCalled();
		});

		it('should set inProgressSince when orchestrator has recent activity', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record recent API activity so apiIdleTime is low
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);

			await service.performCheck();

			expect(service.getState().inProgressSince).not.toBeNull();
		});

		it('should send heartbeat when stuck in_progress exceeds timeout', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record API activity so apiIdleTime is low
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);

			// First performCheck sets inProgressSince
			await service.performCheck();
			expect(service.getState().inProgressSince).not.toBeNull();

			// Backdate inProgressSince to simulate being stuck past the timeout
			(service as any).inProgressSince = Date.now() - ORCHESTRATOR_HEARTBEAT_CONSTANTS.IN_PROGRESS_TIMEOUT_MS - 1;

			// Record API activity again so apiIdleTime stays low on the next check
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);

			await performCheckAndFlush(service);

			// Heartbeat should have been sent
			expect(mockSession.write).toHaveBeenCalledWith(
				ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_MESSAGE
			);
			expect(mockSession.write).toHaveBeenCalledWith('\r');

			// inProgressSince should be reset after sending heartbeat
			expect(service.getState().inProgressSince).toBeNull();
		});

		it('should reset inProgressSince when orchestrator becomes idle', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record API activity, performCheck sets inProgressSince
			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);
			await service.performCheck();
			expect(service.getState().inProgressSince).not.toBeNull();

			// Advance past heartbeat threshold so orchestrator appears idle
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			await performCheckAndFlush(service);

			// inProgressSince should be reset when the orchestrator becomes idle
			expect(service.getState().inProgressSince).toBeNull();
		});

		it('should reset inProgressSince on stop', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			PtyActivityTrackerService.getInstance().recordApiActivity(ORCHESTRATOR_SESSION_NAME);
			await service.performCheck();
			expect(service.getState().inProgressSince).not.toBeNull();

			service.stop();

			expect(service.getState().inProgressSince).toBeNull();
		});
	});

	describe('per-agent activity tracking (I3)', () => {
		describe('recordAgentApiCall', () => {
			it('should record API call for a new agent', () => {
				service.recordAgentApiCall('agent-1', 'developer');

				const record = service.getAgentActivity('agent-1');
				expect(record).toBeDefined();
				expect(record!.role).toBe('developer');
				expect(record!.suspended).toBe(false);
				expect(record!.lastApiCallTime).toBeGreaterThan(0);
			});

			it('should update lastApiCallTime on subsequent calls', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				const first = service.getAgentActivity('agent-1')!.lastApiCallTime;

				jest.advanceTimersByTime(5000);
				service.recordAgentApiCall('agent-1', 'developer');
				const second = service.getAgentActivity('agent-1')!.lastApiCallTime;

				expect(second).toBeGreaterThan(first);
			});

			it('should un-suspend agent on new API call', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				service.getAgentActivity('agent-1')!.suspended = true;

				service.recordAgentApiCall('agent-1', 'developer');
				expect(service.getAgentActivity('agent-1')!.suspended).toBe(false);
			});
		});

		describe('shouldSkipHeartbeat', () => {
			it('should NOT skip for unknown agents', () => {
				expect(service.shouldSkipHeartbeat('unknown-agent')).toBe(false);
			});

			it('should NEVER skip for orchestrator role', () => {
				service.recordAgentApiCall('crewly-orc', 'orchestrator');
				expect(service.shouldSkipHeartbeat('crewly-orc')).toBe(false);
			});

			it('should skip for agents with recent API activity', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				expect(service.shouldSkipHeartbeat('agent-1')).toBe(true);
			});

			it('should NOT skip for agents with stale API activity', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				jest.advanceTimersByTime(2 * 60 * 1000 + 1);
				expect(service.shouldSkipHeartbeat('agent-1')).toBe(false);
			});

			it('should skip for suspended agents', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				jest.advanceTimersByTime(2 * 60 * 1000 + 1);
				service.getAgentActivity('agent-1')!.suspended = true;
				expect(service.shouldSkipHeartbeat('agent-1')).toBe(true);
			});
		});

		describe('suspendIdleAgents', () => {
			it('should suspend agents idle beyond threshold', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				jest.advanceTimersByTime(10 * 60 * 1000 + 1);

				const suspended = service.suspendIdleAgents();

				expect(suspended).toBe(1);
				expect(service.getAgentActivity('agent-1')!.suspended).toBe(true);
			});

			it('should NOT suspend orchestrator regardless of idle time', () => {
				service.recordAgentApiCall('crewly-orc', 'orchestrator');
				jest.advanceTimersByTime(60 * 60 * 1000);

				const suspended = service.suspendIdleAgents();

				expect(suspended).toBe(0);
				expect(service.getAgentActivity('crewly-orc')!.suspended).toBe(false);
			});

			it('should not double-suspend', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				jest.advanceTimersByTime(10 * 60 * 1000 + 1);

				service.suspendIdleAgents();
				const secondRound = service.suspendIdleAgents();

				expect(secondRound).toBe(0);
			});

			it('should suspend multiple idle agents at once', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				service.recordAgentApiCall('agent-2', 'qa');
				service.recordAgentApiCall('crewly-orc', 'orchestrator');
				jest.advanceTimersByTime(10 * 60 * 1000 + 1);

				const suspended = service.suspendIdleAgents();

				expect(suspended).toBe(2);
				expect(service.getAgentActivity('crewly-orc')!.suspended).toBe(false);
			});
		});

		describe('getState includes agentActivity', () => {
			it('should include agentActivity map in state', () => {
				service.recordAgentApiCall('agent-1', 'developer');

				const state = service.getState();

				expect(state.agentActivity).toBeDefined();
				expect(state.agentActivity.size).toBe(1);
			});

			it('should return a copy of agentActivity', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				const state1 = service.getState();

				service.recordAgentApiCall('agent-2', 'qa');
				const state2 = service.getState();

				expect(state1.agentActivity.size).toBe(1);
				expect(state2.agentActivity.size).toBe(2);
			});
		});

		describe('stop clears agent activity', () => {
			it('should clear all agent activity on stop', () => {
				service.recordAgentApiCall('agent-1', 'developer');
				service.recordAgentApiCall('agent-2', 'qa');

				service.stop();

				expect(service.getAgentActivity('agent-1')).toBeUndefined();
				expect(service.getAgentActivity('agent-2')).toBeUndefined();
			});
		});
	});

	describe('auditor notification on restart', () => {
		beforeEach(() => {
			mockIsAgentActive.mockReset().mockResolvedValue(false);
			mockHandleUserMessage.mockReset().mockResolvedValue(undefined);
		});

		it('should notify auditor when auto-restart is triggered and auditor is active', async () => {
			mockIsAgentActive.mockResolvedValue(true);

			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Make idle and trigger heartbeat request
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);

			// Trigger restart
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockIsAgentActive).toHaveBeenCalledWith('crewly-auditor');
			expect(mockHandleUserMessage).toHaveBeenCalledWith(
				expect.stringContaining('[SYSTEM] Orchestrator heartbeat timeout'),
				expect.objectContaining({ channelId: '', threadTs: '' }),
			);

			restartSpy.mockRestore();
		});

		it('should skip auditor notification when auditor is not active', async () => {
			mockIsAgentActive.mockResolvedValue(false);

			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockIsAgentActive).toHaveBeenCalledWith('crewly-auditor');
			expect(mockHandleUserMessage).not.toHaveBeenCalled();

			restartSpy.mockRestore();
		});

		it('should not block restart when auditor notification fails', async () => {
			mockIsAgentActive.mockResolvedValue(true);
			mockHandleUserMessage.mockRejectedValue(new Error('notification failed'));

			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await performCheckAndFlush(service);

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.RESTART_THRESHOLD_MS + 1);
			await service.performCheck();

			// Restart should still happen despite notification failure
			expect(restartSpy).toHaveBeenCalled();
			expect(service.getState().autoRestartCount).toBe(1);

			restartSpy.mockRestore();
		});

		it('should notify auditor on immediate restart when child process is dead', async () => {
			mockIsAgentActive.mockResolvedValue(true);

			const restartSpy = jest.spyOn(OrchestratorRestartService.getInstance(), 'attemptRestart')
				.mockResolvedValue(true);

			service.start();
			service.stop();
			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);
			await service.performCheck();

			expect(mockIsAgentActive).toHaveBeenCalledWith('crewly-auditor');
			expect(mockHandleUserMessage).toHaveBeenCalledWith(
				expect.stringContaining('[SYSTEM] Orchestrator heartbeat timeout'),
				expect.any(Object),
			);

			restartSpy.mockRestore();
		});
	});
});
