/**
 * Tests for ContextWindowMonitorService
 *
 * Covers singleton management, lifecycle, PTY data parsing, threshold transitions,
 * event publishing, auto-recovery, cooldown enforcement, and stale detection.
 *
 * @module services/agent/context-window-monitor.test
 */

import { ContextWindowMonitorService, type ContextLevel, type ContextWindowState } from './context-window-monitor.service.js';
import { CONTEXT_WINDOW_MONITOR_CONSTANTS, RUNTIME_COMPACT_COMMANDS } from '../../constants.js';

// =============================================================================
// Mocks
// =============================================================================

// Mock LoggerService
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

// Mock stripAnsiCodes
jest.mock('../../utils/terminal-output.utils.js', () => ({
	stripAnsiCodes: (content: string) => content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
}));

// Mock uuid
jest.mock('uuid', () => ({
	v4: () => 'test-uuid-1234',
}));

// Mock terminal gateway
const mockBroadcastContextWindowStatus = jest.fn();
const mockBroadcastTeamMemberStatus = jest.fn();
jest.mock('../../websocket/terminal.gateway.js', () => ({
	getTerminalGateway: () => ({
		broadcastContextWindowStatus: mockBroadcastContextWindowStatus,
		broadcastTeamMemberStatus: mockBroadcastTeamMemberStatus,
	}),
}));

// Mock session state persistence
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

// Mock PtyActivityTrackerService
const mockClearSession = jest.fn();
jest.mock('./pty-activity-tracker.service.js', () => ({
	PtyActivityTrackerService: {
		getInstance: () => ({
			clearSession: mockClearSession,
		}),
	},
}));

// Mock RuntimeExitMonitorService
const mockStopMonitoring = jest.fn();
jest.mock('./runtime-exit-monitor.service.js', () => ({
	RuntimeExitMonitorService: {
		getInstance: () => ({
			stopMonitoring: mockStopMonitoring,
		}),
	},
}));

// Mock session backend
jest.mock('../session/index.js', () => ({
	getSessionBackendSync: () => null,
	createSessionCommandHelper: jest.fn(),
}));

// Mock fs
jest.mock('fs/promises', () => ({
	readFile: jest.fn().mockResolvedValue('Task content here'),
}));

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a mock session backend with configurable behavior.
 */
function createMockSessionBackend(sessions: Map<string, { onData: (cb: (data: string) => void) => () => void; write: jest.Mock; sessionExists?: boolean }> = new Map()) {
	return {
		getSession: (name: string) => sessions.get(name) || null,
		sessionExists: (name: string) => sessions.has(name),
		killSession: jest.fn().mockResolvedValue(undefined),
		listSessions: () => Array.from(sessions.keys()),
	};
}

/**
 * Create a mock PTY session that allows triggering onData callbacks.
 */
function createMockSession() {
	const dataCallbacks: Array<(data: string) => void> = [];
	return {
		session: {
			onData: (cb: (data: string) => void) => {
				dataCallbacks.push(cb);
				return () => {
					const idx = dataCallbacks.indexOf(cb);
					if (idx >= 0) dataCallbacks.splice(idx, 1);
				};
			},
			write: jest.fn(),
		},
		emit: (data: string) => {
			for (const cb of dataCallbacks) {
				cb(data);
			}
		},
		getCallbackCount: () => dataCallbacks.length,
	};
}

/**
 * Create a mock EventBusService.
 */
function createMockEventBus() {
	return {
		publish: jest.fn(),
	};
}

/**
 * Create a mock AgentRegistrationService.
 */
function createMockAgentRegistrationService(success = true) {
	return {
		createAgentSession: jest.fn().mockResolvedValue({
			success,
			sessionName: 'test-session',
		}),
	};
}

/**
 * Create a mock TaskTrackingService.
 */
function createMockTaskTrackingService(tasks: Array<{ taskName: string; taskFilePath: string; status: string }> = []) {
	return {
		getTasksForTeamMember: jest.fn().mockResolvedValue(tasks),
	};
}

// =============================================================================
// Tests
// =============================================================================

