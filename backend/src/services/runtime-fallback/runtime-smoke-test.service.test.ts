/**
 * Tests for the runtime smoke test orchestration (REST API mocked).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RuntimeSmokeTestService, buildSmokeTask, showsAntigravityTerms, type SmokeApi } from './runtime-smoke-test.service.js';

/** A scripted API whose agent behaves as configured. */
function fakeApi(behaviour: {
	startError?: string;
	readyAfterPolls?: number;
	screen?: () => string;
	onDeliver?: (message: string) => void;
	leftoverTeam?: boolean;
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
			calls.push(`createTeam ${String(body.name)} ${String((body.members as Array<{ runtimeType: string }>)[0].runtimeType)}`);
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

	function make(api: SmokeApi): RuntimeSmokeTestService {
		return new RuntimeSmokeTestService({
			api,
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
			'createTeam zz-runtime-smoke-crewly-agent crewly-agent',
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
