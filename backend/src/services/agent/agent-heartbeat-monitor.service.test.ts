/**
 * Tests for AgentHeartbeatMonitorService
 *
 * Covers the refactored heartbeat monitor that uses:
 * - Dual idle detection (PTY + API activity)
 * - Server-side process liveness checks (isChildProcessAlive)
 * - 3-consecutive-dead-check restart logic
 * - No PTY input injection
 * - Memory pressure skip for restarts
 */

// Mock os module (non-configurable in Node.js, so jest.spyOn doesn't work)
const mockTotalmem = jest.fn(() => 16_000_000_000); // 16GB
const mockFreemem = jest.fn(() => 8_000_000_000);   // 8GB (50% used)
jest.mock('os', () => ({
	...jest.requireActual('os'),
	totalmem: () => mockTotalmem(),
	freemem: () => mockFreemem(),
}));

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

jest.mock('../core/storage.service.js');

jest.mock('./agent-suspend.service.js', () => ({
	AgentSuspendService: {
		getInstance: jest.fn().mockReturnValue({
			isSuspended: jest.fn().mockReturnValue(false),
			isRehydrating: jest.fn().mockReturnValue(false),
		}),
	},
}));

jest.mock('./agent-heartbeat.service.js', () => ({
	AgentHeartbeatService: {
		getInstance: jest.fn().mockReturnValue({
			getAgentHeartbeat: jest.fn().mockResolvedValue(null),
		}),
	},
}));

jest.mock('./runtime-exit-monitor.service.js', () => ({
	RuntimeExitMonitorService: {
		getInstance: jest.fn().mockReturnValue({
			stopMonitoring: jest.fn(),
		}),
	},
}));

const mockPersistence = {
	getSessionId: jest.fn().mockReturnValue('claude-session-123'),
	getSessionMetadata: jest.fn().mockReturnValue({ sessionName: 'test-agent' }),
	updateSessionId: jest.fn(),
};

jest.mock('../session/session-state-persistence.js', () => ({
	getSessionStatePersistence: jest.fn().mockReturnValue(mockPersistence),
}));

const mockGateway = {
	broadcastTeamMemberStatus: jest.fn(),
};

jest.mock('../../websocket/terminal.gateway.js', () => ({
	getTerminalGateway: jest.fn().mockReturnValue(mockGateway),
}));

const mockGetAllItems = jest.fn().mockResolvedValue([]);
jest.mock('../task-pool/task-pool.service.js', () => ({
	TaskPoolService: {
		getInstance: () => ({
			getAllItems: mockGetAllItems,
		}),
	},
}));