describe('ContextWindowMonitorService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
		ContextWindowMonitorService.resetInstance();

		// Per spec 2026-05-05-compact-fix-AB-followup §A.2 + §B the production
		// defaults for both compact gates flipped to `false` (fail-safe CLOSED).
		// Existing behavior-tests in this suite were written when the gates were
		// effectively `true` and they assert that compact fires at the threshold.
		// Re-open both gates here so those behavior assertions still hold without
		// rewriting every test. The new `compact gating (Option A+B)` describe
		// block intentionally OVERRIDES these to `false` to verify the gating
		// contract (defaults closed, RED/CRITICAL paths blocked when off, etc).
		const service = ContextWindowMonitorService.getInstance();
		(service as unknown as { proactiveCompactEnabled: boolean; thresholdCompactEnabled: boolean }).proactiveCompactEnabled = true;
		(service as unknown as { proactiveCompactEnabled: boolean; thresholdCompactEnabled: boolean }).thresholdCompactEnabled = true;
	});

	afterEach(() => {
		ContextWindowMonitorService.resetInstance();
		jest.useRealTimers();
	});

	// =========================================================================
	// Singleton management
	// =========================================================================

	describe('singleton management', () => {
		it('should return the same instance on multiple getInstance calls', () => {
			const instance1 = ContextWindowMonitorService.getInstance();
			const instance2 = ContextWindowMonitorService.getInstance();
			expect(instance1).toBe(instance2);
		});

		it('should return a new instance after resetInstance', () => {
			const instance1 = ContextWindowMonitorService.getInstance();
			ContextWindowMonitorService.resetInstance();
			const instance2 = ContextWindowMonitorService.getInstance();
			expect(instance1).not.toBe(instance2);
		});
	});

	// =========================================================================
	// Start/stop lifecycle
	// =========================================================================

	describe('start/stop lifecycle', () => {
		it('should report running after start', () => {
			const service = ContextWindowMonitorService.getInstance();
			expect(service.isRunning()).toBe(false);
			service.start();
			expect(service.isRunning()).toBe(true);
		});

		it('should report not running after stop', () => {
			const service = ContextWindowMonitorService.getInstance();
			service.start();
			service.stop();
			expect(service.isRunning()).toBe(false);
		});

		it('should handle double start gracefully', () => {
			const service = ContextWindowMonitorService.getInstance();
			service.start();
			service.start(); // should not throw
			expect(service.isRunning()).toBe(true);
		});

		it('should handle stop without start gracefully', () => {
			const service = ContextWindowMonitorService.getInstance();
			service.stop(); // should not throw
			expect(service.isRunning()).toBe(false);
		});
	});

	// =========================================================================
	// Session monitoring
	// =========================================================================

	describe('session monitoring', () => {
		it('should start session monitoring when session exists', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('test-agent');
			expect(state).toBeDefined();
			expect(state!.sessionName).toBe('test-agent');
			expect(state!.memberId).toBe('member-1');
			expect(state!.teamId).toBe('team-1');
			expect(state!.role).toBe('developer');
			expect(state!.level).toBe('normal');
			expect(state!.contextPercent).toBe(0);
		});

		it('should not start monitoring when session does not exist', () => {
			const service = ContextWindowMonitorService.getInstance();
			const backend = createMockSessionBackend(new Map());

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('nonexistent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('nonexistent');
			expect(state).toBeUndefined();
		});

		it('should clean up on stopSessionMonitoring', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			expect(service.getContextState('test-agent')).toBeDefined();

			service.stopSessionMonitoring('test-agent');
			expect(service.getContextState('test-agent')).toBeUndefined();
		});

		it('should unsubscribe from PTY data on stopSessionMonitoring', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			expect(mockSession.getCallbackCount()).toBe(1);

			service.stopSessionMonitoring('test-agent');
			expect(mockSession.getCallbackCount()).toBe(0);
		});

		it('should replace monitoring on re-start for same session', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			service.startSessionMonitoring('test-agent', 'member-2', 'team-2', 'qa');

			const state = service.getContextState('test-agent');
			expect(state!.memberId).toBe('member-2');
			expect(state!.teamId).toBe('team-2');
			expect(state!.role).toBe('qa');
		});

		it('should return all context states', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession1 = createMockSession();
			const mockSession2 = createMockSession();
			const sessions = new Map([
				['agent-1', mockSession1.session],
				['agent-2', mockSession2.session],
			]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('agent-1', 'member-1', 'team-1', 'developer');
			service.startSessionMonitoring('agent-2', 'member-2', 'team-1', 'qa');

			const allStates = service.getAllContextStates();
			expect(allStates.size).toBe(2);
			expect(allStates.has('agent-1')).toBe(true);
			expect(allStates.has('agent-2')).toBe(true);
		});
	});

	// =========================================================================
	// Context % parsing from PTY data
	// =========================================================================

	describe('context % parsing', () => {
		function setupWithSession() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, eventBus };
		}

		it('should detect "85% context" format', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('85% context');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
			expect(state!.level).toBe('red');
		});

		it('should detect "85% of context" format', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('85% of context');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
		});

		it('should detect "context: 70%" format', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('context: 70%');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(70);
			expect(state!.level).toBe('yellow');
		});

		it('should detect "context 80%" format', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('context 80%');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(80);
		});

		it('should detect "42% ctx" format', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('42% ctx');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(42);
			expect(state!.level).toBe('normal');
		});

		it('should handle ANSI codes in data', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('\x1b[32m85% context\x1b[0m');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
		});

		it('should handle data split across multiple chunks', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('85% con');
			mockSession.emit('text remaining');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
		});

		it('should ignore invalid percentages (>100)', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('150% context');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(0); // unchanged
		});

		it('should handle 0% context', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('0% context');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(0);
			expect(state!.level).toBe('normal');
		});

		it('should handle 100% context at critical level (compact attempted, no auto-recovery)', async () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('100% context');
			await jest.advanceTimersByTimeAsync(300);

			// Auto-recovery is disabled, so state should still exist
			// and compact should have been attempted
			const state = service.getContextState('test-agent');
			expect(state).toBeDefined();
			expect(state!.level).toBe('critical');
			expect(state!.compactAttempts).toBe(1);
		});

		it('should cap buffer at MAX_BUFFER_SIZE', () => {
			const { service, mockSession } = setupWithSession();
			// Send a large amount of data without any context pattern
			const largeData = 'x'.repeat(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_BUFFER_SIZE + 1000);
			mockSession.emit(largeData);

			// Then send the pattern - it should still work
			mockSession.emit('75% context');
			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(75);
		});

		it('should clear buffer after successful extraction', () => {
			const { service, mockSession } = setupWithSession();
			mockSession.emit('70% context');
			expect(service.getContextState('test-agent')!.contextPercent).toBe(70);

			// Send non-matching data followed by new percentage
			mockSession.emit('some other output');
			mockSession.emit('85% context');
			expect(service.getContextState('test-agent')!.contextPercent).toBe(85);
		});
	});

	// =========================================================================
	// Threshold transitions
	// =========================================================================

	describe('threshold transitions', () => {
		function setupWithEventBus() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, eventBus };
		}

		it('should transition normal -> yellow and publish warning', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 70);

			const state = service.getContextState('test-agent');
			expect(state!.level).toBe('yellow');
			expect(eventBus.publish).toHaveBeenCalledTimes(1);
			expect(eventBus.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'agent:context_warning',
					changedField: 'contextUsage',
					newValue: 'yellow',
				})
			);
		});

		it('should transition yellow -> red and publish warning', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 70); // yellow
			service.updateContextUsage('test-agent', 85); // red

			expect(eventBus.publish).toHaveBeenCalledTimes(2);
			expect(eventBus.publish).toHaveBeenLastCalledWith(
				expect.objectContaining({
					type: 'agent:context_warning',
					newValue: 'red',
				})
			);
		});

		it('should transition red -> critical and publish critical', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 85); // red
			service.updateContextUsage('test-agent', 95); // critical

			expect(eventBus.publish).toHaveBeenCalledTimes(2);
			expect(eventBus.publish).toHaveBeenLastCalledWith(
				expect.objectContaining({
					type: 'agent:context_critical',
					newValue: 'critical',
				})
			);
		});

		it('should NOT fire events for same level repeated', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 70); // yellow
			service.updateContextUsage('test-agent', 72); // still yellow
			service.updateContextUsage('test-agent', 75); // still yellow

			expect(eventBus.publish).toHaveBeenCalledTimes(1); // only the first transition
		});

		it('should NOT fire events when staying in normal range', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 10);
			service.updateContextUsage('test-agent', 30);
			service.updateContextUsage('test-agent', 50);

			expect(eventBus.publish).not.toHaveBeenCalled();
		});

		it('should fire event again when level drops and rises back', () => {
			const { service, eventBus } = setupWithEventBus();

			service.updateContextUsage('test-agent', 70); // yellow
			service.updateContextUsage('test-agent', 50); // normal
			service.updateContextUsage('test-agent', 70); // yellow again

			expect(eventBus.publish).toHaveBeenCalledTimes(2);
		});

		it('should broadcast to frontend on threshold transitions', () => {
			const { service } = setupWithEventBus();

			service.updateContextUsage('test-agent', 70);

			expect(mockBroadcastContextWindowStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'test-agent',
					contextPercent: 70,
					level: 'yellow',
				})
			);
		});
	});

	// =========================================================================
	// Event publishing
	// =========================================================================

	describe('event publishing', () => {
		it('should publish events with correct structure', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			service.updateContextUsage('test-agent', 86);

			expect(eventBus.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'test-uuid-1234',
					type: 'agent:context_warning',
					teamId: 'team-1',
					memberId: 'member-1',
					sessionName: 'test-agent',
					previousValue: '86',
					newValue: 'red',
					changedField: 'contextUsage',
				})
			);
		});

		it('should not publish events when eventBusService is not set', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			// Set dependencies without event bus
			(service as any).sessionBackend = backend;

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Should not throw
			service.updateContextUsage('test-agent', 86);

			const state = service.getContextState('test-agent');
			expect(state!.level).toBe('red');
		});
	});

	// =========================================================================
	// Context compaction
	// =========================================================================

	describe('context compaction', () => {
		function setupWithCompact() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, eventBus, regService };
		}

		it('should trigger compact at red level (85%)', async () => {
			const { service, mockSession } = setupWithCompact();

			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			// Compact command should have been written to session
			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).toContain('/compact\r');
		});

		it('should set compactInProgress during compact', () => {
			const { service } = setupWithCompact();

			service.updateContextUsage('test-agent', 86);

			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(true);
			expect(state!.compactAttempts).toBe(1);
		});

		it('should clear compactInProgress after COMPACT_WAIT_MS', async () => {
			const { service } = setupWithCompact();

			service.updateContextUsage('test-agent', 86);

			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(true);

			// triggerCompact has a 200ms internal await before scheduling the
			// COMPACT_WAIT_MS timeout, so we need to advance past both:
			// 200ms (internal delay) + COMPACT_WAIT_MS (clear timer)
			await jest.advanceTimersByTimeAsync(200);
			await jest.advanceTimersByTimeAsync(CONTEXT_WINDOW_MONITOR_CONSTANTS.COMPACT_WAIT_MS);

			expect(state!.compactInProgress).toBe(false);
		});

		it('should not trigger compact twice while compactInProgress', () => {
			const { service, mockSession } = setupWithCompact();

			service.updateContextUsage('test-agent', 70); // yellow
			service.updateContextUsage('test-agent', 86); // red -> compact

			const state = service.getContextState('test-agent');
			expect(state!.compactAttempts).toBe(1);

			// Going back to yellow and then red again should NOT trigger
			// compact because compactInProgress is still true
			state!.level = 'yellow'; // simulate drop
			service.updateContextUsage('test-agent', 87); // red again

			expect(state!.compactAttempts).toBe(1); // still 1
		});

		it('should reset compact state when context drops to normal', () => {
			const { service } = setupWithCompact();

			service.updateContextUsage('test-agent', 86); // red -> triggers compact

			const state = service.getContextState('test-agent');
			expect(state!.compactAttempts).toBe(1);

			// Simulate context dropping to normal (compact worked!)
			service.updateContextUsage('test-agent', 40);

			expect(state!.compactAttempts).toBe(0);
			expect(state!.compactInProgress).toBe(false);
		});

		it('should prefer compact over recovery at critical when under max attempts', async () => {
			const { service, mockSession, regService } = setupWithCompact();

			// Go straight to critical
			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(300);

			// Should have sent compact, NOT triggered recovery
			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).toContain('/compact\r');
			expect(regService.createAgentSession).not.toHaveBeenCalled();
		});

		it('should NOT fall back to recovery when compact exhausted and AUTO_RECOVERY_ENABLED is false', async () => {
			const { service, regService } = setupWithCompact();

			// Manually exhaust compact attempts
			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(300);

			// AUTO_RECOVERY_ENABLED is false — recovery should NOT be triggered
			// even when compact attempts are exhausted
			expect(regService.createAgentSession).not.toHaveBeenCalled();
		});

		it('should send escape before compact command', async () => {
			const { service, mockSession } = setupWithCompact();

			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			// Escape (0x1b) should be sent before compact
			const escapeIndex = writeCalls.indexOf('\x1b');
			const compactIndex = writeCalls.indexOf('/compact\r');
			expect(escapeIndex).toBeGreaterThanOrEqual(0);
			expect(compactIndex).toBeGreaterThan(escapeIndex);
		});

		it('should NOT send escape before /compress for gemini runtime', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer', 'gemini-cli');
			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).toContain('/compress\r');
			expect(writeCalls).not.toContain('\x1b');
		});

		it('should track lastCompactAt timestamp', () => {
			const { service } = setupWithCompact();
			const before = Date.now();

			service.updateContextUsage('test-agent', 86);

			const state = service.getContextState('test-agent');
			expect(state!.lastCompactAt).toBeGreaterThanOrEqual(before);
		});
	});

	// =========================================================================
	// Auto-recovery (disabled by default — compact-first strategy)
	// =========================================================================

	describe('auto-recovery (disabled by default)', () => {
		it('should NOT trigger recovery at critical when AUTO_RECOVERY_ENABLED is false', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Exhaust compact attempts first
			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(100);

			// AUTO_RECOVERY_ENABLED is false — should NOT trigger recovery
			expect(regService.createAgentSession).not.toHaveBeenCalled();
			// State should still exist (not cleared by recovery)
			expect(service.getContextState('test-agent')).toBeDefined();
		});

		it('should prefer compact over recovery at critical', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(300);

			// Should have sent compact, NOT triggered recovery
			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).toContain('/compact\r');
			expect(regService.createAgentSession).not.toHaveBeenCalled();
		});

		it('should publish critical event at critical even without recovery', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Transition through red to critical
			service.updateContextUsage('test-agent', 86); // red
			service.updateContextUsage('test-agent', 96); // critical

			expect(eventBus.publish).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'agent:context_critical',
					newValue: 'critical',
				})
			);
		});
	});

	// =========================================================================
	// Recovery cooldown
	// =========================================================================

	describe('recovery cooldown', () => {
		it('should enforce max recoveries per cooldown window', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Manually set recovery timestamps to fill the window
			const state = service.getContextState('test-agent')!;
			state.recoveryTimestamps = Array(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_RECOVERIES_PER_WINDOW)
				.fill(Date.now());
			state.level = 'red'; // ensure transition to critical fires

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(100);

			// Recovery should NOT be triggered because cooldown is active
			expect(regService.createAgentSession).not.toHaveBeenCalled();
		});

		it('should NOT allow recovery after cooldown window expires when AUTO_RECOVERY_ENABLED is false', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Set old timestamps that are outside the cooldown window
			const state = service.getContextState('test-agent')!;
			const oldTimestamp = Date.now() - CONTEXT_WINDOW_MONITOR_CONSTANTS.COOLDOWN_WINDOW_MS - 1000;
			state.recoveryTimestamps = Array(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_RECOVERIES_PER_WINDOW)
				.fill(oldTimestamp);

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(100);

			// AUTO_RECOVERY_ENABLED is false — recovery should NOT be triggered
			// regardless of cooldown window state
			expect(regService.createAgentSession).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Stale detection
	// =========================================================================

	describe('stale detection in performCheck', () => {
		it('should reset stale states to normal', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Set state to yellow with old timestamp
			const state = service.getContextState('test-agent')!;
			state.level = 'yellow';
			state.contextPercent = 72;
			state.lastDetectedAt = Date.now() - CONTEXT_WINDOW_MONITOR_CONSTANTS.STALE_DETECTION_THRESHOLD_MS - 1000;

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			expect(state.level).toBe('normal');
			expect(state.recoveryTriggered).toBe(false);
		});

		it('should not reset fresh states', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Set state to yellow with recent timestamp
			const state = service.getContextState('test-agent')!;
			state.level = 'yellow';
			state.contextPercent = 72;
			state.lastDetectedAt = Date.now(); // very fresh

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			expect(state.level).toBe('yellow'); // unchanged
		});

		it('should not reset normal states even if stale', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// State is already normal
			const state = service.getContextState('test-agent')!;
			state.lastDetectedAt = Date.now() - CONTEXT_WINDOW_MONITOR_CONSTANTS.STALE_DETECTION_THRESHOLD_MS - 1000;

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			expect(state.level).toBe('normal');
		});
	});

	// =========================================================================
	// Edge cases
	// =========================================================================

	describe('edge cases', () => {
		it('should handle updateContextUsage for non-monitored session', () => {
			const service = ContextWindowMonitorService.getInstance();

			// Should not throw
			service.updateContextUsage('nonexistent', 85);
		});

		it('should handle stopSessionMonitoring for non-monitored session', () => {
			const service = ContextWindowMonitorService.getInstance();

			// Should not throw
			service.stopSessionMonitoring('nonexistent');
		});

		it('should handle PTY data for stopped session gracefully', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			service.stopSessionMonitoring('test-agent');

			// Emit after stop - should not throw or update any state
			mockSession.emit('95% context');

			expect(service.getContextState('test-agent')).toBeUndefined();
		});

		it('should not start monitoring when no backend is available', () => {
			const service = ContextWindowMonitorService.getInstance();
			// Don't call setDependencies — getSessionBackendSync() mock returns null

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			expect(service.getContextState('test-agent')).toBeUndefined();
		});
	});

	// =========================================================================
	// triggerCompact error branches
	// =========================================================================

	describe('triggerCompact error branches', () => {
		it('should handle compact when session no longer exists', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Remove the session from the backend so getSession returns null
			sessions.delete('test-agent');

			// Trigger red level → compact
			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			// triggerCompact returns early before incrementing compactAttempts
			const state = service.getContextState('test-agent');
			expect(state!.compactAttempts).toBe(0);
			// Session.write not called for /compact since session was deleted
			expect(mockSession.session.write).not.toHaveBeenCalled();
		});

		it('should handle compact when backend is null', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Null out the backend after monitoring started
			(service as any).sessionBackend = null;

			// Trigger red level → compact
			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			// triggerCompact returns early before incrementing — should not throw
			const state = service.getContextState('test-agent');
			expect(state!.compactAttempts).toBe(0);
		});

		it('should handle compact when runtime type has no compact command', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			// Start monitoring with an unknown runtime type
			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer', 'unknown-runtime' as any);

			// Trigger red level → compact
			service.updateContextUsage('test-agent', 86);
			await jest.advanceTimersByTimeAsync(300);

			// Compact attempted but no command for runtime — write not called
			expect(mockSession.session.write).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// performCheck compact retry
	// =========================================================================

	describe('performCheck compact retry', () => {
		it('should retry compact after cooldown for critical sessions with exhausted attempts', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Set up state: critical, compacts exhausted, cooldown expired
			const state = service.getContextState('test-agent')!;
			state.level = 'critical';
			state.contextPercent = 96;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;
			state.recoveryTriggered = false;
			state.lastCompactAt = Date.now() - CONTEXT_WINDOW_MONITOR_CONSTANTS.COMPACT_RETRY_COOLDOWN_MS - 1000;
			state.lastDetectedAt = Date.now(); // Not stale

			// Start the service (periodic check) and advance to trigger performCheck
			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			// After retry, compactAttempts should be reset to MAX - 1 then incremented
			expect(state.compactAttempts).toBe(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS);
			expect(state.compactInProgress).toBe(true);

			// Clean up
			await jest.advanceTimersByTimeAsync(300);
		});

		it('should NOT retry compact if cooldown has not expired', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Set up state: critical, compacts exhausted, cooldown NOT expired
			const state = service.getContextState('test-agent')!;
			state.level = 'critical';
			state.contextPercent = 96;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;
			state.recoveryTriggered = false;
			state.lastCompactAt = Date.now(); // Just happened
			state.lastDetectedAt = Date.now();

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			// Should NOT retry — compactAttempts unchanged
			expect(state.compactAttempts).toBe(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS);
			expect(state.compactInProgress).toBe(false);
		});
	});

	// =========================================================================
	// Auto-recovery (when enabled)
	// =========================================================================

	describe('auto-recovery when enabled', () => {
		const originalAutoRecovery = CONTEXT_WINDOW_MONITOR_CONSTANTS.AUTO_RECOVERY_ENABLED;

		beforeEach(() => {
			Object.defineProperty(CONTEXT_WINDOW_MONITOR_CONSTANTS, 'AUTO_RECOVERY_ENABLED', {
				value: true,
				writable: true,
				configurable: true,
			});
		});

		afterEach(() => {
			Object.defineProperty(CONTEXT_WINDOW_MONITOR_CONSTANTS, 'AUTO_RECOVERY_ENABLED', {
				value: originalAutoRecovery,
				writable: true,
				configurable: true,
			});
		});

		it('should trigger auto-recovery at critical when compact exhausted', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(true);

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Exhaust compact attempts
			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			// Hit critical → triggers auto-recovery
			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(500);

			expect(state.recoveryTriggered).toBe(true);
			expect(mockAgentReg.createAgentSession).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionName: 'test-agent',
					memberId: 'member-1',
					teamId: 'team-1',
				})
			);
		});

		it('should handle auto-recovery when backend is missing', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Exhaust compact, null out backend
			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;
			(service as any).sessionBackend = null;

			// Hit critical → triggerAutoRecovery but no backend
			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(500);

			// Should not throw, recoveryTriggered is set but early return
			expect(state.recoveryTriggered).toBe(true);
		});

		it('should handle createAgentSession failure during recovery', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(false); // fail

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(500);

			expect(state.recoveryTriggered).toBe(true);
			// Recovery count should NOT increase on failure
			expect(state.recoveryCount).toBe(0);
		});

		it('should re-deliver active tasks after successful recovery', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(true);
			const activeTasks = [
				{ taskName: 'task-1', taskFilePath: '/tmp/task-1.md', status: 'assigned' },
			];
			const mockTaskTracking = createMockTaskTrackingService(activeTasks);

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				mockTaskTracking as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);

			// Advance enough for recovery + rehydration delay + task re-delivery
			await jest.advanceTimersByTimeAsync(60_000);

			expect(state.recoveryTriggered).toBe(true);
			expect(state.recoveryCount).toBe(1);
			expect(mockTaskTracking.getTasksForTeamMember).toHaveBeenCalledWith('member-1');
		});

		it('should skip re-delivery when no taskTrackingService', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(true);

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				null as any, // no task tracking
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(60_000);

			// Should recover without throwing
			expect(state.recoveryTriggered).toBe(true);
			expect(state.recoveryCount).toBe(1);
		});

		it('should respect recovery cooldown window', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(true);

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Fill up recovery timestamps at the max
			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;
			state.recoveryTimestamps = Array(CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_RECOVERIES_PER_WINDOW)
				.fill(0)
				.map(() => Date.now());

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(500);

			// recoveryTriggered should be set but createAgentSession should not be called
			// because cooldown prevents the actual recovery
			expect(state.recoveryTriggered).toBe(true);
			expect(mockAgentReg.createAgentSession).not.toHaveBeenCalled();
		});

		it('should save and restore Claude session ID during recovery', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegistrationService(true);

			mockGetSessionId.mockReturnValue('claude-session-abc');
			mockGetSessionMetadata.mockReturnValue({ sessionName: 'test-agent' });

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			const state = service.getContextState('test-agent')!;
			state.compactAttempts = CONTEXT_WINDOW_MONITOR_CONSTANTS.MAX_COMPACT_ATTEMPTS;
			state.compactInProgress = false;

			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(60_000);

			expect(mockGetSessionId).toHaveBeenCalledWith('test-agent');
			expect(mockUpdateSessionId).toHaveBeenCalledWith('test-agent', 'claude-session-abc');
		});
	});

	// =========================================================================
	// Proactive compact (cumulative output volume)
	// =========================================================================

	describe('proactive compact', () => {
		function setupWithProactiveCompact() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const mockGetCumulativeOutputBytes = jest.fn().mockReturnValue(0);
			const mockResetCumulativeOutput = jest.fn();
			const backend = {
				...createMockSessionBackend(sessions as any),
				getCumulativeOutputBytes: mockGetCumulativeOutputBytes,
				resetCumulativeOutput: mockResetCumulativeOutput,
			};
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, backend, mockGetCumulativeOutputBytes, mockResetCumulativeOutput };
		}

		it('should trigger proactive compact when cumulative output exceeds threshold', () => {
			const { service, mockGetCumulativeOutputBytes, mockResetCumulativeOutput } = setupWithProactiveCompact();

			// Set cumulative bytes above threshold
			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);

			// Start periodic check and advance timer
			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			// Should have reset cumulative output (confirming threshold was detected)
			expect(mockResetCumulativeOutput).toHaveBeenCalledWith('test-agent');
			// Should have set compactInProgress (confirming compact was triggered)
			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(true);
			expect(state!.compactAttempts).toBe(1);
		});

		it('should NOT trigger proactive compact when below threshold', () => {
			const { service, mockGetCumulativeOutputBytes, mockResetCumulativeOutput } = setupWithProactiveCompact();

			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES - 1
			);

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			expect(mockResetCumulativeOutput).not.toHaveBeenCalled();
		});

		it('should respect cooldown between proactive compacts', () => {
			const { service, mockGetCumulativeOutputBytes, mockResetCumulativeOutput } = setupWithProactiveCompact();

			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);

			service.start();

			// First check triggers compact
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
			expect(mockResetCumulativeOutput).toHaveBeenCalledTimes(1);

			// Reset the compactInProgress flag to simulate compact completion
			const state = service.getContextState('test-agent')!;
			state.compactInProgress = false;

			// Second check within cooldown should NOT trigger
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
			expect(mockResetCumulativeOutput).toHaveBeenCalledTimes(1); // still 1
		});

		it('should allow proactive compact after cooldown expires', () => {
			const { service, mockGetCumulativeOutputBytes, mockResetCumulativeOutput } = setupWithProactiveCompact();

			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);

			service.start();

			// First trigger
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
			expect(mockResetCumulativeOutput).toHaveBeenCalledTimes(1);

			// Reset compactInProgress
			const state = service.getContextState('test-agent')!;
			state.compactInProgress = false;

			// Advance past cooldown
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_COOLDOWN_MS);

			expect(mockResetCumulativeOutput).toHaveBeenCalledTimes(2);
		});

		it('should NOT trigger proactive compact when compactInProgress', () => {
			const { service, mockGetCumulativeOutputBytes, mockResetCumulativeOutput } = setupWithProactiveCompact();

			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);

			// Set compactInProgress before check
			const state = service.getContextState('test-agent')!;
			state.compactInProgress = true;

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			expect(mockResetCumulativeOutput).not.toHaveBeenCalled();
		});

		it('should gracefully handle backend without getCumulativeOutputBytes', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			// backend does NOT have getCumulativeOutputBytes/resetCumulativeOutput

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Should not throw
			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);
		});

		it('should clean up proactiveCompactLastTriggered on stopSessionMonitoring', () => {
			const { service, mockGetCumulativeOutputBytes } = setupWithProactiveCompact();

			mockGetCumulativeOutputBytes.mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);

			// Trigger to populate the map
			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			// Stop monitoring — should clean up
			service.stopSessionMonitoring('test-agent');

			// Verify state is fully cleaned up
			expect(service.getContextState('test-agent')).toBeUndefined();
		});
	});

	// =========================================================================
	// Compact gating (Option A+B per spec 2026-05-05-compact-fix-AB-followup)
	//
	// Verifies the fail-safe-CLOSED contract for both compact gates:
	//   - `proactiveCompactEnabled` defaults to `false` (initial cached value)
	//   - `thresholdCompactEnabled` defaults to `false` (initial cached value)
	//   - When `thresholdCompactEnabled === false`:
	//       * RED-level (≥85%) /compact emission is blocked
	//       * CRITICAL-level (≥95%) /compact emission is blocked
	//       * CRITICAL auto-recovery still runs (when AUTO_RECOVERY_ENABLED)
	//   - Refresh paths fail-safe to `false` on undefined settings
	// =========================================================================

	describe('compact gating (Option A+B)', () => {
		/**
		 * Build a service WITHOUT touching the gate fields, so the production
		 * fail-safe defaults are preserved for the assertion. The outer
		 * describe's `beforeEach` re-opens both gates by default; we override
		 * back to `false` here to verify the closed-by-default contract.
		 */
		function setupWithGatesClosed() {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { proactiveCompactEnabled: boolean; thresholdCompactEnabled: boolean }).proactiveCompactEnabled = false;
			(service as unknown as { proactiveCompactEnabled: boolean; thresholdCompactEnabled: boolean }).thresholdCompactEnabled = false;

			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();
			const regService = createMockAgentRegistrationService();

			service.setDependencies(
				backend as any,
				regService as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);
			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, eventBus, regService };
		}

		// -------------------------------------------------------------------
		// Initial state — fail-safe CLOSED defaults
		// -------------------------------------------------------------------

		it('initial cached proactiveCompactEnabled defaults to false (fail-safe CLOSED)', () => {
			ContextWindowMonitorService.resetInstance();
			const service = ContextWindowMonitorService.getInstance();

			// Read the private field via cast — verifying the production default.
			const value = (service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled;
			expect(value).toBe(false);
		});

		it('initial cached thresholdCompactEnabled defaults to false (fail-safe CLOSED)', () => {
			ContextWindowMonitorService.resetInstance();
			const service = ContextWindowMonitorService.getInstance();

			const value = (service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled;
			expect(value).toBe(false);
		});

		// -------------------------------------------------------------------
		// Threshold-compact gating — RED level
		// -------------------------------------------------------------------

		it('RED-level compact is BLOCKED when thresholdCompactEnabled=false', async () => {
			const { service, mockSession } = setupWithGatesClosed();

			service.updateContextUsage('test-agent', 86); // red
			await jest.advanceTimersByTimeAsync(300);

			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).not.toContain('/compact\r');

			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(false);
			expect(state!.compactAttempts).toBe(0);
		});

		it('RED-level compact FIRES when thresholdCompactEnabled=true', async () => {
			const { service, mockSession } = setupWithGatesClosed();
			(service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled = true;

			service.updateContextUsage('test-agent', 86); // red
			await jest.advanceTimersByTimeAsync(300);

			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).toContain('/compact\r');
		});

		// -------------------------------------------------------------------
		// Threshold-compact gating — CRITICAL level
		// -------------------------------------------------------------------

		it('CRITICAL-level compact attempt is BLOCKED when thresholdCompactEnabled=false', async () => {
			const { service, mockSession } = setupWithGatesClosed();

			// Go straight to critical
			service.updateContextUsage('test-agent', 96);
			await jest.advanceTimersByTimeAsync(300);

			const writeCalls = mockSession.session.write.mock.calls.map((c: string[]) => c[0]);
			expect(writeCalls).not.toContain('/compact\r');

			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(false);
		});

		it('CRITICAL still publishes agent:context_critical event regardless of gate (informational)', () => {
			const { service, eventBus } = setupWithGatesClosed();

			service.updateContextUsage('test-agent', 96);

			// The critical event publish happens before the gated compact attempt,
			// so it must fire even when the wrapper-driven compact is suppressed.
			expect(eventBus.publish).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'agent:context_critical' })
			);
		});

		// -------------------------------------------------------------------
		// Refresh paths — settings hydration fail-safe semantics
		// -------------------------------------------------------------------

		it('refreshProactiveCompactSetting falls back to false when getSettings returns undefined.general', async () => {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled = true; // pre-existing value

			const settingsService = require('../settings/settings.service.js');
			const spy = jest.spyOn(settingsService, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({}), // no `general`
			} as any);

			await (service as unknown as { refreshProactiveCompactSetting: () => Promise<void> }).refreshProactiveCompactSetting();

			const value = (service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled;
			expect(value).toBe(false);

			spy.mockRestore();
		});

		it('refreshThresholdCompactSetting falls back to false when getSettings returns undefined.general', async () => {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled = true; // pre-existing value

			const settingsService = require('../settings/settings.service.js');
			const spy = jest.spyOn(settingsService, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({}), // no `general`
			} as any);

			await (service as unknown as { refreshThresholdCompactSetting: () => Promise<void> }).refreshThresholdCompactSetting();

			const value = (service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled;
			expect(value).toBe(false);

			spy.mockRestore();
		});

		it('refreshProactiveCompactSetting reads enableProactiveCompact=true when persisted', async () => {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled = false;

			const settingsService = require('../settings/settings.service.js');
			const spy = jest.spyOn(settingsService, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({ general: { enableProactiveCompact: true } }),
			} as any);

			await (service as unknown as { refreshProactiveCompactSetting: () => Promise<void> }).refreshProactiveCompactSetting();

			const value = (service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled;
			expect(value).toBe(true);

			spy.mockRestore();
		});

		it('refreshThresholdCompactSetting reads enableThresholdCompact=true when persisted', async () => {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled = false;

			const settingsService = require('../settings/settings.service.js');
			const spy = jest.spyOn(settingsService, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockResolvedValue({ general: { enableThresholdCompact: true } }),
			} as any);

			await (service as unknown as { refreshThresholdCompactSetting: () => Promise<void> }).refreshThresholdCompactSetting();

			const value = (service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled;
			expect(value).toBe(true);

			spy.mockRestore();
		});

		it('refreshThresholdCompactSetting keeps last-known value on read failure (non-fatal)', async () => {
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled = true; // last known

			const settingsService = require('../settings/settings.service.js');
			const spy = jest.spyOn(settingsService, 'getSettingsService').mockReturnValue({
				getSettings: jest.fn().mockRejectedValue(new Error('disk error')),
			} as any);

			await (service as unknown as { refreshThresholdCompactSetting: () => Promise<void> }).refreshThresholdCompactSetting();

			// Last known value preserved on transient read failure.
			const value = (service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled;
			expect(value).toBe(true);

			spy.mockRestore();
		});

		// -------------------------------------------------------------------
		// Proactive-path gating (negative case) — per Arch review obs 3
		// -------------------------------------------------------------------

		it('proactive compact is BLOCKED when proactiveCompactEnabled=false even if cumulative output exceeds threshold', () => {
			// Mirror of `should trigger proactive compact when cumulative output
			// exceeds threshold` (in `proactive compact` describe), but with the
			// gate explicitly closed. Confirms the L1091 single-boolean gate
			// covers the path end-to-end so resetCumulativeOutput is NOT called.
			const service = ContextWindowMonitorService.getInstance();
			(service as unknown as { proactiveCompactEnabled: boolean }).proactiveCompactEnabled = false;
			// The outer beforeEach also re-opened threshold; close it too so
			// nothing else fires for this test.
			(service as unknown as { thresholdCompactEnabled: boolean }).thresholdCompactEnabled = false;

			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const mockGetCumulativeOutputBytes = jest.fn().mockReturnValue(
				CONTEXT_WINDOW_MONITOR_CONSTANTS.PROACTIVE_COMPACT_THRESHOLD_BYTES + 1
			);
			const mockResetCumulativeOutput = jest.fn();
			const backend = {
				...createMockSessionBackend(sessions as any),
				getCumulativeOutputBytes: mockGetCumulativeOutputBytes,
				resetCumulativeOutput: mockResetCumulativeOutput,
			};

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);
			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			service.start();
			jest.advanceTimersByTime(CONTEXT_WINDOW_MONITOR_CONSTANTS.CHECK_INTERVAL_MS);

			// Gate closed → proactive path short-circuits at L1091 → reset NOT called
			expect(mockResetCumulativeOutput).not.toHaveBeenCalled();

			const state = service.getContextState('test-agent');
			expect(state!.compactInProgress).toBe(false);
			expect(state!.compactAttempts).toBe(0);
		});
	});

	// =========================================================================
	// Gemini token-count context detection
	// =========================================================================

	describe('Gemini token-count context detection', () => {
		function setupGeminiSession() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer', 'gemini-cli');
			return { service, mockSession, eventBus };
		}

		it('should detect "500K context left" as ~50% usage', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('500K context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(50);
			expect(state!.level).toBe('normal');
		});

		it('should detect "200K context left" as ~80% usage', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('200K context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(80);
			expect(state!.level).toBe('yellow');
		});

		it('should detect "100K context left" as ~90% usage (red)', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('100K context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(90);
			expect(state!.level).toBe('red');
		});

		it('should detect "50K context left" as ~95% usage (critical)', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('50K context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(95);
			expect(state!.level).toBe('critical');
		});

		it('should detect "1M context left" as ~0% usage', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('1M context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(0);
			expect(state!.level).toBe('normal');
		});

		it('should detect "0.5M context left" as ~50% usage', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('0.5M context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(50);
			expect(state!.level).toBe('normal');
		});

		it('should detect "150K tokens context left" format', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('150K tokens context left');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
			expect(state!.level).toBe('red');
		});

		it('should detect "300K context remaining" format', () => {
			const { service, mockSession } = setupGeminiSession();
			mockSession.emit('300K context remaining');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(70);
			expect(state!.level).toBe('yellow');
		});

		it('should still detect percentage format for Gemini if present', () => {
			const { service, mockSession } = setupGeminiSession();
			// If Gemini ever outputs percentage format, it should still work
			mockSession.emit('85% context');

			const state = service.getContextState('test-agent');
			expect(state!.contextPercent).toBe(85);
			expect(state!.level).toBe('red');
		});
	});

	// =========================================================================
	// Post-compact verification
	// =========================================================================

	describe('post-compact verification', () => {
		function setupForPostCompact() {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			return { service, mockSession, eventBus };
		}

		it('should store preCompactPercent when compact is triggered', () => {
			const { service } = setupForPostCompact();

			service.updateContextUsage('test-agent', 86);

			const state = service.getContextState('test-agent');
			expect(state!.preCompactPercent).toBe(86);
		});

		it('should store compactWaitTimer reference when compact is triggered', async () => {
			const { service } = setupForPostCompact();

			service.updateContextUsage('test-agent', 86);
			// triggerCompact is async — advance past the 200ms internal delay
			await jest.advanceTimersByTimeAsync(300);

			const state = service.getContextState('test-agent');
			expect(state!.compactWaitTimer).not.toBeNull();
		});

		it('should clear compactWaitTimer after COMPACT_WAIT_MS', async () => {
			const { service } = setupForPostCompact();

			service.updateContextUsage('test-agent', 86);
			// Advance past the 200ms internal delay to let triggerCompact set the timer
			await jest.advanceTimersByTimeAsync(300);

			const state = service.getContextState('test-agent');
			expect(state!.compactWaitTimer).not.toBeNull();

			// Now advance past COMPACT_WAIT_MS
			await jest.advanceTimersByTimeAsync(CONTEXT_WINDOW_MONITOR_CONSTANTS.COMPACT_WAIT_MS);

			expect(state!.compactWaitTimer).toBeNull();
			expect(state!.compactInProgress).toBe(false);
		});
	});

	// =========================================================================
	// Compact timer cleanup on session stop
	// =========================================================================

	describe('compact timer cleanup', () => {
		it('should clear compactWaitTimer on stopSessionMonitoring', async () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');
			service.updateContextUsage('test-agent', 86); // triggers compact
			// Advance past the 200ms internal delay to let triggerCompact set the timer
			await jest.advanceTimersByTimeAsync(300);

			const state = service.getContextState('test-agent');
			expect(state!.compactWaitTimer).not.toBeNull();

			// Stop monitoring — should clean up timer
			service.stopSessionMonitoring('test-agent');

			// State is deleted, so we verify indirectly: no errors from dangling timeouts
			expect(service.getContextState('test-agent')).toBeUndefined();
		});

		it('should not throw when stopping session with no active compact timer', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);

			service.setDependencies(
				backend as any,
				createMockAgentRegistrationService() as any,
				{} as any,
				createMockTaskTrackingService() as any,
				createMockEventBus() as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// No compact triggered, so no timer
			const state = service.getContextState('test-agent');
			expect(state!.compactWaitTimer).toBeNull();

			// Should not throw
			service.stopSessionMonitoring('test-agent');
			expect(service.getContextState('test-agent')).toBeUndefined();
		});
	});

	describe('#166: pre-compaction memory flush', () => {
		function createMockAgentRegWithSendMessage() {
			return {
				createAgentSession: jest.fn().mockResolvedValue({
					success: true,
					sessionName: 'test-session',
				}),
				sendMessageToAgent: jest.fn().mockResolvedValue({ success: true }),
			};
		}

		it('should send memory flush message before first compact at red level', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegWithSendMessage();
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// Transition to red
			service.updateContextUsage('test-agent', 85);

			// Should have sent pre-compaction flush message via agentRegistrationService
			expect(mockAgentReg.sendMessageToAgent).toHaveBeenCalledWith(
				'test-agent',
				expect.stringContaining('PRE-COMPACTION MEMORY FLUSH'),
				expect.anything()
			);
		});

		it('should only send flush on first compact attempt', () => {
			const service = ContextWindowMonitorService.getInstance();
			const mockSession = createMockSession();
			const sessions = new Map([['test-agent', mockSession.session]]);
			const backend = createMockSessionBackend(sessions as any);
			const mockAgentReg = createMockAgentRegWithSendMessage();
			const eventBus = createMockEventBus();

			service.setDependencies(
				backend as any,
				mockAgentReg as any,
				{} as any,
				createMockTaskTrackingService() as any,
				eventBus as any
			);

			service.startSessionMonitoring('test-agent', 'member-1', 'team-1', 'developer');

			// First red transition - should flush
			service.updateContextUsage('test-agent', 85);
			const flushCallCount = mockAgentReg.sendMessageToAgent.mock.calls.filter(
				(call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('PRE-COMPACTION')
			).length;
			expect(flushCallCount).toBe(1);

			// Second red evaluation should NOT flush again (compactAttempts > 0)
			mockAgentReg.sendMessageToAgent.mockClear();
			service.updateContextUsage('test-agent', 87);
			const secondFlushCount = mockAgentReg.sendMessageToAgent.mock.calls.filter(
				(call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('PRE-COMPACTION')
			).length;
			expect(secondFlushCount).toBe(0);
		});
	});
});
