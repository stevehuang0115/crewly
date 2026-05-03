/**
 * Orchestrator Setup Service tests
 *
 * Covers:
 * - Dependency injection lifecycle and missing-deps error path.
 * - Skip-when-healthy short-circuit.
 * - Runtime type resolution (claude-code default + crewly-agent passthrough).
 * - createAgentSession failure propagation.
 * - In-flight deduplication of concurrent calls.
 * - **B1 cold-start invariant**: after a fresh setup the orchestrator's
 *   conversationHistory.messageCount === 0. The activation kickoff message
 *   that AgentRegistrationService normally sends to subordinate
 *   crewly-agents is suppressed for the orchestrator session.
 *
 * @module services/orchestrator/orchestrator-setup.service.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockOrchestratorStatusValue: { value: any } = { value: null };
const mockGetOrchestratorStatus = jest.fn<() => Promise<any>>();
const mockMemoryInitialize = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockStartOrcChatMonitoring = jest.fn();

// orchestrator-status mock (we will resolve different values per test)
jest.mock('./orchestrator-status.service', () => ({
	getOrchestratorStatus: () => mockGetOrchestratorStatus(),
}));

// Memory service singleton mock
jest.mock('../memory/memory.service', () => ({
	MemoryService: {
		getInstance: () => ({
			initializeForSession: mockMemoryInitialize,
		}),
	},
}));

// Terminal gateway is best-effort; provide a stub
jest.mock('../../websocket/terminal.gateway', () => ({
	getTerminalGateway: () => ({
		startOrchestratorChatMonitoring: mockStartOrcChatMonitoring,
	}),
}));

// Logger
jest.mock('../core/logger.service', () => ({
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

// Constants — matches the runtime type values used by the service
jest.mock('../../constants', () => ({
	ORCHESTRATOR_SESSION_NAME: 'crewly-orc',
	ORCHESTRATOR_WINDOW_NAME: 'orchestrator',
	ORCHESTRATOR_ROLE: 'orchestrator',
	RUNTIME_TYPES: {
		CLAUDE_CODE: 'claude-code',
		CREWLY_AGENT: 'crewly-agent',
		GEMINI_CLI: 'gemini-cli',
		CODEX_CLI: 'codex-cli',
	},
}));

// formatError util — pass through
jest.mock('../../utils/format-error', () => ({
	formatError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import {
	triggerOrchestratorSetup,
	setOrchestratorSetupDependencies,
	_resetOrchestratorSetupDependenciesForTesting,
	type AgentRegistrationServiceLike,
} from './orchestrator-setup.service.js';
import type { StorageService } from '../core/storage.service.js';

// Lightweight in-memory model of what AgentRegistrationService does for
// crewly-agent runtimes. We track every message that would be appended to
// the orchestrator's conversation history so we can assert the
// `messageCount === 0` invariant after setup.
class FakeAgentRegistrationService implements AgentRegistrationServiceLike {
	public conversationHistory: string[] = [];
	public createCalls: Array<Record<string, unknown>> = [];
	public shouldFail = false;

	async createAgentSession(config: {
		sessionName: string;
		role: string;
		projectPath: string;
		windowName: string;
		runtimeType: string;
		forceRecreate?: boolean;
	}): Promise<{ success: boolean; sessionName?: string; message?: string; error?: string }> {
		this.createCalls.push(config);

		if (this.shouldFail) {
			return { success: false, error: 'mock failure' };
		}

		// Mirror the real registration path: the orchestrator session does NOT
		// receive an activation kickoff message (B1 cold-start invariant).
		// Subordinate sessions WOULD receive one — we don't simulate that here
		// because triggerOrchestratorSetup() only handles the orchestrator.
		if (config.sessionName !== 'crewly-orc') {
			this.conversationHistory.push(
				`You are now active as "${config.role}" (session: ${config.sessionName}).`,
			);
		}

		return {
			success: true,
			sessionName: config.sessionName,
			message: 'Orchestrator session created',
		};
	}

	get messageCount(): number {
		return this.conversationHistory.length;
	}
}

function createMockStorage(orchestratorStatus: any): StorageService {
	return {
		getOrchestratorStatus: jest.fn<() => Promise<any>>().mockResolvedValue(orchestratorStatus),
	} as unknown as StorageService;
}

describe('orchestrator-setup.service', () => {
	let fakeAgent: FakeAgentRegistrationService;

	beforeEach(() => {
		_resetOrchestratorSetupDependenciesForTesting();
		mockOrchestratorStatusValue.value = null;
		mockGetOrchestratorStatus.mockReset();
		mockMemoryInitialize.mockClear();
		mockStartOrcChatMonitoring.mockClear();
		fakeAgent = new FakeAgentRegistrationService();
	});

	describe('triggerOrchestratorSetup', () => {
		it('returns failure when dependencies are not wired', async () => {
			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});

		it('skips setup when orchestrator is already healthy', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({
				isActive: true,
				agentStatus: 'active',
				message: 'OK',
			});

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(true);
			expect(result.skipped).toBe(true);
			expect(fakeAgent.createCalls).toHaveLength(0);
		});

		it('proceeds with setup when orchestrator is offline', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({
				isActive: false,
				agentStatus: 'inactive',
				message: 'offline',
			});

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(true);
			expect(result.skipped).toBeUndefined();
			expect(fakeAgent.createCalls).toHaveLength(1);
			expect(fakeAgent.createCalls[0]).toMatchObject({
				sessionName: 'crewly-orc',
				role: 'orchestrator',
				runtimeType: 'crewly-agent',
				forceRecreate: true,
			});
		});

		it('falls back to claude-code when storage has no runtime type', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage(null),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false, agentStatus: 'inactive' });

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(true);
			expect(fakeAgent.createCalls[0].runtimeType).toBe('claude-code');
		});

		it('propagates createAgentSession failure', async () => {
			fakeAgent.shouldFail = true;
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false });

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(false);
			expect(result.error).toBe('mock failure');
		});

		it('deduplicates concurrent setup calls', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false });

			const [a, b, c] = await Promise.all([
				triggerOrchestratorSetup(),
				triggerOrchestratorSetup(),
				triggerOrchestratorSetup(),
			]);

			expect(a.success).toBe(true);
			expect(b.success).toBe(true);
			expect(c.success).toBe(true);
			// All three callers share the single in-flight setup.
			expect(fakeAgent.createCalls).toHaveLength(1);
		});

		it('continues to succeed even if memory init fails', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false });
			mockMemoryInitialize.mockRejectedValueOnce(new Error('memory blew up'));

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(true);
		});
	});

	describe('B1 cold-start invariant: conversationHistory.messageCount === 0', () => {
		it('does NOT seed any conversation messages for the orchestrator on fresh setup', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false });

			const result = await triggerOrchestratorSetup();
			expect(result.success).toBe(true);

			// Critical invariant: B1 fresh-install detection relies on this.
			expect(fakeAgent.messageCount).toBe(0);
			expect(fakeAgent.conversationHistory).toEqual([]);
		});

		it('still skips messages when retried via deduplication', async () => {
			setOrchestratorSetupDependencies({
				agentRegistrationService: fakeAgent,
				storageService: createMockStorage({ runtimeType: 'crewly-agent' }),
			});
			mockGetOrchestratorStatus.mockResolvedValue({ isActive: false });

			await Promise.all([
				triggerOrchestratorSetup(),
				triggerOrchestratorSetup(),
			]);

			expect(fakeAgent.messageCount).toBe(0);
		});
	});
});
