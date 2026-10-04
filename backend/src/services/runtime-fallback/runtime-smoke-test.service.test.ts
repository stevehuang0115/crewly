/**
 * Tests for the runtime smoke test orchestration (REST API mocked).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalSmokeApi, RuntimeSmokeTestService, buildSmokeTask, showsAntigravityTerms, type SmokeApi } from './runtime-smoke-test.service.js';

/** A scripted API whose agent behaves as configured. */
function fakeApi(behaviour: {
	startError?: string;
	readyAfterPolls?: number;
	screen?: () => string;
	onDeliver?: (message: string) => void;
	leftoverTeam?: boolean;
	log?: string;
	sessionLeft?: boolean;
}): SmokeApi & { calls: string[] } {
	const calls: string[] = [];
	let polls = 0;
	return {
		calls,
		listTeams: async () => (behaviour.leftoverTeam ? [{ id: 'old-team', name: 'zz-runtime-smoke-crewly-agent' }] : []),
		listProjects: async () => [],
		createProject: async (name) => {
			calls.push(`createProject ${name}`);
			return 'p1';
		},
		deleteProject: async (id) => void calls.push(`deleteProject ${id}`),
		createTeam: async (body) => {
			const m = (body.members as Array<{ runtimeType: string; modelId?: string }>)[0];
			calls.push(`createTeam ${String(body.name)} ${m.runtimeType}${m.modelId ? ` ${m.modelId}` : ''}`);
			return { id: 't1', memberId: 'm1' };
		},
		startMember: async () => {
			calls.push('startMember');
			return behaviour.startError ? { ok: false, error: behaviour.startError } : { ok: true };
		},
		getMember: async () => {
			polls += 1;
			return { agentStatus: polls > (behaviour.readyAfterPolls ?? 1) ? 'active' : 'starting', sessionName: 'zz-smoke-1' };
		},
		capture: async () => behaviour.screen?.() ?? '',
		sessionLog: async () => behaviour.log ?? '',
		sessionExists: async () => behaviour.sessionLeft ?? false,
		killSession: async (name) => void calls.push(`killSession ${name}`),
		deliver: async (_s, message) => {
			calls.push('deliver');
			behaviour.onDeliver?.(message);
			return { ok: true };
		},
		stopTeam: async (id) => void calls.push(`stopTeam ${id}`),
		deleteTeam: async (id) => void calls.push(`deleteTeam ${id}`),
	};
}

