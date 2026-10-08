/**
 * Tests for PtyActivityTrackerService
 */

import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';

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

// Mock terminal-output.utils (stripAnsiCodes)
jest.mock('../../utils/terminal-output.utils.js', () => ({
	stripAnsiCodes: (content: string) => content.replace(/\x1b\[[0-9;]*[A-Za-zH]/g, '').replace(/\x1b[^[\]].?/g, ''),
}));

describe('PtyActivityTrackerService', () => {
	beforeEach(() => {
		PtyActivityTrackerService.resetInstance();
	});

	describe('getInstance', () => {
		it('should return a singleton instance', () => {
			const a = PtyActivityTrackerService.getInstance();
			const b = PtyActivityTrackerService.getInstance();
			expect(a).toBe(b);
		});
	});

	describe('resetInstance', () => {
		it('should create a fresh instance after reset', () => {
			const a = PtyActivityTrackerService.getInstance();
			PtyActivityTrackerService.resetInstance();
			const b = PtyActivityTrackerService.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe('recordActivity', () => {
		it('should record activity for a session', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			expect(tracker.hasActivity('agent-dev-001')).toBe(true);
		});

		it('should update timestamp on subsequent calls', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			const firstIdle = tracker.getIdleTimeMs('agent-dev-001');
			tracker.recordActivity('agent-dev-001');
			const secondIdle = tracker.getIdleTimeMs('agent-dev-001');
			expect(secondIdle).toBeLessThanOrEqual(firstIdle);
		});
	});

	describe('recordFilteredActivity', () => {
		it('should record activity for meaningful output', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordFilteredActivity('agent-dev-001', 'Hello world');
			expect(tracker.hasActivity('agent-dev-001')).toBe(true);
		});

		it('should NOT record activity for pure ANSI escape codes', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordFilteredActivity('agent-dev-001', '\x1b[1A\x1b[2K\x1b[1B');
			expect(tracker.hasActivity('agent-dev-001')).toBe(false);
		});

		it('should NOT record activity for whitespace-only output', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordFilteredActivity('agent-dev-001', '   \n\t  ');
			expect(tracker.hasActivity('agent-dev-001')).toBe(false);
		});

		it('should NOT record activity for single character output', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordFilteredActivity('agent-dev-001', 'x');
			expect(tracker.hasActivity('agent-dev-001')).toBe(false);
		});

		it('should record activity for output with ANSI codes mixed with real text', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordFilteredActivity('agent-dev-001', '\x1b[32mSuccess: tests passed\x1b[0m');
			expect(tracker.hasActivity('agent-dev-001')).toBe(true);
		});
	});

	describe('getIdleTimeMs', () => {
		it('should return 0 for unknown sessions', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			expect(tracker.getIdleTimeMs('unknown')).toBe(0);
		});

		it('should return a small number immediately after recording', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			const idle = tracker.getIdleTimeMs('agent-dev-001');
			expect(idle).toBeGreaterThanOrEqual(0);
			expect(idle).toBeLessThan(100); // Should be near zero
		});
	});

	describe('isIdleFor', () => {
		it('should return false for unknown sessions (never seen != idle)', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			expect(tracker.isIdleFor('unknown', 1000)).toBe(false);
		});

		it('should return false immediately after recording with large duration', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			expect(tracker.isIdleFor('agent-dev-001', 60000)).toBe(false);
		});

		it('should return true for 0 duration after recording', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			expect(tracker.isIdleFor('agent-dev-001', 0)).toBe(true);
		});
	});

	describe('hasActivity', () => {
		it('should return false for unknown sessions', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			expect(tracker.hasActivity('unknown')).toBe(false);
		});

		it('should return true after recording', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('test');
			expect(tracker.hasActivity('test')).toBe(true);
		});
	});

	describe('clearSession', () => {
		it('should remove tracking data for a session', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('agent-dev-001');
			expect(tracker.hasActivity('agent-dev-001')).toBe(true);

			tracker.clearSession('agent-dev-001');
			expect(tracker.hasActivity('agent-dev-001')).toBe(false);
			expect(tracker.getIdleTimeMs('agent-dev-001')).toBe(0);
		});

		it('should not throw for unknown sessions', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			expect(() => tracker.clearSession('unknown')).not.toThrow();
		});
	});

	describe('getTrackedSessionCount', () => {
		it('should return 0 initially', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			expect(tracker.getTrackedSessionCount()).toBe(0);
		});

		it('should reflect recorded sessions', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('session-1');
			tracker.recordActivity('session-2');
			expect(tracker.getTrackedSessionCount()).toBe(2);
		});

		it('should decrease after clearing', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.recordActivity('session-1');
			tracker.recordActivity('session-2');
			tracker.clearSession('session-1');
			expect(tracker.getTrackedSessionCount()).toBe(1);
		});
	});

	describe('ignoreOutputFor (Crewly\'s own resize redraws, 2026-10-08)', () => {
		it('output while ignored is not activity; afterwards it is again', () => {
			jest.useFakeTimers();
			try {
				const tracker = PtyActivityTrackerService.getInstance();
				tracker.ignoreOutputFor('ella', 3000);
				tracker.recordFilteredActivity('ella', 'the whole screen redrawn after a resize');
				expect(tracker.hasActivity('ella')).toBe(false);
				jest.advanceTimersByTime(3001);
				tracker.recordFilteredActivity('ella', 'the agent printing something real');
				expect(tracker.hasActivity('ella')).toBe(true);
			} finally {
				jest.useRealTimers();
			}
		});

		it('is per session', () => {
			const tracker = PtyActivityTrackerService.getInstance();
			tracker.ignoreOutputFor('ella', 60_000);
			tracker.recordFilteredActivity('milo', 'output from another agent');
			expect(tracker.hasActivity('milo')).toBe(true);
		});
	});
});

