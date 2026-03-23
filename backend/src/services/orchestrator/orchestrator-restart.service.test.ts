/**
 * Tests for OrchestratorRestartService
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

// Mock message replay service (#247)
const mockReplayPendingMessages = jest.fn().mockResolvedValue({
	foundCount: 0,
	replayedCount: 0,
	skippedDuplicate: 0,
	offlineSince: '',
	offlineDurationMs: 0,
});
jest.mock('../messaging/message-replay.service.js', () => ({
	MessageReplayService: jest.fn().mockImplementation(() => ({
		replayPendingMessages: mockReplayPendingMessages,
	})),
}));

// Mock message queue service (#247)
jest.mock('../messaging/message-queue.service.js', () => ({
	MessageQueueService: jest.fn().mockImplementation(() => ({
		loadPersistedState: jest.fn().mockResolvedValue(undefined),
	})),
}));

// Mock chat service (#247)
jest.mock('../chat/chat.service.js', () => ({
	getChatService: () => ({}),
}));

const mockClearSession = jest.fn();
jest.mock('../agent/pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: () => ({
			clearSession: mockClearSession,
		}),
	},
}));

const mockGetOrchestratorStatus = jest.fn();
jest.mock('../core/storage.service.js', () => ({
	StorageService: {
		getInstance: () => ({
			getOrchestratorStatus: mockGetOrchestratorStatus,
		}),
	},
}));

import { OrchestratorRestartService } from './orchestrator-restart.service.js';
import { ORCHESTRATOR_RESTART_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';

describe('OrchestratorRestartService', () => {
	let service: OrchestratorRestartService;
	let mockAgentRegistrationService: {
		createAgentSession: jest.Mock;
	};
	let mockSessionBackend: {
		sessionExists: jest.Mock;
		killSession: jest.Mock;
	};
	let mockSocketIO: {
		emit: jest.Mock;
	};

	beforeEach(() => {
		OrchestratorRestartService.resetInstance();
		service = OrchestratorRestartService.getInstance();

		mockAgentRegistrationService = {
			createAgentSession: jest.fn().mockResolvedValue({ success: true }),
		};
		mockSessionBackend = {
			sessionExists: jest.fn().mockReturnValue(true),
			killSession: jest.fn().mockResolvedValue(undefined),
		};
		mockSocketIO = {
			emit: jest.fn(),
		};

		service.setDependencies(
			mockAgentRegistrationService as any,
			mockSessionBackend as any,
			mockSocketIO
		);

		mockGetOrchestratorStatus.mockResolvedValue({
			runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
		});

		mockClearSession.mockClear();
	});

	afterEach(() => {
		OrchestratorRestartService.resetInstance();
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const instance1 = OrchestratorRestartService.getInstance();
			const instance2 = OrchestratorRestartService.getInstance();
			expect(instance1).toBe(instance2);
		});
	});

	describe('isRestartAllowed', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should allow restart when no restarts have occurred', () => {
			expect(service.isRestartAllowed()).toBe(true);
		});

		it('should deny restart after max restarts in window', async () => {
			// Exhaust restart allowance
			for (let i = 0; i < ORCHESTRATOR_RESTART_CONSTANTS.MAX_RESTARTS_PER_WINDOW; i++) {
				const p = service.attemptRestart();
				await jest.advanceTimersByTimeAsync(6000);
				await p;
			}

			expect(service.isRestartAllowed()).toBe(false);
		});
	});

	describe('attemptRestart', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should successfully restart the orchestrator', async () => {
			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockSessionBackend.killSession).toHaveBeenCalled();
			expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalled();
			expect(mockSocketIO.emit).toHaveBeenCalledWith('orchestrator:restarted', expect.any(Object));
		});

		it('should return false when dependencies are not set', async () => {
			OrchestratorRestartService.resetInstance();
			const freshService = OrchestratorRestartService.getInstance();
			// Don't set dependencies

			const resultPromise = freshService.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(false);
		});

		it('should return false when createAgentSession fails', async () => {
			mockAgentRegistrationService.createAgentSession.mockResolvedValueOnce({
				success: false,
				error: 'session creation failed',
			});

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(false);
		});

		it('should return false when cooldown is active', async () => {
			// Exhaust restarts
			for (let i = 0; i < ORCHESTRATOR_RESTART_CONSTANTS.MAX_RESTARTS_PER_WINDOW; i++) {
				const p = service.attemptRestart();
				await jest.advanceTimersByTimeAsync(6000);
				await p;
			}

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(false);
		});

		it('should prevent concurrent restarts', async () => {
			// Start two restarts simultaneously
			const promise1 = service.attemptRestart();
			const promise2 = service.attemptRestart();

			await jest.advanceTimersByTimeAsync(6000);
			const [result1, result2] = await Promise.all([promise1, promise2]);

			// One should succeed, the other should be rejected as concurrent
			expect([result1, result2]).toContain(true);
			expect([result1, result2]).toContain(false);
		});

		it('should handle killSession error gracefully', async () => {
			mockSessionBackend.killSession.mockRejectedValueOnce(new Error('kill failed'));

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			// Should still succeed even if kill fails
			expect(result).toBe(true);
		});

		it('should continue when session does not exist', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();
		});

		it('should clear PtyActivityTracker data after killing old session', async () => {
			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockClearSession).toHaveBeenCalledWith('crewly-orc');
			// clearSession should be called after kill but before creating new session
			const killOrder = mockSessionBackend.killSession.mock.invocationCallOrder[0];
			const clearOrder = mockClearSession.mock.invocationCallOrder[0];
			const createOrder = mockAgentRegistrationService.createAgentSession.mock.invocationCallOrder[0];
			expect(clearOrder).toBeGreaterThan(killOrder);
			expect(clearOrder).toBeLessThan(createOrder);
		});

		it('should clear PtyActivityTracker even when session does not exist', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			// Should still clear tracker data even if kill was skipped
			expect(mockClearSession).toHaveBeenCalledWith('crewly-orc');
		});

		it('should restart orchestrator with stored runtime type', async () => {
			mockGetOrchestratorStatus.mockResolvedValueOnce({
				runtimeType: RUNTIME_TYPES.GEMINI_CLI,
			});

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({ runtimeType: RUNTIME_TYPES.GEMINI_CLI })
			);
		});
	});

	describe('getRestartStats', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should return initial stats with zero restarts', () => {
			const stats = service.getRestartStats();

			expect(stats.totalRestarts).toBe(0);
			expect(stats.restartsInWindow).toBe(0);
			expect(stats.isRestarting).toBe(false);
			expect(stats.lastRestartAt).toBeNull();
			expect(stats.restartAllowed).toBe(true);
		});

		it('should track restart count after successful restart', async () => {
			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			await resultPromise;

			const stats = service.getRestartStats();

			expect(stats.totalRestarts).toBe(1);
			expect(stats.restartsInWindow).toBe(1);
			expect(stats.lastRestartAt).not.toBeNull();
		});
	});

	describe('message replay after restart (#247)', () => {
		beforeEach(() => {
			jest.useFakeTimers();
			mockReplayPendingMessages.mockClear();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('should call replayPendingMessages during restart', async () => {
			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockReplayPendingMessages).toHaveBeenCalledTimes(1);
		});

		it('should succeed even if replay fails', async () => {
			mockReplayPendingMessages.mockRejectedValueOnce(new Error('replay failed'));

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			// Restart should still succeed — replay failure is non-critical
			expect(result).toBe(true);
		});

		it('should log replayed count when messages are replayed', async () => {
			mockReplayPendingMessages.mockResolvedValueOnce({
				foundCount: 3,
				replayedCount: 2,
				skippedDuplicate: 1,
				offlineSince: '2023-01-01T00:00:00.000Z',
				offlineDurationMs: 60000,
			});

			const resultPromise = service.attemptRestart();
			await jest.advanceTimersByTimeAsync(6000);
			const result = await resultPromise;

			expect(result).toBe(true);
			expect(mockReplayPendingMessages).toHaveBeenCalledTimes(1);
		});
	});
});
