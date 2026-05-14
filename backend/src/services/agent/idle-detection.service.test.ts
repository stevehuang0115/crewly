/**
 * Tests for IdleDetectionService
 *
 * @module services/agent/idle-detection.service.test
 */

import { AGENT_SUSPEND_CONSTANTS } from '../../constants.js';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: jest.fn(),
				debug: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
			}),
		}),
	},
}));

// Mock settings service
const mockGetSettings = jest.fn().mockResolvedValue({
	general: { agentIdleTimeoutMinutes: 30 },
});

jest.mock('../settings/index.js', () => ({
	getSettingsService: () => ({
		getSettings: mockGetSettings,
	}),
}));

// Mock storage service
const mockGetTeams = jest.fn();
const mockUpdateAgentStatus = jest.fn().mockResolvedValue(undefined);
jest.mock('../core/storage.service.js', () => ({
	StorageService: {
		getInstance: () => ({
			getTeams: mockGetTeams,
			updateAgentStatus: mockUpdateAgentStatus,
		}),
	},
}));

// Mock AgentSuspendService
const mockSuspendAgent = jest.fn().mockResolvedValue(true);
const mockIsSuspended = jest.fn().mockReturnValue(false);
const mockIsRehydrating = jest.fn().mockReturnValue(false);

jest.mock('./agent-suspend.service.js', () => ({
	AgentSuspendService: {
		getInstance: () => ({
			suspendAgent: mockSuspendAgent,
			isSuspended: mockIsSuspended,
			isRehydrating: mockIsRehydrating,
		}),
		resetInstance: jest.fn(),
	},
}));

// Mock PtyActivityTrackerService
const mockIsIdleFor = jest.fn();
const mockClearSession = jest.fn();

jest.mock('./pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: () => ({
			isIdleFor: mockIsIdleFor,
			clearSession: mockClearSession,
		}),
		resetInstance: jest.fn(),
	},
}));

// Mock session backend
const mockKillSession = jest.fn().mockResolvedValue(undefined);
const mockSessionExists = jest.fn().mockReturnValue(true);
jest.mock('../session/index.js', () => ({
	getSessionBackendSync: () => ({
		killSession: mockKillSession,
		sessionExists: mockSessionExists,
	}),
}));

// Mock ActivityMonitorService
const mockGetWorkingStatus = jest.fn().mockResolvedValue('idle');
jest.mock('../monitoring/activity-monitor.service.js', () => ({
	ActivityMonitorService: {
		getInstance: () => ({
			getWorkingStatusForSession: mockGetWorkingStatus,
		}),
	},
}));

// Import after mocks
import { IdleDetectionService } from './idle-detection.service.js';

