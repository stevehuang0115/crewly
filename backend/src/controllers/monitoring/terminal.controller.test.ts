/**
 * Terminal Controller Tests
 *
 * Tests for the terminal session management API endpoints.
 *
 * @module terminal-controller.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import * as terminalController from './terminal.controller.js';

// Mock the session module
jest.mock('../../services/session/index.js', () => ({
	getSessionBackendSync: jest.fn(),
	getSessionBackend: jest.fn(),
}));

// Mock the logger service.
// The factory creates a stable mockLogger inside its closure (avoids TDZ from
// jest.mock hoisting) and exposes it via globalThis so tests can assert on
// logger calls. This is the standard pattern when the controller captures the
// logger at module load via `const logger = LoggerService.getInstance()...`.
jest.mock('../../services/core/logger.service.js', () => {
	const mockLogger = {
		info: jest.fn(),
		debug: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
	(globalThis as any).__terminalControllerMockLogger = mockLogger;
	return {
		LoggerService: {
			getInstance: jest.fn(() => ({
				createComponentLogger: jest.fn(() => mockLogger),
			})),
		},
	};
});

// Stable handles to the logger mocks (resolved after jest.mock factory runs).
const mockLoggerWarn = (globalThis as any).__terminalControllerMockLogger?.warn as jest.Mock;
const mockLoggerInfo = (globalThis as any).__terminalControllerMockLogger?.info as jest.Mock;
const mockLoggerDebug = (globalThis as any).__terminalControllerMockLogger?.debug as jest.Mock;
const mockLoggerError = (globalThis as any).__terminalControllerMockLogger?.error as jest.Mock;

// Mock the constants
jest.mock('../../constants.js', () => ({
	TERMINAL_CONTROLLER_CONSTANTS: {
		DEFAULT_CAPTURE_LINES: 50,
		MAX_CAPTURE_LINES: 500,
		MAX_OUTPUT_SIZE: 131072,
	},
	ORCHESTRATOR_SESSION_NAME: 'crewly-orc',
	CREWLY_CONSTANTS: {
		AGENT_STATUSES: {
			INACTIVE: 'inactive',
			STARTING: 'starting',
			STARTED: 'started',
			ACTIVE: 'active',
			SUSPENDED: 'suspended',
		},
	},
	RUNTIME_TYPES: {
		CLAUDE_CODE: 'claude-code',
		GEMINI_CLI: 'gemini-cli',
		CODEX_CLI: 'codex-cli',
		CREWLY_AGENT: 'crewly-agent',
	},
}));

// Mock security utils
jest.mock('../../utils/security.js', () => ({
	validateTerminalInput: jest.fn(() => ({ isValid: true })),
	sanitizeTerminalInput: jest.fn((...args: unknown[]) => args[0]),
	validateSessionName: jest.fn(() => ({ isValid: true })),
}));

// Mock StorageService
const mockFindMemberBySessionName = jest.fn<() => Promise<any>>();
const mockStorageInstance = { findMemberBySessionName: mockFindMemberBySessionName };
jest.mock('../../services/core/storage.service.js', () => ({
	StorageService: {
		getInstance: () => mockStorageInstance,
	},
}));

// Mock SubAgentMessageQueue
const mockEnqueue = jest.fn();
const mockGetQueueSize = jest.fn().mockReturnValue(1);
const mockQueueInstance = { enqueue: mockEnqueue, getQueueSize: mockGetQueueSize };
jest.mock('../../services/messaging/sub-agent-message-queue.service.js', () => ({
	SubAgentMessageQueue: {
		getInstance: () => mockQueueInstance,
	},
}));

// Mock AgentSuspendService
jest.mock('../../services/agent/agent-suspend.service.js', () => ({
	AgentSuspendService: {
		getInstance: () => ({
			isRehydrating: jest.fn<(s: string) => boolean>().mockReturnValue(false),
			rehydrateAgent: jest.fn<(s: string) => Promise<void>>().mockResolvedValue(undefined as unknown as void),
		}),
	},
}));

// Mock PtySessionBackend
jest.mock('../../services/session/pty/pty-session-backend.js', () => ({
	PtySessionBackend: class PtySessionBackend {},
}));

// Mock InProcessLogBuffer (used by listTerminalSessions and captureTerminal)
const mockInProcessLogBuffer = {
	getSessionNames: jest.fn<() => string[]>().mockReturnValue([]),
	hasSession: jest.fn<(s: string) => boolean>().mockReturnValue(false),
	capture: jest.fn<(s: string, n: number) => string>().mockReturnValue(''),
};
jest.mock('../../services/agent/crewly-agent/in-process-log-buffer.js', () => ({
	InProcessLogBuffer: {
		getInstance: () => mockInProcessLogBuffer,
	},
}));

// Mock the in-process runtime registry. writeToSession() consults it so a
// /write to an in-process Crewly Agent runtime (no PTY session) is delivered
// via handleMessage() instead of 404ing (issue #693 follow-up bug (a)).
const mockGetInProcessRuntime = jest.fn<(s: string) => unknown>();
const mockIsInProcessRuntimeActive = jest.fn<(s: string) => boolean>();
jest.mock('../../services/agent/crewly-agent/in-process-runtime-registry.js', () => ({
	getInProcessRuntime: (...args: [string]) => mockGetInProcessRuntime(...args),
	isInProcessRuntimeActive: (...args: [string]) => mockIsInProcessRuntimeActive(...args),
}));

// Mock AdaptiveHeartbeatService defaults
jest.mock('../../services/agent/adaptive-heartbeat.service.js', () => ({
	ADAPTIVE_HEARTBEAT_DEFAULTS: {
		busyIntervalMs: 30000,
		idleIntervalMs: 120000,
		dormantIntervalMs: 600000,
	},
}));

// Mock fs
jest.mock('fs', () => ({
	existsSync: jest.fn().mockReturnValue(false),
}));
jest.mock('fs/promises', () => ({
	readFile: jest.fn<(p: string, e: string) => Promise<string>>().mockResolvedValue(''),
}));

describe('TerminalController', () => {
	let mockReq: Partial<Request>;
	let mockRes: Partial<Response>;
	let mockSession: any;
	let mockBackend: any;
	let getSessionBackendSync: jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();

		// Re-apply security mock implementations (resetAllMocks in afterEach clears them)
		const security = require('../../utils/security.js');
		(security.validateTerminalInput as jest.Mock).mockReturnValue({ isValid: true });
		(security.sanitizeTerminalInput as jest.Mock).mockImplementation((...args: unknown[]) => args[0]);
		(security.validateSessionName as jest.Mock).mockReturnValue({ isValid: true });

		// Re-apply InProcessLogBuffer mock implementations (cleared by resetAllMocks)
		mockInProcessLogBuffer.getSessionNames.mockReturnValue([]);
		mockInProcessLogBuffer.hasSession.mockReturnValue(false);
		mockInProcessLogBuffer.capture.mockReturnValue('');

		// Default: no in-process runtime registered (so the existing PTY-based
		// tests, incl. the plain 404 path, behave exactly as before).
		mockGetInProcessRuntime.mockReturnValue(undefined);
		mockIsInProcessRuntimeActive.mockReturnValue(false);

		// Create mock response with proper typing
		const jsonMock = jest.fn().mockReturnThis();
		const statusMock = jest.fn().mockReturnThis();
		mockRes = {
			json: jsonMock as any,
			status: statusMock as any,
		};

		// Create mock session
		mockSession = {
			name: 'test-session',
			write: jest.fn(),
		};

		// Create mock backend
		mockBackend = {
			listSessions: jest.fn(() => ['session1', 'session2']),
			sessionExists: jest.fn(() => true),
			getSession: jest.fn(() => mockSession),
			captureOutput: jest.fn(() => 'mock terminal output'),
			getRawHistory: jest.fn(() => 'raw history with colors'),
			killSession: jest.fn(),
		};

		// Set up the mocks
		getSessionBackendSync = require('../../services/session/index.js').getSessionBackendSync;
		(getSessionBackendSync as jest.Mock).mockReturnValue(mockBackend);

		// Set up async getSessionBackend mock (used by listTerminalSessions)
		const { getSessionBackend } = require('../../services/session/index.js');
		(getSessionBackend as jest.Mock<any>).mockResolvedValue(mockBackend);

		// Default: agent not found in teams (delivers normally)
		mockFindMemberBySessionName.mockResolvedValue(null);
	});

	afterEach(() => {
		jest.resetAllMocks();
	});

	describe('listTerminalSessions', () => {
		it('should return list of sessions', async () => {
			mockReq = {};

			await terminalController.listTerminalSessions(mockReq as Request, mockRes as Response);

			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				data: { sessions: ['session1', 'session2'], inProcessSessions: [] },
			});
		});

		it('should return empty array when no sessions exist', async () => {
			mockBackend.listSessions.mockReturnValue([]);
			mockReq = {};

			await terminalController.listTerminalSessions(mockReq as Request, mockRes as Response);

			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				data: { sessions: [], inProcessSessions: [] },
			});
		});

		it('should handle backend initialization error gracefully', async () => {
			const { getSessionBackend } = require('../../services/session/index.js');
			(getSessionBackend as jest.Mock<any>).mockRejectedValue(new Error('Not initialized'));
			mockReq = {};

			await terminalController.listTerminalSessions(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(500);
		});

		it('should handle errors gracefully', async () => {
			mockBackend.listSessions.mockImplementation(() => {
				throw new Error('Backend error');
			});
			mockReq = {};

			await terminalController.listTerminalSessions(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(500);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Failed to list terminal sessions',
			});
		});
	});

	describe('sessionExists', () => {
		it('should return true when session exists', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
			};

			await terminalController.sessionExists(mockReq as Request, mockRes as Response);

			expect(mockBackend.sessionExists).toHaveBeenCalledWith('test-session');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				data: { exists: true, sessionName: 'test-session' },
			});
		});

		it('should return false when session does not exist', async () => {
			mockBackend.sessionExists.mockReturnValue(false);
			mockReq = {
				params: { sessionName: 'nonexistent' } as any,
			};

			await terminalController.sessionExists(mockReq as Request, mockRes as Response);

			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				data: { exists: false, sessionName: 'nonexistent' },
			});
		});

		it('should return 400 when session name is missing', async () => {
			mockReq = {
				params: {} as any,
			};

			await terminalController.sessionExists(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Session name is required',
			});
		});

		it('should return 503 when backend not initialized', async () => {
			(getSessionBackendSync as jest.Mock).mockReturnValue(null);
			mockReq = {
				params: { sessionName: 'test-session' } as any,
			};

			await terminalController.sessionExists(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(503);
		});
	});

	describe('captureTerminal', () => {
		it('should return terminal output', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				query: { lines: '50' } as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 50);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				data: {
					output: 'mock terminal output',
					sessionName: 'test-session',
					lines: 50,
					truncated: false,
				},
			});
		});

		it('should return 404 when session does not exist', async () => {
			mockBackend.sessionExists.mockReturnValue(false);
			mockReq = {
				params: { sessionName: 'nonexistent' } as any,
				query: {} as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(404);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: "Session 'nonexistent' not found",
			});
		});

		it('should use default lines when not specified', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				query: {} as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 50);
		});

		it('should limit lines to max', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				query: { lines: '1000' } as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			expect(mockBackend.captureOutput).toHaveBeenCalledWith('test-session', 500);
		});

		it('should truncate large output', async () => {
			// MAX_OUTPUT_SIZE is 131072 (128KB), so we need output larger than that
			const largeOutput = 'x'.repeat(140000);
			mockBackend.captureOutput.mockReturnValue(largeOutput);
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				query: {} as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			const jsonMock = mockRes.json as jest.Mock;
			const callArg = jsonMock.mock.calls[0][0] as { data: { truncated: boolean; output: string } };
			expect(callArg.data.truncated).toBe(true);
			expect(callArg.data.output).toContain('...');
		});
	});

	describe('writeToSession', () => {
		it('should write data to session with carriage return in default mode', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'hello' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('hello\r');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data written successfully',
			});
		});

		it('should use two-step write in message mode', async () => {
			jest.useFakeTimers();
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'hello', mode: 'message' },
			};

			const promise = terminalController.writeToSession(mockReq as Request, mockRes as Response);

			// Advance through the delays (enterDelay + backup delay)
			await jest.advanceTimersByTimeAsync(6000);
			await promise;

			// Should write text in bracketed paste first, then \r twice (Enter + backup Enter)
			expect(mockSession.write).toHaveBeenCalledTimes(3);
			expect(mockSession.write).toHaveBeenNthCalledWith(1, '\x1b[200~hello\x1b[201~');
			expect(mockSession.write).toHaveBeenNthCalledWith(2, '\r');
			expect(mockSession.write).toHaveBeenNthCalledWith(3, '\r');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data written successfully',
			});

			jest.useRealTimers();
		});

		it('should return 400 when data is missing', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: {},
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Data is required',
			});
		});

		it('should return 404 when session does not exist', async () => {
			mockBackend.getSession.mockReturnValue(null);
			mockReq = {
				params: { sessionName: 'nonexistent' } as any,
				body: { data: 'hello' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(404);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: "Session 'nonexistent' not found",
			});
		});

		// Issue #693 follow-up bug (a): in-process Crewly Agent runtimes have no
		// PTY session, so the dispatch subscriber's POST /write 404-looped against
		// a live in-process orchestrator. writeToSession() now routes to the
		// in-process runtime's handleMessage() when there is no PTY session.
		it('should deliver to an active in-process runtime instead of 404 (no PTY session)', async () => {
			const handleMessage = jest.fn<(m: string) => Promise<unknown>>().mockResolvedValue({
				text: 'ok', steps: 1, toolCalls: [], usage: { input: 0, output: 0 },
			});
			mockBackend.getSession.mockReturnValue(null);
			mockGetInProcessRuntime.mockReturnValue({ handleMessage });
			mockIsInProcessRuntimeActive.mockReturnValue(true);
			mockReq = {
				params: { sessionName: 'crewly-orc' } as any,
				body: { data: 'hello-orc' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(handleMessage).toHaveBeenCalledWith('hello-orc');
			expect(mockRes.status).not.toHaveBeenCalledWith(404);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data delivered to in-process runtime',
			});
		});

		it('should still 404 when there is no PTY session AND no in-process runtime', async () => {
			mockBackend.getSession.mockReturnValue(null);
			mockGetInProcessRuntime.mockReturnValue(undefined);
			mockIsInProcessRuntimeActive.mockReturnValue(false);
			mockReq = {
				params: { sessionName: 'gone' } as any,
				body: { data: 'hello' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(404);
		});

		it('should 404 when an in-process runtime is registered but not ready', async () => {
			const handleMessage = jest.fn<(m: string) => Promise<unknown>>();
			mockBackend.getSession.mockReturnValue(null);
			mockGetInProcessRuntime.mockReturnValue({ handleMessage });
			mockIsInProcessRuntimeActive.mockReturnValue(false); // not ready
			mockReq = {
				params: { sessionName: 'crewly-orc' } as any,
				body: { data: 'hello' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(handleMessage).not.toHaveBeenCalled();
			expect(mockRes.status).toHaveBeenCalledWith(404);
		});

		it('should fire-and-forget in-process delivery — a handleMessage rejection is not surfaced', async () => {
			const handleMessage = jest.fn<(m: string) => Promise<unknown>>().mockRejectedValue(
				new Error('agent boom'),
			);
			mockBackend.getSession.mockReturnValue(null);
			mockGetInProcessRuntime.mockReturnValue({ handleMessage });
			mockIsInProcessRuntimeActive.mockReturnValue(true);
			mockReq = {
				params: { sessionName: 'crewly-orc' } as any,
				body: { data: 'hello' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			// Response is success immediately; the rejection is swallowed + logged
			// so the /write contract stays non-blocking.
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data delivered to in-process runtime',
			});
			expect(mockRes.status).not.toHaveBeenCalledWith(500);
		});

		it('should allow empty string data', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: '' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('\r');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data written successfully',
			});
		});

		it('should queue message when agent is not active in message mode', async () => {
			mockFindMemberBySessionName.mockResolvedValue({
				team: { id: 'team-1', name: 'Test Team' },
				member: { sessionName: 'test-session', agentStatus: 'starting' },
			});

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'task assignment', mode: 'message' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockEnqueue).toHaveBeenCalledWith('test-session', 'task assignment');
			expect(mockRes.status).toHaveBeenCalledWith(202);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				queued: true,
				message: 'Message queued until agent is ready',
			});
			// Should NOT write to the session
			expect(mockSession.write).not.toHaveBeenCalled();
		});

		it('should deliver message normally when agent is active in message mode', async () => {
			jest.useFakeTimers();
			mockFindMemberBySessionName.mockResolvedValue({
				team: { id: 'team-1', name: 'Test Team' },
				member: { sessionName: 'test-session', agentStatus: 'active' },
			});

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'task data', mode: 'message' },
			};

			const promise = terminalController.writeToSession(mockReq as Request, mockRes as Response);
			await jest.advanceTimersByTimeAsync(6000);
			await promise;

			expect(mockEnqueue).not.toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalledTimes(3);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Data written successfully',
			});
			jest.useRealTimers();
		});

		it('should skip queuing for orchestrator session', async () => {
			jest.useFakeTimers();
			mockReq = {
				params: { sessionName: 'crewly-orc' } as any,
				body: { data: 'orc message', mode: 'message' },
			};

			const promise = terminalController.writeToSession(mockReq as Request, mockRes as Response);
			await jest.advanceTimersByTimeAsync(6000);
			await promise;

			// Should not call findMemberBySessionName for orchestrator
			expect(mockFindMemberBySessionName).not.toHaveBeenCalled();
			expect(mockEnqueue).not.toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalled();
			jest.useRealTimers();
		});

		it('should deliver normally when agent lookup fails in message mode', async () => {
			jest.useFakeTimers();
			mockFindMemberBySessionName.mockRejectedValue(new Error('Storage error'));

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'task data', mode: 'message' },
			};

			const promise = terminalController.writeToSession(mockReq as Request, mockRes as Response);
			await jest.advanceTimersByTimeAsync(6000);
			await promise;

			expect(mockEnqueue).not.toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalled();
			jest.useRealTimers();
		});

		it('should deliver normally when agent not found in teams in message mode', async () => {
			jest.useFakeTimers();
			mockFindMemberBySessionName.mockResolvedValue(null);

			mockReq = {
				params: { sessionName: 'plain-shell' } as any,
				body: { data: 'shell data', mode: 'message' },
			};

			const promise = terminalController.writeToSession(mockReq as Request, mockRes as Response);
			await jest.advanceTimersByTimeAsync(6000);
			await promise;

			expect(mockEnqueue).not.toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalled();
			jest.useRealTimers();
		});

		it('should not check agent status for default mode writes', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { data: 'shell command' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			// Default mode should not trigger the agent status check
			expect(mockFindMemberBySessionName).not.toHaveBeenCalled();
			expect(mockSession.write).toHaveBeenCalledWith('shell command\r');
		});

		// ===================================================================
		// 4-piece skill-mistake fix — Piece #4: orc-namespace gate telemetry
		//
		// When an orc-role caller writes via the agent-side /terminal/{session}/write
		// path (instead of the orc-namespaced /terminal/{session}/deliver via
		// config/skills/orchestrator/send-message), emit a warn-log naming the
		// namespace mistake. Caller is identified via X-Agent-Session header
		// (set canonically by every agent skill via api_call() — see
		// config/skills/_common/lib.sh:103). Caller role is resolved via
		// StorageService.findMemberBySessionName.
		//
		// 3 cases covered:
		// 1. orc-role caller → warn-log fires (positive)
		// 2. worker-role caller → no log (negative — no false positive on legitimate use)
		// 3. unknown caller (registration race / ad-hoc curl) → no log (no false positive)
		// ===================================================================
		describe('orc-namespace gate telemetry (piece #4)', () => {
			it('emits warn-log when orc-role caller writes via agent-side path', async () => {
				mockFindMemberBySessionName.mockResolvedValue({
					team: { id: 'team-x', members: [] },
					member: { sessionName: 'crewly-orc', role: 'orchestrator', agentStatus: 'active' },
				});
				mockReq = {
					params: { sessionName: 'developer-session' } as any,
					headers: { 'x-agent-session': 'crewly-orc' } as any,
					body: { data: 'hello from orc' },
				};

				await terminalController.writeToSession(mockReq as Request, mockRes as Response);

				// Lookup must be called with the CALLER session (from header), not the target
				expect(mockFindMemberBySessionName).toHaveBeenCalledWith('crewly-orc');

				// warn-log must fire with the namespace-gate message
				expect(mockLoggerWarn).toHaveBeenCalledWith(
					expect.stringContaining('orc-namespace-gate'),
					expect.objectContaining({
						callerSession: 'crewly-orc',
						targetSession: 'developer-session',
						skillPath: 'config/skills/agent/core/send-message',
						canonicalAlternative: 'config/skills/orchestrator/send-message',
					}),
				);

				// The actual write must still proceed — telemetry does not block
				expect(mockSession.write).toHaveBeenCalledWith('hello from orc\r');
			});

			it('does NOT emit warn-log when worker-role caller writes via agent-side path', async () => {
				mockFindMemberBySessionName.mockResolvedValue({
					team: { id: 'team-x', members: [] },
					member: { sessionName: 'dev-1', role: 'developer', agentStatus: 'active' },
				});
				mockReq = {
					params: { sessionName: 'peer-dev-session' } as any,
					headers: { 'x-agent-session': 'dev-1' } as any,
					body: { data: 'peer message' },
				};

				await terminalController.writeToSession(mockReq as Request, mockRes as Response);

				// Lookup is called (we resolve every caller) but role check excludes non-orc
				expect(mockFindMemberBySessionName).toHaveBeenCalledWith('dev-1');

				// No warn-log for worker — agent-side path is the canonical channel for them
				const warnCalls = mockLoggerWarn.mock.calls.filter((args) =>
					typeof args[0] === 'string' && args[0].includes('orc-namespace-gate'),
				);
				expect(warnCalls).toHaveLength(0);

				// The actual write still succeeds
				expect(mockSession.write).toHaveBeenCalledWith('peer message\r');
			});

			it('does NOT emit warn-log when caller session is unknown (registration race / ad-hoc curl)', async () => {
				// findMemberBySessionName returns null when caller is not registered
				mockFindMemberBySessionName.mockResolvedValue(null);
				mockReq = {
					params: { sessionName: 'some-session' } as any,
					headers: { 'x-agent-session': 'unknown-caller' } as any,
					body: { data: 'orphan write' },
				};

				await terminalController.writeToSession(mockReq as Request, mockRes as Response);

				// Lookup is called but returns null → no role check possible → no log
				expect(mockFindMemberBySessionName).toHaveBeenCalledWith('unknown-caller');

				// No warn-log fires (avoids false positives during registration race)
				const warnCalls = mockLoggerWarn.mock.calls.filter((args) =>
					typeof args[0] === 'string' && args[0].includes('orc-namespace-gate'),
				);
				expect(warnCalls).toHaveLength(0);

				// Write still succeeds — telemetry is opt-in
				expect(mockSession.write).toHaveBeenCalledWith('orphan write\r');
			});

			it('does NOT emit warn-log nor look up caller when X-Agent-Session header is absent', async () => {
				mockReq = {
					params: { sessionName: 'some-session' } as any,
					headers: {} as any, // no X-Agent-Session
					body: { data: 'no-header write' },
				};

				await terminalController.writeToSession(mockReq as Request, mockRes as Response);

				// Without the header, we don't even try to look up the caller (saves a storage hit)
				expect(mockFindMemberBySessionName).not.toHaveBeenCalled();

				// And no warn-log fires
				const warnCalls = mockLoggerWarn.mock.calls.filter((args) =>
					typeof args[0] === 'string' && args[0].includes('orc-namespace-gate'),
				);
				expect(warnCalls).toHaveLength(0);

				// Write still succeeds
				expect(mockSession.write).toHaveBeenCalledWith('no-header write\r');
			});
		});
	});

	describe('sendTerminalInput', () => {
		it('should send input with carriage return', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { input: 'echo hello' },
			};

			await terminalController.sendTerminalInput(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('echo hello\r');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Input sent successfully',
			});
		});

		it('should return 400 when input is missing', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: {},
			};

			await terminalController.sendTerminalInput(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Input is required',
			});
		});

		it('should return 400 when input is empty string', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { input: '' },
			};

			await terminalController.sendTerminalInput(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
		});

		it('should handle complex commands with special characters', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { input: 'grep -r "test" . | head -10' },
			};

			await terminalController.sendTerminalInput(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('grep -r "test" . | head -10\r');
		});
	});

	describe('sendTerminalKey', () => {
		it('should send Enter key', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { key: 'Enter' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('\r');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Key sent successfully',
			});
		});

		it('should send Ctrl+C key', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { key: 'C-c' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('\x03');
		});

		it('should send Escape key', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { key: 'Escape' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('\x1b');
		});

		it('should send Tab key', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { key: 'Tab' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockSession.write).toHaveBeenCalledWith('\t');
		});

		it('should return 400 when key is missing', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: {},
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Key is required',
			});
		});

		it('should reject unknown keys with 400', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { key: 'custom-key' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockSession.write).not.toHaveBeenCalled();
		});
	});

	describe('killSession', () => {
		it('should kill session', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
			};

			await terminalController.killSession(mockReq as Request, mockRes as Response);

			expect(mockBackend.killSession).toHaveBeenCalledWith('test-session');
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				message: 'Session killed successfully',
			});
		});

		it('should return 404 when session does not exist', async () => {
			mockBackend.sessionExists.mockReturnValue(false);
			mockReq = {
				params: { sessionName: 'nonexistent' } as any,
			};

			await terminalController.killSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(404);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: "Session 'nonexistent' not found",
			});
		});

		it('should return 400 when session name is missing', async () => {
			mockReq = {
				params: {} as any,
			};

			await terminalController.killSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Session name is required',
			});
		});

		it('should return 503 when backend not initialized', async () => {
			(getSessionBackendSync as jest.Mock).mockReturnValue(null);
			mockReq = {
				params: { sessionName: 'test-session' } as any,
			};

			await terminalController.killSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(503);
		});

		it('should handle kill errors gracefully', async () => {
			mockBackend.killSession.mockRejectedValue(new Error('Kill failed'));
			mockReq = {
				params: { sessionName: 'test-session' } as any,
			};

			await terminalController.killSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(500);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Failed to kill session',
			});
		});
	});

	describe('deliverMessage', () => {
		let mockApiContext: any;

		beforeEach(() => {
			// Create a mock ApiContext with agentRegistrationService
			mockApiContext = {
				agentRegistrationService: {
					sendMessageToAgent: jest.fn<() => Promise<any>>().mockResolvedValue({
						success: true,
						message: 'Message sent to agent successfully',
					}),
					waitForAgentReady: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
					getInProcessRuntime: jest.fn<() => any>().mockReturnValue(undefined),
				},
			};
		});

		it('should deliver message successfully via reliable endpoint', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello agent' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-session',
				'Hello agent',
				undefined
			);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				verified: true,
			});
		});

		it('should return 400 when message is missing', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: {},
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Message is required and must be a string',
			});
		});

		it('should return 400 when session name is missing', async () => {
			mockReq = {
				params: {} as any,
				body: { message: 'Hello' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Session name is required',
			});
		});

		it('should return 502 when delivery fails', async () => {
			mockApiContext.agentRegistrationService.sendMessageToAgent.mockResolvedValue({
				success: false,
				error: 'Failed to deliver message after multiple attempts',
			});

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(502);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Failed to deliver message after multiple attempts',
			});
		});

		it('should wait for agent ready when waitForReady is true', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello', waitForReady: true, waitTimeout: 5000 },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockApiContext.agentRegistrationService.waitForAgentReady).toHaveBeenCalledWith(
				'test-session',
				5000,
				undefined
			);
			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).toHaveBeenCalled();
			expect(mockRes.json).toHaveBeenCalledWith({
				success: true,
				verified: true,
			});
		});

		it('should return 408 when agent not ready within timeout', async () => {
			mockApiContext.agentRegistrationService.waitForAgentReady.mockResolvedValue(false);

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello', waitForReady: true, waitTimeout: 5000 },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(408);
			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).not.toHaveBeenCalled();
		});

		it('should pass runtimeType from request body', async () => {
			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello', runtimeType: 'gemini-cli' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-session',
				'Hello',
				'gemini-cli'
			);
		});

		it('should look up runtimeType from storage when not provided', async () => {
			mockFindMemberBySessionName.mockResolvedValue({
				team: { id: 'team-1', name: 'Test Team' },
				member: { sessionName: 'test-session', runtimeType: 'claude-code' },
			});

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'test-session',
				'Hello',
				'claude-code'
			);
		});

		it('should resolve runtimeType from in-process runtime when storage lookup returns nothing', async () => {
			mockFindMemberBySessionName.mockResolvedValue(null);
			mockApiContext.agentRegistrationService.getInProcessRuntime.mockReturnValue({ isReady: () => true });

			mockReq = {
				params: { sessionName: 'crewly-agent-session' } as any,
				body: { message: 'Hello crewly agent' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockApiContext.agentRegistrationService.getInProcessRuntime).toHaveBeenCalledWith('crewly-agent-session');
			expect(mockApiContext.agentRegistrationService.sendMessageToAgent).toHaveBeenCalledWith(
				'crewly-agent-session',
				'Hello crewly agent',
				'crewly-agent'
			);
		});

		it('should handle errors gracefully', async () => {
			mockApiContext.agentRegistrationService.sendMessageToAgent.mockRejectedValue(new Error('Service error'));

			mockReq = {
				params: { sessionName: 'test-session' } as any,
				body: { message: 'Hello' },
			};

			await terminalController.deliverMessage.call(mockApiContext, mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(500);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Failed to deliver message',
			});
		});
	});

	describe('Parameter validation', () => {
		it('should validate session name for capture', async () => {
			mockReq = {
				params: {} as any,
				query: {} as any,
			};

			await terminalController.captureTerminal(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith({
				success: false,
				error: 'Session name is required',
			});
		});

		it('should validate session name for write', async () => {
			mockReq = {
				params: {} as any,
				body: { data: 'test' },
			};

			await terminalController.writeToSession(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
		});

		it('should validate session name for input', async () => {
			mockReq = {
				params: {} as any,
				body: { input: 'test' },
			};

			await terminalController.sendTerminalInput(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
		});

		it('should validate session name for key', async () => {
			mockReq = {
				params: {} as any,
				body: { key: 'Enter' },
			};

			await terminalController.sendTerminalKey(mockReq as Request, mockRes as Response);

			expect(mockRes.status).toHaveBeenCalledWith(400);
		});
	});
});
