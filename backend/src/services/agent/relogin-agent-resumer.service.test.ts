/**
 * Tests for the agent resumer used after a harness re-login.
 */

import { ReloginAgentResumerService, type ReloginAgentResumerDeps } from './relogin-agent-resumer.service.js';
import type { PersistedSessionInfo } from '../session/session-state-persistence.js';
import { recordStartupBlock, resetStartupBlocksForTesting, startupBlockOf } from './startup-block.registry.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

/**
 * Persisted metadata for a session.
 *
 * @param name - Session name
 * @param runtimeType - Runtime
 * @param extra - Other fields
 * @returns Metadata
 */
function meta(name: string, runtimeType: string, extra: Partial<PersistedSessionInfo> = {}): PersistedSessionInfo {
	return { name, cwd: '/p', command: 'x', args: [], runtimeType: runtimeType as PersistedSessionInfo['runtimeType'], ...extra };
}

/** Fakes around one resumer. */
function setup(overrides: Partial<ReloginAgentResumerDeps> = {}) {
	const registered = new Map<string, PersistedSessionInfo>([
		['dev-1', meta('dev-1', 'claude-code', { role: 'developer', teamId: 't1', memberId: 'm1' })],
		['crewly-orc', meta('crewly-orc', 'claude-code', { role: 'orchestrator' })],
		['qa-1', meta('qa-1', 'codex-cli', { role: 'qa', teamId: 't1', memberId: 'm2' })],
		['gone', meta('gone', 'claude-code', { role: 'developer' })],
		['no-role', meta('no-role', 'claude-code')],
	]);
	const calls: string[] = [];
	const sessionIds = new Map([['dev-1', 'conv-123']]);
	const backend = {
		listSessions: jest.fn(() => ['dev-1', 'qa-1', 'crewly-orc', 'unregistered', 'no-role']),
		sessionExists: jest.fn((name: string) => name !== 'gone'),
		killSession: jest.fn(async (name: string) => {
			calls.push(`kill:${name}`);
		}),
	};
	const persistence = {
		getRegisteredSessionsMap: () => registered,
		getSessionMetadata: (name: string) => registered.get(name),
		getSessionId: (name: string) => sessionIds.get(name),
		updateSessionId: jest.fn((name: string, id: string) => {
			calls.push(`id:${name}:${id}`);
		}),
	};
	const registration = {
		createAgentSession: jest.fn(async (config: { sessionName: string }) => {
			calls.push(`create:${config.sessionName}`);
			return { success: true };
		}),
	};
	const deps: ReloginAgentResumerDeps = {
		getBackend: () => backend,
		getPersistence: () => persistence,
		getAgentRegistration: () => registration as unknown as ReturnType<ReloginAgentResumerDeps['getAgentRegistration']>,
		restartOrchestrator: jest.fn(async () => {
			calls.push('orc');
			return true;
		}),
		stopExitMonitoring: jest.fn((name: string) => {
			calls.push(`stop:${name}`);
		}),
		clearActivity: jest.fn(),
		...overrides,
	};
	return { resumer: new ReloginAgentResumerService(deps), backend, persistence, registration, calls, deps };
}

describe('ReloginAgentResumerService.listSessions', () => {
	it('returns live sessions of the harness, orchestrator first', () => {
		const { resumer } = setup();
		expect(resumer.listSessions('claude-code')).toEqual(['crewly-orc', 'dev-1', 'no-role']);
		expect(resumer.listSessions('codex-cli')).toEqual(['qa-1']);
		expect(resumer.listSessions('gemini-cli')).toEqual([]);
	});

	it('returns nothing without a session backend or when listing fails', () => {
		expect(setup({ getBackend: () => null }).resumer.listSessions('claude-code')).toEqual([]);
		const failing = setup();
		failing.backend.listSessions.mockImplementation(() => {
			throw new Error('down');
		});
		expect(failing.resumer.listSessions('claude-code')).toEqual([]);
	});
});

