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
		};
		hasPendingWork = jest.fn().mockReturnValue(true);

		service.setDependencies(mockSessionBackend as any, hasPendingWork);

		// Set up OrchestratorRestartService with mock dependencies
		const restartService = OrchestratorRestartService.getInstance();
		restartService.setDependencies(
			{ createAgentSession: jest.fn().mockResolvedValue({ success: true }) } as any,
			mockSessionBackend as any,
		);

		// Record initial activity so the tracker has a baseline
		PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);
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

			// Record recent activity
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);

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

			// Simulate orchestrator responding
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);
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

		it('should set inProgressSince when orchestrator has recent activity', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record recent activity so idleTime is low
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);

			await service.performCheck();

			expect(service.getState().inProgressSince).not.toBeNull();
		});

		it('should send heartbeat when stuck in_progress exceeds timeout', async () => {
			service.start();
			service.stop();

			jest.advanceTimersByTime(ORCHESTRATOR_HEARTBEAT_CONSTANTS.STARTUP_GRACE_PERIOD_MS + 1);

			// Record activity so idleTime is low
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);

			// First performCheck sets inProgressSince
			await service.performCheck();
			expect(service.getState().inProgressSince).not.toBeNull();

			// Backdate inProgressSince to simulate being stuck past the timeout
			(service as any).inProgressSince = Date.now() - ORCHESTRATOR_HEARTBEAT_CONSTANTS.IN_PROGRESS_TIMEOUT_MS - 1;

			// Record activity again so idleTime stays low on the next check
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);

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

			// Record activity, performCheck sets inProgressSince
			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);
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

			PtyActivityTrackerService.getInstance().recordActivity(ORCHESTRATOR_SESSION_NAME);
			await service.performCheck();
			expect(service.getState().inProgressSince).not.toBeNull();

			service.stop();

			expect(service.getState().inProgressSince).toBeNull();
		});
	});
});