import { AgentHeartbeatMonitorService } from './agent-heartbeat-monitor.service.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentHeartbeatService } from './agent-heartbeat.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { AGENT_HEARTBEAT_MONITOR_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';

/**
 * Helper to set the private startedAt field without starting the interval timer.
 * This avoids async interval callbacks interfering with manual performCheck calls.
 */
function setStartedAtInPast(svc: AgentHeartbeatMonitorService): void {
	(svc as any).startedAt = Date.now() - AGENT_HEARTBEAT_MONITOR_CONSTANTS.STARTUP_GRACE_PERIOD_MS - 1;
}

describe('AgentHeartbeatMonitorService', () => {
	let service: AgentHeartbeatMonitorService;
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
	let mockAgentRegistrationService: {
		createAgentSession: jest.Mock;
	};
	let mockStorageService: {
		getTeams: jest.Mock;
		updateAgentStatus: jest.Mock;
		findMemberBySessionName: jest.Mock;
	};
	let mockTeams: Team[];

	beforeEach(() => {
		jest.useFakeTimers();

		AgentHeartbeatMonitorService.resetInstance();
		PtyActivityTrackerService.resetInstance();

		service = AgentHeartbeatMonitorService.getInstance();

		mockSession = {
			write: jest.fn(),
			name: 'dev-agent-1',
		};

		mockSessionBackend = {
			sessionExists: jest.fn().mockReturnValue(true),
			getSession: jest.fn().mockReturnValue(mockSession),
			killSession: jest.fn().mockResolvedValue(undefined),
			isChildProcessAlive: jest.fn().mockReturnValue(true),
		};

		mockAgentRegistrationService = {
			createAgentSession: jest.fn().mockResolvedValue({ success: true }),
		};

		mockTeams = [{
			id: 'team-1',
			name: 'Test Team',
			members: [
				{
					id: 'member-1',
					name: 'Dev Agent',
					sessionName: 'dev-agent-1',
					role: 'developer',
					agentStatus: 'active',
					workingStatus: 'idle',
					runtimeType: 'claude-code',
					systemPrompt: '',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				{
					id: 'orc-1',
					name: 'Orchestrator',
					sessionName: 'crewly-orc',
					role: 'orchestrator',
					agentStatus: 'active',
					workingStatus: 'idle',
					runtimeType: 'claude-code',
					systemPrompt: '',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
			projectIds: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}];

		mockStorageService = {
			getTeams: jest.fn().mockResolvedValue(mockTeams),
			updateAgentStatus: jest.fn().mockResolvedValue(undefined),
			findMemberBySessionName: jest.fn().mockResolvedValue(null),
		};

		service.setDependencies(
			mockSessionBackend as any,
			mockAgentRegistrationService as any,
			mockStorageService as any,
		);

		// Record initial activity so tracker has a baseline
		PtyActivityTrackerService.getInstance().recordActivity('dev-agent-1');

		// Reset mock implementations that may have been modified by previous tests
		const suspendService = AgentSuspendService.getInstance();
		(suspendService.isSuspended as jest.Mock).mockReturnValue(false);
		(suspendService.isRehydrating as jest.Mock).mockReturnValue(false);

		// Reset AgentHeartbeatService mock — default to stale heartbeat so dual idle
		// detection treats agents as truly idle when PTY is also stale. Tests that need
		// recent API activity should override this mock explicitly.
		const heartbeatService = AgentHeartbeatService.getInstance();
		(heartbeatService.getAgentHeartbeat as jest.Mock).mockResolvedValue({
			lastActiveTime: new Date(Date.now() - AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS - 1).toISOString(),
			agentStatus: 'active',
		});

		mockPersistence.getSessionId.mockReturnValue('claude-session-123');
		mockPersistence.getSessionMetadata.mockReturnValue({ sessionName: 'test-agent' });
		mockPersistence.updateSessionId.mockClear();
		mockGateway.broadcastTeamMemberStatus.mockClear();
	});

	afterEach(() => {
		AgentHeartbeatMonitorService.resetInstance();
		PtyActivityTrackerService.resetInstance();
		jest.useRealTimers();
		mockTotalmem.mockReturnValue(16_000_000_000);
		mockFreemem.mockReturnValue(8_000_000_000);
	});

	describe('singleton', () => {
		it('should return the same instance', () => {
			const a = AgentHeartbeatMonitorService.getInstance();
			const b = AgentHeartbeatMonitorService.getInstance();
			expect(a).toBe(b);
		});

		it('should create a fresh instance after reset', () => {
			const a = AgentHeartbeatMonitorService.getInstance();
			AgentHeartbeatMonitorService.resetInstance();
			const b = AgentHeartbeatMonitorService.getInstance();
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

		it('should clear agent states on stop', () => {
			service.start();
			service.stop();
			expect(service.getAgentStates().size).toBe(0);
		});
	});

	describe('performCheck', () => {
		it('should skip during startup grace period', async () => {
			// Set startedAt to now (within grace period)
			(service as any).startedAt = Date.now();
			await service.performCheck();
			expect(mockStorageService.getTeams).not.toHaveBeenCalled();
		});

		it('should skip if dependencies not set', async () => {
			AgentHeartbeatMonitorService.resetInstance();
			const freshService = AgentHeartbeatMonitorService.getInstance();
			// Don't set dependencies, just set startedAt past grace period
			setStartedAtInPast(freshService);
			await freshService.performCheck();
			expect(mockStorageService.getTeams).not.toHaveBeenCalled();
		});

		it('should monitor orchestrator agents unconditionally (#191)', async () => {
			setStartedAtInPast(service);
			// Record activity for orchestrator so the tracker has a baseline
			PtyActivityTrackerService.getInstance().recordActivity('crewly-orc');

			// Make agent idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			// #191: Orchestrator should now be tracked (unconditional heartbeat)
			const states = service.getAgentStates();
			expect(states.has('dev-agent-1')).toBe(true);
			expect(states.has('crewly-orc')).toBe(true);
		});

		it('should skip inactive agents', async () => {
			mockTeams[0].members[0].agentStatus = 'inactive';
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();
		});

		it('should skip suspended agents', async () => {
			const suspendService = AgentSuspendService.getInstance();
			(suspendService.isSuspended as jest.Mock).mockReturnValue(true);
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
		});

		it('should skip rehydrating agents', async () => {
			const suspendService = AgentSuspendService.getInstance();
			(suspendService.isRehydrating as jest.Mock).mockReturnValue(true);
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
		});

		it('should skip if session does not exist', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
		});

		it('should mark agent inactive when session is gone (#220 ghost agent fix)', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			await service.performCheck();

			// Agent should be marked inactive in storage
			expect(mockStorageService.updateAgentStatus).toHaveBeenCalledWith(
				'dev-agent-1',
				'inactive',
			);

			// WebSocket broadcast should notify UI
			expect(mockGateway.broadcastTeamMemberStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					teamId: 'team-1',
					memberId: 'member-1',
					agentStatus: 'inactive',
				}),
			);
		});

		it('should handle updateAgentStatus failure gracefully when session gone (#220)', async () => {
			mockSessionBackend.sessionExists.mockReturnValue(false);
			mockStorageService.updateAgentStatus.mockRejectedValueOnce(new Error('Storage write failed'));
			setStartedAtInPast(service);

			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Should not throw — error is logged but not propagated
			await expect(service.performCheck()).resolves.not.toThrow();
		});

		it('should do nothing when agent has recent PTY activity', async () => {
			setStartedAtInPast(service);

			// Record recent activity
			PtyActivityTrackerService.getInstance().recordActivity('dev-agent-1');
			await service.performCheck();

			// Should not check process liveness when PTY is recent
			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
		});

		it('should do nothing when agent has recent API activity despite stale PTY', async () => {
			setStartedAtInPast(service);

			// Make PTY idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// But API heartbeat is recent
			const heartbeatService = AgentHeartbeatService.getInstance();
			(heartbeatService.getAgentHeartbeat as jest.Mock).mockResolvedValue({
				lastActiveTime: new Date().toISOString(),
				agentStatus: 'active',
			});

			await service.performCheck();

			// Should not check process liveness when API is recent
			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
		});

		it('should check process liveness when both PTY and API are idle', async () => {
			setStartedAtInPast(service);

			// Make both PTY and API idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// API heartbeat is also stale
			const heartbeatService = AgentHeartbeatService.getInstance();
			(heartbeatService.getAgentHeartbeat as jest.Mock).mockResolvedValue({
				lastActiveTime: new Date(Date.now() - AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS - 1).toISOString(),
				agentStatus: 'active',
			});

			await service.performCheck();

			expect(mockSessionBackend.isChildProcessAlive).toHaveBeenCalledWith('dev-agent-1');
		});

		it('should reset dead check counter when process is alive', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Process is alive
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);
			await service.performCheck();

			const states = service.getAgentStates();
			expect(states.get('dev-agent-1')?.consecutiveDeadChecks).toBe(0);
		});

		it('should increment dead check counter when process is dead', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Process is dead
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);
			await service.performCheck();

			const states = service.getAgentStates();
			expect(states.get('dev-agent-1')?.consecutiveDeadChecks).toBe(1);
		});

		it('should not restart until 3 consecutive dead checks', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Process is dead
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// First 2 dead checks should not trigger restart
			await service.performCheck();
			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();

			await service.performCheck();
			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();

			// 3rd dead check should trigger restart
			await service.performCheck();
			expect(mockSessionBackend.killSession).toHaveBeenCalledWith('dev-agent-1');
			expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'dev-agent-1',
					role: 'developer',
					teamId: 'team-1',
					memberId: 'member-1',
				})
			);
		});

		it('should reset dead check counter when activity resumes', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// 2 dead checks
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);
			await service.performCheck();
			await service.performCheck();

			expect(service.getAgentStates().get('dev-agent-1')?.consecutiveDeadChecks).toBe(2);

			// Activity resumes
			PtyActivityTrackerService.getInstance().recordActivity('dev-agent-1');
			await service.performCheck();

			expect(service.getAgentStates().get('dev-agent-1')?.consecutiveDeadChecks).toBe(0);
			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();
		});

		it('should never write to agent PTY for heartbeat', async () => {
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Run multiple checks
			await service.performCheck();
			await service.performCheck();

			// Session.write should never be called for heartbeat requests
			// (it may be called later for task re-delivery, which is fine)
			const heartbeatWrites = mockSession.write.mock.calls.filter(
				(call: any[]) => typeof call[0] === 'string' && call[0].includes('heartbeat')
			);
			expect(heartbeatWrites).toHaveLength(0);
		});

		it('should preserve Claude session ID during restart', async () => {
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			expect(mockPersistence.getSessionId).toHaveBeenCalledWith('dev-agent-1');
			expect(mockPersistence.updateSessionId).toHaveBeenCalledWith('dev-agent-1', 'claude-session-123');
		});

		it('should enforce restart cooldown', async () => {
			setStartedAtInPast(service);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Trigger max restarts
			for (let i = 0; i < AGENT_HEARTBEAT_MONITOR_CONSTANTS.MAX_RESTARTS_PER_WINDOW; i++) {
				// 3 dead checks → restart
				await service.performCheck();
				await service.performCheck();
				await service.performCheck();

				// Reset activity after restart so next cycle starts fresh
				PtyActivityTrackerService.getInstance().recordActivity('dev-agent-1');
				await service.performCheck(); // clears dead checks
				// Make idle again
				jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			}

			const callsBefore = mockAgentRegistrationService.createAgentSession.mock.calls.length;

			// Next restart attempt should be blocked by cooldown
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			expect(mockAgentRegistrationService.createAgentSession.mock.calls.length).toBe(callsBefore);
		});

		it('should stop exit monitoring before kill', async () => {
			const exitMonitor = RuntimeExitMonitorService.getInstance();
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			expect(exitMonitor.stopMonitoring).toHaveBeenCalledWith('dev-agent-1');
		});

		it('should broadcast status event on restart', async () => {
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			expect(mockGateway.broadcastTeamMemberStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					teamId: 'team-1',
					memberId: 'member-1',
					sessionName: 'dev-agent-1',
				})
			);
		});

		it('should handle isChildProcessAlive not available on backend', async () => {
			// Backend without isChildProcessAlive method
			const backendWithoutCheck = {
				sessionExists: jest.fn().mockReturnValue(true),
				getSession: jest.fn().mockReturnValue(mockSession),
				killSession: jest.fn().mockResolvedValue(undefined),
				// No isChildProcessAlive
			};
			service.setDependencies(
				backendWithoutCheck as any,
				mockAgentRegistrationService as any,
				mockStorageService as any,
			);
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Should not crash, should assume alive
			await service.performCheck();

			const states = service.getAgentStates();
			expect(states.get('dev-agent-1')?.consecutiveDeadChecks).toBe(0);
		});

		it('should handle createAgentSession failure gracefully', async () => {
			mockAgentRegistrationService.createAgentSession.mockResolvedValue({
				success: false,
				error: 'session creation failed',
			});
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart (should not throw)
			await service.performCheck();
			await service.performCheck();
			await expect(service.performCheck()).resolves.toBeUndefined();
		});

		it('should skip restart when memory usage >= 90%', async () => {
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Simulate high memory usage (95% used)
			mockTotalmem.mockReturnValue(16_000_000_000); // 16GB
			mockFreemem.mockReturnValue(800_000_000);      // 800MB free = 95% used

			// Trigger 3 dead checks to cause restart attempt
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Restart should NOT be attempted because of memory pressure
			expect(mockSessionBackend.killSession).not.toHaveBeenCalled();
			expect(mockAgentRegistrationService.createAgentSession).not.toHaveBeenCalled();

		});

		it('should proceed with restart when memory usage is below 90%', async () => {
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Simulate normal memory usage (70% used)
			mockTotalmem.mockReturnValue(16_000_000_000); // 16GB
			mockFreemem.mockReturnValue(4_800_000_000);    // 4.8GB free = 70% used

			// Trigger 3 dead checks to cause restart attempt
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Restart SHOULD proceed because memory is not under pressure
			expect(mockSessionBackend.killSession).toHaveBeenCalledWith('dev-agent-1');
			expect(mockAgentRegistrationService.createAgentSession).toHaveBeenCalled();

		});
	});

	describe('on-demand optimization (#191)', () => {
		it('should skip non-orchestrator agents with recent API activity', async () => {
			setStartedAtInPast(service);

			// Make PTY idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// But API heartbeat is recent
			const heartbeatService = AgentHeartbeatService.getInstance();
			(heartbeatService.getAgentHeartbeat as jest.Mock).mockResolvedValue({
				lastActiveTime: new Date().toISOString(),
				agentStatus: 'active',
			});

			await service.performCheck();

			// Should not check process liveness (agent is alive via API)
			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalled();
			// Should have state with reset counters
			const state = service.getAgentStates().get('dev-agent-1');
			expect(state?.consecutiveDeadChecks).toBe(0);
			expect(state?.heartbeatSuspended).toBe(false);
		});

		it('should suspend heartbeat for idle agents after threshold', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);

			// Process is alive but idle
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Run 5 checks (IDLE_CHECKS_BEFORE_SUSPEND = 5)
			for (let i = 0; i < 5; i++) {
				await service.performCheck();
			}

			const state = service.getAgentStates().get('dev-agent-1');
			expect(state?.heartbeatSuspended).toBe(true);
			expect(state?.consecutiveIdleChecks).toBe(5);
		});

		it('should skip suspended agents on subsequent checks', async () => {
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Suspend via 5 idle checks
			for (let i = 0; i < 5; i++) {
				await service.performCheck();
			}

			// Clear mock call count
			mockSessionBackend.isChildProcessAlive.mockClear();

			// Next check should skip the suspended agent
			await service.performCheck();
			expect(mockSessionBackend.isChildProcessAlive).not.toHaveBeenCalledWith('dev-agent-1');
		});

		it('should unsuspend agent when API activity resumes', async () => {
			setStartedAtInPast(service);

			// Make truly idle and suspend
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			for (let i = 0; i < 5; i++) {
				await service.performCheck();
			}

			expect(service.getAgentStates().get('dev-agent-1')?.heartbeatSuspended).toBe(true);

			// API activity resumes
			const heartbeatService = AgentHeartbeatService.getInstance();
			(heartbeatService.getAgentHeartbeat as jest.Mock).mockResolvedValue({
				lastActiveTime: new Date().toISOString(),
				agentStatus: 'active',
			});

			await service.performCheck();

			const state = service.getAgentStates().get('dev-agent-1');
			expect(state?.heartbeatSuspended).toBe(false);
			expect(state?.consecutiveIdleChecks).toBe(0);
		});

		it('should never suspend orchestrator heartbeat', async () => {
			// Only keep orchestrator in team
			mockTeams[0].members = [mockTeams[0].members[1]]; // orchestrator only
			PtyActivityTrackerService.getInstance().recordActivity('crewly-orc');
			setStartedAtInPast(service);

			// Make truly idle
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			// Run many checks — orchestrator should never be suspended
			for (let i = 0; i < 10; i++) {
				await service.performCheck();
			}

			const state = service.getAgentStates().get('crewly-orc');
			expect(state?.heartbeatSuspended).toBe(false);
		});

		it('should resume heartbeat via resumeHeartbeat method', async () => {
			setStartedAtInPast(service);

			// Make truly idle and suspend
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(true);

			for (let i = 0; i < 5; i++) {
				await service.performCheck();
			}

			expect(service.getAgentStates().get('dev-agent-1')?.heartbeatSuspended).toBe(true);

			// Manually resume
			service.resumeHeartbeat('dev-agent-1');

			const state = service.getAgentStates().get('dev-agent-1');
			expect(state?.heartbeatSuspended).toBe(false);
			expect(state?.consecutiveIdleChecks).toBe(0);
		});
	});

	describe('task re-delivery', () => {
		it('should re-deliver active tasks after restart', async () => {
			mockGetAllItems.mockResolvedValue([
				{
					id: 'task-1',
					title: 'Implement feature X',
					description: 'Implement the feature X with full test coverage',
					target: 'dev-agent-1',
					status: 'running',
					type: 'delegate',
					owner: 'agent',
					retryCount: 0,
					maxRetries: 3,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
					createdAt: new Date().toISOString(),
				},
			]);

			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Flush the async redeliverTasks promise (waits for REHYDRATION_TIMEOUT + task delays)
			await jest.advanceTimersByTimeAsync(50_000);

			expect(mockGetAllItems).toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('[TASK RE-DELIVERY]')
			);
			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('Implement feature X')
			);
		});

		it('should skip re-delivery when no tasks exist', async () => {
			mockGetAllItems.mockResolvedValue([]);
			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Flush the async redeliverTasks promise
			await jest.advanceTimersByTimeAsync(50_000);

			const taskRedeliveryCalls = mockSession.write.mock.calls.filter(
				(call: any[]) => typeof call[0] === 'string' && call[0].includes('[TASK RE-DELIVERY]')
			);
			expect(taskRedeliveryCalls).toHaveLength(0);
		});

		it('should handle missing task files gracefully', async () => {
			mockGetAllItems.mockResolvedValue([
				{
					id: 'task-1',
					title: 'Missing task',
					target: 'dev-agent-1',
					status: 'running',
					type: 'delegate',
					owner: 'agent',
					retryCount: 0,
					maxRetries: 3,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
					createdAt: new Date().toISOString(),
				},
			]);

			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Flush the async redeliverTasks promise
			await jest.advanceTimersByTimeAsync(50_000);

			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('(no task description available)')
			);
		});

		it('should truncate long task description', async () => {
			const longDescription = 'x'.repeat(3000);

			mockGetAllItems.mockResolvedValue([
				{
					id: 'task-1',
					title: 'Long task',
					description: longDescription,
					target: 'dev-agent-1',
					status: 'running',
					type: 'delegate',
					owner: 'agent',
					retryCount: 0,
					maxRetries: 3,
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
					createdAt: new Date().toISOString(),
				},
			]);

			setStartedAtInPast(service);

			// Make truly idle with dead process
			jest.advanceTimersByTime(AGENT_HEARTBEAT_MONITOR_CONSTANTS.HEARTBEAT_REQUEST_THRESHOLD_MS + 1);
			mockSessionBackend.isChildProcessAlive.mockReturnValue(false);

			// Trigger 3 dead checks → restart
			await service.performCheck();
			await service.performCheck();
			await service.performCheck();

			// Flush the async redeliverTasks promise
			await jest.advanceTimersByTimeAsync(50_000);

			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('... (truncated)')
			);
		});
	});
});