describe('ReloginAgentResumerService.resume', () => {
	it('stops exit monitoring, kills, keeps the conversation id and recreates each agent', async () => {
		const { resumer, registration, calls } = setup();
		expect(await resumer.resume(['dev-1'])).toEqual({ resumed: ['dev-1'], failed: [] });
		expect(calls).toEqual(['stop:dev-1', 'kill:dev-1', 'id:dev-1:conv-123', 'create:dev-1']);
		expect(registration.createAgentSession).toHaveBeenCalledWith({ sessionName: 'dev-1', role: 'developer', teamId: 't1', memberId: 'm1', automatic: true });
	});

	describe('start-up blocked on the user', () => {
		afterEach(() => resetStartupBlocksForTesting());

		it('an automatic restart leaves a blocked agent and a blocked orchestrator alone (no kill, no start)', async () => {
			const { resumer, deps, backend, registration } = setup();
			recordStartupBlock('dev-1', 'consent_required', 'Accept Bypass Permissions mode.');
			recordStartupBlock('crewly-orc', 'consent_required', 'Accept Bypass Permissions mode.');
			expect(await resumer.resume(['crewly-orc', 'dev-1', 'qa-1'])).toEqual({ resumed: ['qa-1'], failed: ['crewly-orc', 'dev-1'] });
			expect(deps.restartOrchestrator).not.toHaveBeenCalled();
			expect(backend.killSession).toHaveBeenCalledTimes(1);
			expect(registration.createAgentSession).toHaveBeenCalledTimes(1);
			expect(startupBlockOf('dev-1')).not.toBeNull();
		});

		it('an owner-approved restart (re-login, consent) clears the block first and starts both', async () => {
			const beforeOwnerApprovedRestart = jest.fn();
			const { resumer, deps, registration } = setup({ ownerApproved: true, beforeOwnerApprovedRestart });
			recordStartupBlock('dev-1', 'consent_required', 'Accept Bypass Permissions mode.');
			recordStartupBlock('crewly-orc', 'consent_required', 'Accept Bypass Permissions mode.');
			(deps.restartOrchestrator as jest.Mock).mockImplementation(async () => startupBlockOf('crewly-orc') === null);
			expect(await resumer.resume(['crewly-orc', 'dev-1'])).toEqual({ resumed: ['crewly-orc', 'dev-1'], failed: [] });
			expect(beforeOwnerApprovedRestart).toHaveBeenCalledWith('crewly-orc');
			expect(startupBlockOf('dev-1')).toBeNull();
			expect(registration.createAgentSession).toHaveBeenCalledWith({ sessionName: 'dev-1', role: 'developer', teamId: 't1', memberId: 'm1', automatic: false });
		});
	});

	it('restarts the orchestrator through its restart service', async () => {
		const { resumer, deps, registration } = setup();
		expect(await resumer.resume(['crewly-orc', 'qa-1'])).toEqual({ resumed: ['crewly-orc', 'qa-1'], failed: [] });
		expect(deps.restartOrchestrator).toHaveBeenCalledTimes(1);
		expect(registration.createAgentSession).toHaveBeenCalledTimes(1);
	});

	it('recreates a session that already exited, without killing it', async () => {
		const { resumer, backend } = setup();
		expect((await resumer.resume(['gone'])).resumed).toEqual(['gone']);
		expect(backend.killSession).not.toHaveBeenCalled();
	});

	it('reports failures: no metadata/role, failed create, a throwing restart, a refused orc restart', async () => {
		const { resumer, registration, deps } = setup();
		registration.createAgentSession.mockResolvedValueOnce({ success: false, error: 'boom' } as never);
		(deps.restartOrchestrator as jest.Mock).mockResolvedValueOnce(false);
		const result = await resumer.resume(['dev-1', 'unregistered', 'no-role', 'crewly-orc']);
		expect(result).toEqual({ resumed: [], failed: ['dev-1', 'unregistered', 'no-role', 'crewly-orc'] });

		(deps.restartOrchestrator as jest.Mock).mockRejectedValueOnce(new Error('cooldown'));
		expect(await resumer.resume(['crewly-orc'])).toEqual({ resumed: [], failed: ['crewly-orc'] });
	});

	it('restarts each session once even if listed twice', async () => {
		const { resumer, registration } = setup();
		await resumer.resume(['dev-1', 'dev-1']);
		expect(registration.createAgentSession).toHaveBeenCalledTimes(1);
	});
});