describe('RuntimeSmokeTestService', () => {
	let root: string;
	let clock: number;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
		clock = 0;
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function make(api: SmokeApi, onTermsScreen?: (runtime: string, report: { ownerInitiated: boolean; screen?: string }) => void): RuntimeSmokeTestService {
		return new RuntimeSmokeTestService({
			api,
			...(onTermsScreen ? { onTermsScreen } : {}),
			workRoot: root,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			nonce: () => 'abc123',
			timeoutMs: 60_000,
			pollMs: 1_000,
		});
	}

	it('passes when the agent runs bash and replies with the token, then cleans up', async () => {
		let reply = '';
		const api = fakeApi({
			onDeliver: (message) => {
				const file = /echo ok > (\S+)/.exec(message)?.[1] as string;
				fs.writeFileSync(file, 'ok\n');
				reply = '⏺ Bash(bash report-status --summary "SMOKE-ok-abc123")';
			},
			screen: () => reply,
		});
		const result = await make(api).run('crewly-agent');
		expect(result).toMatchObject({ runtime: 'crewly-agent', passed: true });
		expect(result.steps.map((s) => [s.step, s.ok])).toEqual([
			['create_team', true],
			['start_member', true],
			['agent_ready', true],
			['send_task', true],
			['bash', true],
			['reply', true],
			['cleanup', true],
		]);
		expect(api.calls).toEqual([
			'createProject zz-runtime-smoke-crewly-agent',
			'createTeam zz-runtime-smoke-crewly-agent crewly-agent deepseek/deepseek-chat',
			'startMember',
			'deliver',
			'stopTeam t1',
			'deleteTeam t1',
			'deleteProject p1',
		]);
	});

	it('does not count an echo of the task as the reply', async () => {
		let screen = '';
		const api = fakeApi({
			onDeliver: (message) => {
				const file = /echo ok > (\S+)/.exec(message)?.[1] as string;
				fs.writeFileSync(file, 'ok');
				screen = message; // the task echoed on screen, no reply
			},
			screen: () => screen,
		});
		const result = await make(api).run('antigravity-cli');
		expect(result).toMatchObject({ passed: false, failedStep: 'reply', error: 'No reply with the token SMOKE-ok-abc123' });
		expect(result.screen).toContain('Crewly runtime smoke test');
		expect(result.steps.at(-1)).toMatchObject({ step: 'cleanup', ok: true });
	});

	it('fails at bash when the proof file never appears', async () => {
		const api = fakeApi({ screen: () => 'SMOKE-ok-abc123' });
		const result = await make(api).run('codex-cli');
		expect(result).toMatchObject({ passed: false, failedStep: 'bash' });
	});

	it('fails on the Antigravity Terms screen without accepting it, and captures the screen', async () => {
		const terms = 'Welcome to Antigravity CLI!\nTerms of Service & Data Use\n> Accept';
		const api = fakeApi({ readyAfterPolls: 99, screen: () => terms });
		const result = await make(api).run('antigravity-cli');
		expect(result).toMatchObject({ passed: false, failedStep: 'agent_ready', error: 'Antigravity needs its terms accepted once' });
		expect(result.screen).toContain('Terms of Service & Data Use');
		expect(api.calls).not.toContain('deliver');
		expect(api.calls).toContain('deleteTeam t1');
	});

	it('reports the Terms screen so the owner gets a consent card (owner-initiated when they pressed Test)', async () => {
		const terms = 'Welcome to Antigravity CLI!\nTerms of Service & Data Use\n> Accept';
		const reports: Array<{ runtime: string; ownerInitiated: boolean }> = [];
		const service = make(fakeApi({ readyAfterPolls: 99, screen: () => terms }), (runtime, r) => reports.push({ runtime, ownerInitiated: r.ownerInitiated }));
		await service.start('antigravity-cli', { ownerInitiated: true }).done;
		expect(reports).toEqual([{ runtime: 'antigravity-cli', ownerInitiated: true }]);
		await service.start('antigravity-cli').done;
		expect(reports[1]).toEqual({ runtime: 'antigravity-cli', ownerInitiated: false });
		// Other failures are not Terms screens.
		await make(fakeApi({ startError: 'No DeepSeek key' }), (runtime, r) => reports.push({ runtime, ownerInitiated: r.ownerInitiated })).start('crewly-agent').done;
		expect(reports).toHaveLength(2);
	});

	it('reads the session log for the screen when a refused start already removed the session', async () => {
		const api = fakeApi({
			startError: 'Antigravity CLI has not been set up on this machine yet: it shows its first-run screens',
			log: '\x1b[1mWelcome to Antigravity CLI!\x1b[0m\nChoose your color scheme:\nGEMINI_API_KEY=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
		});
		const result = await make(api).run('antigravity-cli');
		expect(result).toMatchObject({ failedStep: 'start_member', error: 'Antigravity needs its terms accepted once' });
		expect(result.screen).toContain('Welcome to Antigravity CLI!');
		expect(result.screen).not.toContain('AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456');
	});

	it('kills a session a refused start left behind', async () => {
		const api = fakeApi({ startError: 'first-run screens', sessionLeft: true });
		await make(api).run('antigravity-cli');
		expect(api.calls).toContain('killSession zz-smoke-1');
	});

	it('maps a start refused for the first-run screens to the Terms failure', async () => {
		const api = fakeApi({ startError: "Antigravity CLI has not been set up on this machine yet: it shows its first-run screens (colour scheme, Google's Terms of Service and data use)" });
		const result = await make(api).run('antigravity-cli');
		expect(result).toMatchObject({ failedStep: 'start_member', error: 'Antigravity needs its terms accepted once' });
	});

	it('reports a start error and an agent that never registers', async () => {
		expect(await make(fakeApi({ startError: 'No DeepSeek key' })).run('crewly-agent')).toMatchObject({ failedStep: 'start_member', error: 'No DeepSeek key' });
		expect(await make(fakeApi({ readyAfterPolls: 10_000 })).run('crewly-agent')).toMatchObject({
			failedStep: 'agent_ready',
			error: 'The agent did not register in time',
		});
	});

	it('removes a leftover team first', async () => {
		const api = fakeApi({ leftoverTeam: true });
		await make(api).run('crewly-agent');
		expect(api.calls.slice(0, 2)).toEqual(['stopTeam old-team', 'deleteTeam old-team']);
	});

	it('runs one job per runtime and keeps its result', async () => {
		const service = make(fakeApi({ startError: 'nope' }));
		const a = service.start('crewly-agent');
		const b = service.start('crewly-agent');
		expect(b.job.jobId).toBe(a.job.jobId);
		await a.done;
		expect(service.get(a.job.jobId)).toMatchObject({ state: 'done', result: { passed: false } });
		expect(() => service.start('nope')).toThrow('Unknown runtime');
	});
});

describe('helpers', () => {
	it('the task never contains the reply token verbatim', () => {
		const task = buildSmokeTask('/tmp/x.txt', 'abc123');
		expect(task).toContain('echo ok > /tmp/x.txt');
		expect(task).toContain('abc123');
		expect(task).not.toContain('SMOKE-ok-abc123');
	});

	it('recognises the Antigravity first-run screens, also when wrapped', () => {
		expect(showsAntigravityTerms('Terms of Service &\nData Use')).toBe(true);
		expect(showsAntigravityTerms('? for shortcuts')).toBe(false);
	});
});

describe('LocalSmokeApi — terminal calls carry the owner API token (#1024)', () => {
	const origFetch = globalThis.fetch;
	let calls: Array<{ url: string; init: RequestInit }>;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return { ok: true, status: 200, json: async () => ({ success: true, data: { exists: false } }) };
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it('sends X-Crewly-Token on deliver, kill and exists (the backend\'s own process is the owner)', async () => {
		const api = new LocalSmokeApi(() => 'http://127.0.0.1:8787', () => 'owner-token');
		await api.deliver('smoke-s', 'hi');
		await api.killSession('smoke-s');
		await api.sessionExists('smoke-s');
		expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
			'POST http://127.0.0.1:8787/api/terminal/smoke-s/deliver',
			'DELETE http://127.0.0.1:8787/api/terminal/smoke-s',
			'GET http://127.0.0.1:8787/api/terminal/smoke-s/exists',
		]);
		for (const c of calls) expect((c.init.headers as Record<string, string>)['x-crewly-token']).toBe('owner-token');
	});
});
