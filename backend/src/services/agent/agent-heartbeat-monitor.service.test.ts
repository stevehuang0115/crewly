/**
 * Tests for AgentHeartbeatMonitorService
 *
 * Covers the refactored heartbeat monitor that uses:
 * - Dual idle detection (PTY + API activity)
 * - Server-side process liveness checks (isChildProcessAlive)
 * - 3-consecutive-dead-check restart logic
 * - No PTY input injection
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

jest.mock('fs/promises', () => ({
	readFile: jest.fn().mockResolvedValue('# Task Content\nSome task details here.'),
}));

import { AgentHeartbeatMonitorService } from './agent-heartbeat-monitor.service.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentHeartbeatService } from './agent-heartbeat.service.js';
import { AgentSuspendService } from './agent-suspend.service.js';
import { RuntimeExitMonitorService } from './runtime-exit-monitor.service.js';
import { AGENT_HEARTBEAT_MONITOR_CONSTANTS } from '../../constants.js';
import * as fsPromises from 'fs/promises';
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
	let mockTaskTrackingService: {
		getTasksForTeamMember: jest.Mock;
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

		mockTaskTrackingService = {
			getTasksForTeamMember: jest.fn().mockResolvedValue([]),
		};

		service.setDependencies(
			mockSessionBackend as any,
			mockAgentRegistrationService as any,
			mockStorageService as any,
			mockTaskTrackingService as any,
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
				mockTaskTrackingService as any,
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
			mockTaskTrackingService.getTasksForTeamMember.mockResolvedValue([
				{
					id: 'task-1',
					taskName: 'Implement feature X',
					taskFilePath: '/project/.crewly/tasks/m1/in_progress/01_feature_x.md',
					status: 'assigned',
					assignedTeamMemberId: 'member-1',
					assignedSessionName: 'dev-agent-1',
					assignedAt: new Date().toISOString(),
					projectId: 'proj-1',
					teamId: 'team-1',
					targetRole: 'developer',
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

			expect(mockTaskTrackingService.getTasksForTeamMember).toHaveBeenCalledWith('member-1');
			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('[TASK RE-DELIVERY]')
			);
			expect(mockSession.write).toHaveBeenCalledWith(
				expect.stringContaining('Implement feature X')
			);
		});

		it('should skip re-delivery when no tasks exist', async () => {
			mockTaskTrackingService.getTasksForTeamMember.mockResolvedValue([]);
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
			mockTaskTrackingService.getTasksForTeamMember.mockResolvedValue([
				{
					id: 'task-1',
					taskName: 'Missing task',
					taskFilePath: '/nonexistent/task.md',
					status: 'active',
					assignedTeamMemberId: 'member-1',
					assignedSessionName: 'dev-agent-1',
					assignedAt: new Date().toISOString(),
					projectId: 'proj-1',
					teamId: 'team-1',
					targetRole: 'developer',
				},
			]);
			(fsPromises.readFile as jest.Mock).mockRejectedValue(new Error('ENOENT'));

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
				expect.stringContaining('(task file not found)')
			);
		});

		it('should truncate long task content', async () => {
			const longContent = 'x'.repeat(3000);
			(fsPromises.readFile as jest.Mock).mockResolvedValue(longContent);

			mockTaskTrackingService.getTasksForTeamMember.mockResolvedValue([
				{
					id: 'task-1',
					taskName: 'Long task',
					taskFilePath: '/project/task.md',
					status: 'assigned',
					assignedTeamMemberId: 'member-1',
					assignedSessionName: 'dev-agent-1',
					assignedAt: new Date().toISOString(),
					projectId: 'proj-1',
					teamId: 'team-1',
					targetRole: 'developer',
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