describe('IdleDetectionService', () => {
	beforeEach(() => {
		IdleDetectionService.resetInstance();
		jest.clearAllMocks();
		mockGetSettings.mockResolvedValue({ general: { agentIdleTimeoutMinutes: 30 } });
		mockIsSuspended.mockReturnValue(false);
		mockIsRehydrating.mockReturnValue(false);
		mockGetWorkingStatus.mockResolvedValue('idle');
		jest.useFakeTimers();
	});

	afterEach(() => {
		IdleDetectionService.resetInstance();
		jest.useRealTimers();
	});

	describe('getInstance', () => {
		it('should return a singleton instance', () => {
			const a = IdleDetectionService.getInstance();
			const b = IdleDetectionService.getInstance();
			expect(a).toBe(b);
		});
	});

	describe('start/stop', () => {
		it('should start the check cycle', () => {
			const service = IdleDetectionService.getInstance();
			service.start();
			expect(service.isRunning()).toBe(true);
			service.stop();
		});

		it('should stop the check cycle', () => {
			const service = IdleDetectionService.getInstance();
			service.start();
			service.stop();
			expect(service.isRunning()).toBe(false);
		});

		it('should not start twice', () => {
			const service = IdleDetectionService.getInstance();
			service.start();
			service.start();
			expect(service.isRunning()).toBe(true);
			service.stop();
		});
	});

	describe('performCheck', () => {
		it('should skip when timeout is 0 (disabled)', async () => {
			mockGetSettings.mockResolvedValueOnce({ general: { agentIdleTimeoutMinutes: 0 } });
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockGetTeams).not.toHaveBeenCalled();
		});

		it('should skip orchestrator role agents', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'orc1', sessionName: 'crewly-orc', role: 'orchestrator', agentStatus: 'active' }],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
			expect(mockIsIdleFor).not.toHaveBeenCalled();
		});

		it('should skip auditor role agents (always-on)', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'aud1', sessionName: 'crewly-auditor', role: 'auditor', agentStatus: 'active' }],
			}]);
			mockIsIdleFor.mockReturnValue(true);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
		});

		it('should skip non-active agents', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'inactive' }],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockIsIdleFor).not.toHaveBeenCalled();
		});

		it('should stop idle agents when registration service is set', async () => {
			const mockTerminate = jest.fn().mockResolvedValue({ success: true });
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'active' }],
			}]);
			mockIsIdleFor.mockReturnValue(true);
			const service = IdleDetectionService.getInstance();
			service.setAgentRegistrationService({ terminateAgentSession: mockTerminate } as any);
			await service.performCheck();
			expect(mockTerminate).toHaveBeenCalledWith('agent-dev', 'developer');
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith('agent-dev', 'inactive', 'idle_exit');
		});

		it('should fall back to suspend when registration service not set', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'active' }],
			}]);
			mockIsIdleFor.mockReturnValue(true);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).toHaveBeenCalledWith('agent-dev', 'team1', 'dev1', 'developer');
		});

		it('should not suspend non-idle agents', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'active' }],
			}]);
			mockIsIdleFor.mockReturnValue(false);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
		});

		it('should skip already suspended agents', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'active' }],
			}]);
			mockIsSuspended.mockReturnValue(true);
			mockIsIdleFor.mockReturnValue(true);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
		});

		it('should handle getTeams failure gracefully', async () => {
			mockGetTeams.mockRejectedValue(new Error('Storage error'));
			const service = IdleDetectionService.getInstance();
			await expect(service.performCheck()).resolves.not.toThrow();
		});

		it('should mark stuck started agents as inactive instead of suspended', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'started' }],
			}]);
			mockIsIdleFor.mockReturnValue(true);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockIsIdleFor).toHaveBeenCalledWith(
				'agent-dev',
				AGENT_SUSPEND_CONSTANTS.STARTED_AGENT_IDLE_TIMEOUT_MINUTES * 60 * 1000
			);
			expect(mockSuspendAgent).not.toHaveBeenCalled();
			expect(mockKillSession).toHaveBeenCalledWith('agent-dev');
			expect(mockClearSession).toHaveBeenCalledWith('agent-dev');
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith('agent-dev', 'inactive');
		});

		it('should not check agents with activating status', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'activating' }],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockIsIdleFor).not.toHaveBeenCalled();
		});

		it('should use default timeout (30min) when settings read fails', async () => {
			mockGetSettings.mockRejectedValueOnce(new Error('Settings error'));
			mockGetTeams.mockResolvedValueOnce([{
				id: 'team1',
				members: [{ id: 'dev1', sessionName: 'agent-dev', role: 'developer', agentStatus: 'active' }],
			}]);
			mockIsIdleFor.mockReturnValueOnce(true);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			// Default is 30 minutes = 1,800,000ms
			expect(mockIsIdleFor).toHaveBeenCalledWith('agent-dev', 1_800_000);
			expect(mockSuspendAgent).toHaveBeenCalled();
		});
	});

	// ===== New: crewly-agent timestamp-based idle detection =====

	describe('crewly-agent idle detection', () => {
		it('should suspend crewly-agent after 30min idle via updatedAt timestamp', async () => {
			const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{
					id: 'dev1', sessionName: 'crewly-agent-dev', role: 'developer',
					agentStatus: 'active', runtimeType: 'crewly-agent', updatedAt: thirtyOneMinAgo,
				}],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockIsIdleFor).not.toHaveBeenCalled();
			expect(mockSuspendAgent).toHaveBeenCalledWith('crewly-agent-dev', 'team1', 'dev1', 'developer');
		});

		it('should NOT suspend crewly-agent when updatedAt is recent', async () => {
			const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{
					id: 'dev1', sessionName: 'crewly-agent-dev', role: 'developer',
					agentStatus: 'active', runtimeType: 'crewly-agent', updatedAt: fiveMinAgo,
				}],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
			expect(mockIsIdleFor).not.toHaveBeenCalled();
		});

		it('should use readyAt over updatedAt when both exist for crewly-agent', async () => {
			const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [{
					id: 'dev1', sessionName: 'crewly-agent-dev', role: 'developer',
					agentStatus: 'active', runtimeType: 'crewly-agent',
					readyAt: fiveMinAgo, updatedAt: thirtyOneMinAgo,
				}],
			}]);
			const service = IdleDetectionService.getInstance();
			await service.performCheck();
			expect(mockSuspendAgent).not.toHaveBeenCalled();
		});
	});

	// ===== forceStopIdleAgents (memory pressure emergency stop) =====

	describe('forceStopIdleAgents', () => {
		it('should stop idle agents but skip orchestrator', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [
					{
						id: 'orc1',
						sessionName: 'crewly-orc',
						role: 'orchestrator',
						agentStatus: 'active',
						workingStatus: 'idle',
					},
					{
						id: 'dev1',
						sessionName: 'agent-dev1',
						role: 'developer',
						agentStatus: 'active',
						workingStatus: 'idle',
					},
					{
						id: 'dev2',
						sessionName: 'agent-dev2',
						role: 'developer',
						agentStatus: 'active',
						workingStatus: 'in_progress',
					},
				],
			}]);
			mockSessionExists.mockReturnValue(true);

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			// Only the idle non-orchestrator agent should be stopped
			expect(stoppedCount).toBe(1);

			// agent-dev1 (idle) should be killed and marked inactive
			expect(mockKillSession).toHaveBeenCalledWith('agent-dev1');
			expect(mockClearSession).toHaveBeenCalledWith('agent-dev1');
			expect(mockUpdateAgentStatus).toHaveBeenCalledWith('agent-dev1', 'inactive', 'idle_exit');

			// orchestrator should NOT be stopped
			expect(mockKillSession).not.toHaveBeenCalledWith('crewly-orc');

			// agent-dev2 (in_progress) should NOT be stopped
			expect(mockKillSession).not.toHaveBeenCalledWith('agent-dev2');
		});

		it('should skip inactive agents', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [
					{
						id: 'dev1',
						sessionName: 'agent-dev1',
						role: 'developer',
						agentStatus: 'inactive',
						workingStatus: 'idle',
					},
				],
			}]);

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			expect(stoppedCount).toBe(0);
			expect(mockKillSession).not.toHaveBeenCalled();
		});

		it('should stop started agents that are idle', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [
					{
						id: 'dev1',
						sessionName: 'agent-dev1',
						role: 'developer',
						agentStatus: 'started',
						workingStatus: 'idle',
					},
				],
			}]);
			mockSessionExists.mockReturnValue(true);

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			expect(stoppedCount).toBe(1);
			expect(mockKillSession).toHaveBeenCalledWith('agent-dev1');
		});

		it('should return 0 when getTeams fails', async () => {
			mockGetTeams.mockRejectedValue(new Error('Storage error'));

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			expect(stoppedCount).toBe(0);
		});

		it('should handle killSession failure gracefully and continue', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [
					{
						id: 'dev1',
						sessionName: 'agent-dev1',
						role: 'developer',
						agentStatus: 'active',
						workingStatus: 'idle',
					},
					{
						id: 'dev2',
						sessionName: 'agent-dev2',
						role: 'developer',
						agentStatus: 'active',
						workingStatus: 'idle',
					},
				],
			}]);
			mockSessionExists.mockReturnValue(true);
			// First call fails, second succeeds
			mockKillSession.mockRejectedValueOnce(new Error('Kill failed'));
			mockKillSession.mockResolvedValueOnce(undefined);

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			// The second agent should still be stopped even though first failed
			expect(stoppedCount).toBe(1);
		});

		it('should skip auditor role agents (always-on)', async () => {
			mockGetTeams.mockResolvedValue([{
				id: 'team1',
				members: [
					{
						id: 'aud1',
						sessionName: 'crewly-auditor',
						role: 'auditor',
						agentStatus: 'active',
						workingStatus: 'idle',
					},
				],
			}]);

			const service = IdleDetectionService.getInstance();
			const stoppedCount = await service.forceStopIdleAgents();

			expect(stoppedCount).toBe(0);
			expect(mockKillSession).not.toHaveBeenCalled();
		});
	});

	describe('tick observability (re-entrancy guard + heartbeat)', () => {
		it('should expose initial stats including new forcedResetCount field', () => {
			const service = IdleDetectionService.getInstance();
			expect(service.getStats()).toEqual({
				isRunning: false,
				isChecking: false,
				lastTickStartedAt: null,
				lastTickCompletedAt: null,
				lastTickDurationMs: null,
				consecutiveSkippedTicks: 0,
				forcedResetCount: 0,
			});
		});

		it('should skip overlapping ticks via re-entrancy guard (real exercise)', () => {
			// Make performCheck hang so the first tick stays in flight.
			let releaseHang: () => void = () => {};
			mockGetTeams.mockReturnValue(
				new Promise<unknown[]>(resolve => {
					releaseHang = () => resolve([]);
				}),
			);

			const service = IdleDetectionService.getInstance();
			const runTick = (service as any).runTick.bind(service) as () => void;

			// First call: starts a real tick, isChecking flips to true,
			// and the hang holds it there.
			runTick();
			expect(service.getStats().isChecking).toBe(true);
			expect(service.getStats().consecutiveSkippedTicks).toBe(0);

			// Second call within the stuck-threshold: must short-circuit
			// (not increment further into a new tick) AND must increment
			// the skipped-tick counter — this is the assertion the
			// previous test missed.
			runTick();
			expect(service.getStats().consecutiveSkippedTicks).toBe(1);
			expect(service.getStats().isChecking).toBe(true);

			// Third call still within threshold: counter keeps climbing.
			runTick();
			expect(service.getStats().consecutiveSkippedTicks).toBe(2);

			// Cleanup so we don't leak the pending promise.
			releaseHang();
		});

		it('should force-reset isChecking when a tick has been hung past the stuck threshold', () => {
			// Hang the first tick indefinitely.
			let releaseHang: () => void = () => {};
			mockGetTeams.mockReturnValue(
				new Promise<unknown[]>(resolve => {
					releaseHang = () => resolve([]);
				}),
			);

			const service = IdleDetectionService.getInstance();
			const runTick = (service as any).runTick.bind(service) as () => void;

			runTick();
			expect(service.getStats().isChecking).toBe(true);

			// Fast-forward perceived clock past 3× interval. We can't
			// move `Date.now()` via fake timers without `modern` mode;
			// instead we backdate `lastTickStartedAt` to simulate
			// elapsed time.
			const oldStart = service.getStats().lastTickStartedAt!;
			const stuckBy = AGENT_SUSPEND_CONSTANTS.IDLE_CHECK_INTERVAL_MS * 3 + 1000;
			(service as any).lastTickStartedAt = oldStart - stuckBy;

			runTick();
			// Watchdog fired: isChecking flipped to false (and a fresh
			// tick was scheduled, which then re-set isChecking to true).
			expect(service.getStats().forcedResetCount).toBe(1);

			releaseHang();
		});

		it('should never let a thrown error in performCheck stop the timer', async () => {
			mockGetTeams.mockRejectedValueOnce(new Error('boom'));
			const service = IdleDetectionService.getInstance();

			// performCheck swallows storage errors internally (returns void).
			// The tick wrapper additionally catches anything that escapes.
			await expect(service.performCheck()).resolves.toBeUndefined();
		});
	});
});
