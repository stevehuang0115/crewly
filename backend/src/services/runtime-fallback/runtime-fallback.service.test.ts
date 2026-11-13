/**
 * Tests for the runtime fallback coordinator: switch + handover +
 * re-delivery, the account-wide switch on next work, switch-back at the idle
 * boundary, and owner notices sent once.
 */

import { MemoryRuntimeFallbackStore } from './runtime-fallback.store.js';
import { RuntimeFallbackService, type FallbackAgentInfo, type ProbeResult, type RuntimeFallbackDeps } from './runtime-fallback.service.js';
import type { RuntimeAvailability } from './runtime-fallback.types.js';
import { computeRuntimeAvailability } from './runtime-availability.js';

const CLAUDE_LIMIT = "  ⎿  You've hit your limit · resets 3pm (UTC)\r\n";
const T0 = Date.UTC(2026, 9, 1, 12, 0);

/** Let fire-and-forget promises run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

interface Harness {
	service: RuntimeFallbackService;
	deps: RuntimeFallbackDeps;
	clock: { now: number };
	busy: Set<string>;
	live: Set<string>;
	conversations: Map<string, string>;
	relaunched: string[];
	redelivered: string[];
	flushed: string[];
	handovers: Array<{ sessionName: string; from: string; to: string; direction: string }>;
	dms: string[];
	probe: jest.Mock<Promise<ProbeResult>, [string]>;
	store: MemoryRuntimeFallbackStore;
}

const AGENTS: Record<string, FallbackAgentInfo> = {
	'dev-1': { sessionName: 'dev-1', name: 'Ella', primary: 'claude-code', memberId: 'm1', teamId: 't1', isOrchestrator: false },
	'dev-2': { sessionName: 'dev-2', name: 'Rex', primary: 'claude-code', memberId: 'm2', teamId: 't1', isOrchestrator: false },
	'dev-3': { sessionName: 'dev-3', name: 'Sam', primary: 'claude-code', memberId: 'm3', teamId: 't1', isOrchestrator: false },
	'nova-1': { sessionName: 'nova-1', name: 'Nova', primary: 'codex-cli', memberId: 'm4', teamId: 't1', isOrchestrator: false },
	'crewly-orc': { sessionName: 'crewly-orc', name: 'Orc', primary: 'claude-code', isOrchestrator: true },
};

function make(opts: { availability?: RuntimeAvailability[]; initial?: unknown; probe?: ProbeResult } = {}): Harness {
	const clock = { now: T0 };
	const busy = new Set<string>();
	const live = new Set<string>(Object.keys(AGENTS));
	const conversations = new Map<string, string>([
		['dev-1', 'claude-convo-1'],
		['dev-2', 'claude-convo-2'],
	]);
	const relaunched: string[] = [];
	const redelivered: string[] = [];
	const flushed: string[] = [];
	const handovers: Harness['handovers'] = [];
	const dms: string[] = [];
	const store = new MemoryRuntimeFallbackStore(opts.initial);
	const probe = jest.fn(async (_runtime: string): Promise<ProbeResult> => opts.probe ?? 'limited');
	const availability: RuntimeAvailability[] = opts.availability ?? [
		{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
		{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: true },
		{ runtime: 'antigravity-cli', label: 'Antigravity', selectable: true },
		{ runtime: 'codex-cli', label: 'Codex', selectable: true },
	];
	const deps: RuntimeFallbackDeps = {
		store,
		getAgent: async (s) => AGENTS[s] ?? null,
		countAgentsOnRuntime: async (r) => Object.values(AGENTS).filter((a) => a.primary === r).length,
		isLive: (s) => live.has(s),
		isBusy: async (s) => busy.has(s),
		getAvailability: async () => availability,
		probe,
		writeHandover: async (req) => {
			handovers.push({ sessionName: req.sessionName, from: req.from, to: req.to, direction: req.direction });
			return `/home/.crewly/handover/${req.sessionName}-${req.direction}.md`;
		},
		getActiveWorkItem: async (s) => (s === 'dev-1' ? { id: 'wi-42', title: 'Fix the login page' } : null),
		conversation: {
			get: (s) => conversations.get(s),
			set: (s, id) => void conversations.set(s, id),
			clear: (s) => void conversations.delete(s),
		},
		relaunch: async (a) => {
			relaunched.push(a.sessionName);
			return true;
		},
		redeliver: async (s) => void redelivered.push(s),
		flushQueued: async (s) => void flushed.push(s),
		machineName: () => 'iriss-air',
		notifier: () => ({ sendToOwner: async (text: string) => (dms.push(text), true) }),
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
		timeZone: 'UTC',
	};
	const service = new RuntimeFallbackService(deps);
	return { service, deps, clock, busy, live, conversations, relaunched, redelivered, flushed, handovers, dms, probe, store };
}

describe('RuntimeFallbackService — switch on a usage limit', () => {
	it('switches the agent to the next runtime with a handover, keeps the primary, and re-delivers', async () => {
		const h = make();
		expect(h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output')).toBe(true);
		await settle();

		expect(h.probe).toHaveBeenCalledWith('claude-code');
		expect(h.service.overrideFor('dev-1')).toBe('crewly-agent');
		const state = h.store.load();
		expect(state.exhausted['claude-code']).toMatchObject({ ruleId: 'claude.hit_your_limit', until: new Date(Date.UTC(2026, 9, 1, 15)).toISOString() });
		expect(state.overrides['dev-1']).toMatchObject({
			runtime: 'crewly-agent',
			primary: 'claude-code',
			reason: 'usage_limit',
			primarySessionId: 'claude-convo-1',
			until: new Date(Date.UTC(2026, 9, 1, 15)).toISOString(),
		});
		// The fallback starts a fresh conversation.
		expect(h.conversations.has('dev-1')).toBe(false);
		expect(h.handovers).toEqual([{ sessionName: 'dev-1', from: 'claude-code', to: 'crewly-agent', direction: 'switch' }]);
		expect(h.relaunched).toEqual(['dev-1']);
		expect(h.redelivered).toEqual(['dev-1']);
		expect(h.flushed).toEqual(['dev-1']);

		const note = h.service.takeKickoffNote('dev-1');
		expect(note).toContain('from Claude Code to DeepSeek');
		expect(note).toContain('/home/.crewly/handover/dev-1-switch.md');
		expect(note).toContain('WorkItem wi-42 ("Fix the login page")');
		expect(h.service.takeKickoffNote('dev-1')).toBeNull();
	});

	it('re-delivers only once messages are no longer held back for the switch', async () => {
		const h = make();
		const gateDuringRedeliver: string[] = [];
		h.deps.redeliver = async (s) => {
			gateDuringRedeliver.push(h.service.beforeDelivery(s, 'crewly-agent'));
		};
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(gateDuringRedeliver).toEqual(['deliver']);
	});

	it('waits for the agent to finish its turn before switching', async () => {
		const h = make();
		h.busy.add('dev-1');
		let checks = 0;
		h.deps.isBusy = async (s) => {
			checks += 1;
			if (checks >= 3) h.busy.delete(s);
			return h.busy.has(s);
		};
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(checks).toBeGreaterThanOrEqual(3);
		expect(h.relaunched).toEqual(['dev-1']);
	});

	it('ignores a match the probe disproves (false positive) and mutes detection for a while', async () => {
		const h = make({ probe: 'available' });
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.relaunched).toEqual([]);
		expect(h.store.load().exhausted).toEqual({});
		expect(h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output')).toBe(false);
	});

	it('never acts on an expired login or on the screen sweep', async () => {
		const h = make();
		expect(h.service.reportOutput('dev-1', 'claude-code', 'Login expired · Please run /login', 'output')).toBe(false);
		expect(h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'screen')).toBe(false);
		await settle();
		expect(h.relaunched).toEqual([]);
	});

	it('leaves transient rate limits to the runtime, unless they keep coming', async () => {
		const h = make();
		const transient = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Please try again later."}}';
		for (let i = 0; i < 3; i += 1) expect(h.service.reportOutput('dev-1', 'claude-code', transient, 'output')).toBe(false);
		await settle();
		expect(h.relaunched).toEqual([]);
		expect(h.service.reportOutput('dev-1', 'claude-code', transient, 'output')).toBe(true);
		await settle();
		expect(h.store.load().exhausted['claude-code']?.ruleId).toBe('claude.api_rate_limited+repeated');
		expect(h.relaunched).toEqual(['dev-1']);
	});

	it('skips exhausted and unavailable runtimes in the chain', async () => {
		const h = make({
			availability: [
				{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
				{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: false, reason: 'No DeepSeek API key' },
				{ runtime: 'antigravity-cli', label: 'Antigravity', selectable: true },
			],
		});
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.service.overrideFor('dev-1')).toBe('antigravity-cli');
	});

	it('skips a runtime whose Terms the owner did not accept (specs/2026-10-01-runtime-terms-consent.md)', async () => {
		const harnesses = ['claude-code', 'antigravity-cli', 'codex-cli'].map((id) => ({ id, installed: true, loginState: 'logged_in' as const }));
		const availability = (declined: boolean): RuntimeAvailability[] =>
			computeRuntimeAvailability({
				harnesses,
				crewlyAgentModel: 'deepseek/deepseek-chat',
				hasProviderKey: () => false,
				termsBlocked: (r) => (declined && r === 'antigravity-cli' ? "Terms not accepted: You chose Don't agree" : null),
			});
		const declined = make({ availability: availability(true) });
		declined.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(declined.service.overrideFor('dev-1')).toBeNull();
		expect((await declined.service.snapshot()).runtimes.find((r) => r.runtime === 'antigravity-cli')).toMatchObject({
			selectable: false,
			termsBlocked: true,
			reason: "Terms not accepted: You chose Don't agree",
		});

		const accepted = make({ availability: availability(false) });
		accepted.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(accepted.service.overrideFor('dev-1')).toBe('antigravity-cli');
	});

	it('uses a per-member chain when one is set', async () => {
		const h = make();
		h.service.updateSettings({ memberChains: { m1: ['antigravity-cli', 'crewly-agent'] } });
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.service.overrideFor('dev-1')).toBe('antigravity-cli');
	});

	it('moves an agent already on a fallback further down the chain when the fallback runs out too', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.service.takeKickoffNote('dev-1');
		h.service.reportOutput('dev-1', 'crewly-agent', 'AI_APICallError: Insufficient Balance', 'error');
		await settle();
		expect(h.service.overrideFor('dev-1')).toBe('antigravity-cli');
		// The primary (and its conversation) are unchanged.
		expect(h.store.load().overrides['dev-1']).toMatchObject({ primary: 'claude-code', primarySessionId: 'claude-convo-1' });
	});

	it('does not move the orchestrator when orcFollows is off', async () => {
		const h = make();
		h.service.updateSettings({ orcFollows: false });
		h.service.reportOutput('crewly-orc', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.relaunched).toEqual([]);
		expect(h.service.beforeDelivery('crewly-orc', 'claude-code')).toBe('deliver');
	});

	it('moves the orchestrator by default', async () => {
		const h = make();
		h.service.reportOutput('crewly-orc', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.relaunched).toEqual(['crewly-orc']);
	});

	it('does nothing when disabled or for smoke-test sessions', async () => {
		const h = make();
		expect(h.service.reportOutput('zz-runtime-smoke-claude-code-smoke', 'claude-code', CLAUDE_LIMIT, 'output')).toBe(false);
		h.service.updateSettings({ enabled: false });
		expect(h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output')).toBe(false);
		await settle();
		expect(h.relaunched).toEqual([]);
	});
});

describe('RuntimeFallbackService — account-wide limit', () => {
	it('switches other agents on that runtime when they next get work, and never wakes idle ones', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.relaunched).toEqual(['dev-1']);

		// dev-3 gets no message: it is left alone.
		// dev-2 gets work: the message is queued and dev-2 switches first.
		expect(h.service.beforeDelivery('dev-2', 'claude-code')).toBe('queue');
		await settle();
		expect(h.relaunched).toEqual(['dev-1', 'dev-2']);
		expect(h.service.overrideFor('dev-2')).toBe('crewly-agent');
		expect(h.flushed).toContain('dev-2');
		expect(h.service.overrideFor('dev-3')).toBeNull();

		// An agent on another runtime is not affected; dev-2 is now on DeepSeek.
		expect(h.service.beforeDelivery('nova-1', 'codex-cli')).toBe('deliver');
		expect(h.service.beforeDelivery('dev-2', 'claude-code')).toBe('deliver');
	});

	it('queues messages while a switch is running', async () => {
		const h = make();
		let release!: () => void;
		h.deps.relaunch = (a) =>
			new Promise((resolve) => {
				release = () => resolve(true);
				h.relaunched.push(a.sessionName);
			});
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.service.beforeDelivery('dev-1', 'crewly-agent')).toBe('queue');
		release();
		await settle();
		expect(h.service.beforeDelivery('dev-1', 'crewly-agent')).toBe('deliver');
	});

	it('starts a stopped agent directly on the fallback', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		const decision = await h.service.resolveLaunch({ sessionName: 'dev-3', configured: 'claude-code', memberId: 'm3', isOrchestrator: false });
		expect(decision).toEqual({ runtime: 'crewly-agent', overridden: true, crewlyAgentModel: 'deepseek/deepseek-chat' });
		expect(h.store.load().exhausted['claude-code'].switched).toEqual(['dev-1', 'dev-3']);
		// Its own runtime when nothing is exhausted / for another runtime.
		await expect(h.service.resolveLaunch({ sessionName: 'nova-1', configured: 'codex-cli', isOrchestrator: false })).resolves.toEqual({
			runtime: 'codex-cli',
			overridden: false,
		});
	});

	it('drops a stale override when the owner changed the member runtime', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		const decision = await h.service.resolveLaunch({ sessionName: 'dev-1', configured: 'codex-cli', isOrchestrator: false });
		expect(decision).toEqual({ runtime: 'codex-cli', overridden: false });
		expect(h.service.overrideFor('dev-1')).toBeNull();
	});

	it('flushes queued messages when no fallback is available', async () => {
		const h = make({ availability: [{ runtime: 'claude-code', label: 'Claude Code', selectable: true }] });
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.relaunched).toEqual([]);
		// The cached availability says nothing can take over: deliver as usual.
		expect(h.service.beforeDelivery('dev-2', 'claude-code')).toBe('deliver');
		expect(h.store.load().exhausted['claude-code'].noFallback).toBe(true);
	});
});

describe('RuntimeFallbackService — switch back', () => {
	async function switched(): Promise<Harness> {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.service.beforeDelivery('dev-2', 'claude-code');
		await settle();
		h.relaunched.length = 0;
		h.redelivered.length = 0;
		return h;
	}

	it('probes after the reset time and reverts each agent at its idle boundary, never mid-turn', async () => {
		const h = await switched();
		h.probe.mockResolvedValue('available');

		// Before the reset: no probe.
		h.probe.mockClear();
		await h.service.tick();
		expect(h.probe).not.toHaveBeenCalled();

		// After the reset (+ grace): probe says available; dev-2 is mid-turn.
		h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
		h.busy.add('dev-2');
		await h.service.tick();
		expect(h.probe).toHaveBeenCalledWith('claude-code');
		expect(h.store.load().exhausted).toEqual({});
		expect(h.relaunched).toEqual(['dev-1']);
		expect(h.service.overrideFor('dev-1')).toBeNull();
		expect(h.conversations.get('dev-1')).toBe('claude-convo-1');
		expect(h.redelivered).toEqual(['dev-1']);
		expect(h.service.takeKickoffNote('dev-1')).toContain('Claude Code is available again');

		// dev-2 keeps running on the fallback until it is idle.
		expect(h.service.overrideFor('dev-2')).toBe('crewly-agent');
		expect(h.store.load().overrides['dev-2'].revertPending).toBe(true);
		h.busy.delete('dev-2');
		await h.service.tick();
		expect(h.relaunched).toEqual(['dev-1', 'dev-2']);
		expect(h.service.overrideFor('dev-2')).toBeNull();
		expect(h.conversations.get('dev-2')).toBe('claude-convo-2');
	});

	it('clears the override of a stopped agent without starting it', async () => {
		const h = await switched();
		h.live.delete('dev-2');
		await h.service.recover('claude-code');
		expect(h.relaunched).toEqual(['dev-1']);
		expect(h.service.overrideFor('dev-2')).toBeNull();
		expect(h.conversations.get('dev-2')).toBe('claude-convo-2');
	});

	it('keeps the fallback when the probe still sees the limit, and probes on the interval after that', async () => {
		const h = await switched();
		h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
		h.probe.mockResolvedValue('limited');
		await h.service.tick();
		expect(h.store.load().exhausted['claude-code']).toBeDefined();
		expect(h.store.load().exhausted['claude-code'].until).toBeUndefined();
		h.probe.mockClear();
		h.clock.now += 5 * 60_000;
		await h.service.tick();
		expect(h.probe).not.toHaveBeenCalled();
		h.clock.now += 15 * 60_000;
		h.probe.mockResolvedValue('available');
		await h.service.tick();
		expect(h.probe).toHaveBeenCalled();
		expect(h.service.overrideFor('dev-1')).toBeNull();
	});
});

describe('RuntimeFallbackService — out of credit (billing) and switch-back probes', () => {
	const DEEPSEEK_402 = 'AI_APICallError: Insufficient Balance';
	const SIX_HOURS = 6 * 60 * 60_000;

	/** An agent configured on the Crewly Agent (DeepSeek) runtime, switched to Claude Code by a 402. */
	async function outOfCredit(): Promise<Harness> {
		AGENTS['ds-1'] = { sessionName: 'ds-1', name: 'Dee', primary: 'crewly-agent', memberId: 'm9', teamId: 't1', isOrchestrator: false };
		const h = make();
		h.live.add('ds-1');
		expect(h.service.reportOutput('ds-1', 'crewly-agent', DEEPSEEK_402, 'error')).toBe(true);
		await settle();
		expect(h.service.overrideFor('ds-1')).toBe('claude-code');
		h.relaunched.length = 0;
		h.probe.mockClear();
		return h;
	}

	afterEach(() => {
		delete AGENTS['ds-1'];
	});

	it('marks a DeepSeek 402 as billing with no reset time, and never switches back on a timer', async () => {
		const h = await outOfCredit();
		const entry = h.store.load().exhausted['crewly-agent'];
		expect(entry).toMatchObject({ kind: 'billing', ruleId: 'crewly-agent.insufficient_balance' });
		expect(entry.until).toBeUndefined();

		// Past the owner's 15-minute probe interval (the 20:39 → 20:54 flap) and
		// up to just before 6 h: no probe, no switch-back.
		for (const minutes of [15, 16, 60, 5 * 60, 6 * 60 - 1]) {
			h.clock.now = T0 + minutes * 60_000;
			await h.service.tick();
		}
		expect(h.probe).not.toHaveBeenCalled();
		expect(h.relaunched).toEqual([]);
		expect(h.service.overrideFor('ds-1')).toBe('claude-code');
	});

	it('keeps the fallback when the probe fails or cannot tell', async () => {
		const h = await outOfCredit();
		h.clock.now = T0 + SIX_HOURS;
		h.probe.mockResolvedValue('limited');
		await h.service.tick();
		expect(h.probe).toHaveBeenCalledWith('crewly-agent');
		expect(h.service.overrideFor('ds-1')).toBe('claude-code');

		h.clock.now += SIX_HOURS;
		h.probe.mockResolvedValue('unknown');
		await h.service.tick();
		expect(h.probe).toHaveBeenCalledTimes(2);
		expect(h.service.overrideFor('ds-1')).toBe('claude-code');
		expect(h.store.load().exhausted['crewly-agent']).toBeDefined();
		expect(h.relaunched).toEqual([]);
	});

	it('switches back at the idle boundary once the probe passes', async () => {
		const h = await outOfCredit();
		h.clock.now = T0 + SIX_HOURS;
		h.probe.mockResolvedValue('available');
		h.busy.add('ds-1');
		await h.service.tick();
		expect(h.store.load().exhausted).toEqual({});
		// Mid-turn: not yet.
		expect(h.relaunched).toEqual([]);
		h.busy.delete('ds-1');
		await h.service.tick();
		expect(h.relaunched).toEqual(['ds-1']);
		expect(h.service.overrideFor('ds-1')).toBeNull();
	});

	it('backs off after a switch-back that fails, without telling the owner again', async () => {
		const h = await outOfCredit();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		expect(h.dms).toHaveLength(1);

		h.clock.now = T0 + SIX_HOURS;
		h.probe.mockResolvedValue('available');
		await h.service.tick();
		expect(h.relaunched).toEqual(['ds-1']);
		const dmsAfterRecovery = h.dms.length;

		// The primary fails again right after the switch-back.
		h.clock.now += 60_000;
		h.probe.mockResolvedValue('limited');
		h.service.reportOutput('ds-1', 'crewly-agent', DEEPSEEK_402, 'error');
		await settle();
		expect(h.service.overrideFor('ds-1')).toBe('claude-code');
		const entry = h.store.load().exhausted['crewly-agent'];
		expect(entry).toMatchObject({ kind: 'billing', failedReverts: 1, notified: true });
		await h.service.flushNotices();
		expect(h.dms).toHaveLength(dmsAfterRecovery);

		// The next probe waits twice as long (12 h), not 6 h.
		h.probe.mockClear();
		const since = h.clock.now;
		h.clock.now = since + SIX_HOURS + 60_000;
		await h.service.tick();
		expect(h.probe).not.toHaveBeenCalled();
		h.clock.now = since + 2 * SIX_HOURS;
		await h.service.tick();
		expect(h.probe).toHaveBeenCalledTimes(1);
	});

	it('tells the owner once: out of credit, where to top up, who runs on what', async () => {
		const h = await outOfCredit();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		await h.service.tick();
		expect(h.dms).toEqual(['DeepSeek is out of credit — top up at platform.deepseek.com. Dee is running on Claude Code meanwhile.']);
		h.clock.now = T0 + 5 * 60 * 60_000;
		await h.service.tick();
		expect(h.dms).toHaveLength(1);
	});

	it('does not switch a usage-limit runtime back when its probe could not tell (only a passing probe proves it)', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.relaunched.length = 0;
		h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
		h.probe.mockResolvedValue('unknown');
		await h.service.tick();
		expect(h.service.overrideFor('dev-1')).toBe('crewly-agent');
		expect(h.relaunched).toEqual([]);
	});

	it('lets a runtime without a probe come back on its parsed reset time (never earlier)', async () => {
		const h = make();
		h.probe.mockResolvedValue('unsupported');
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.relaunched.length = 0;
		h.clock.now = Date.UTC(2026, 9, 1, 14, 0);
		await h.service.tick();
		expect(h.service.overrideFor('dev-1')).toBe('crewly-agent');
		h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
		await h.service.tick();
		expect(h.service.overrideFor('dev-1')).toBeNull();
		expect(h.relaunched).toEqual(['dev-1']);
	});
});

describe('RuntimeFallbackService — owner notices', () => {
	it('tells the owner once per event (after the switches), and once when it is over', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.service.beforeDelivery('dev-2', 'claude-code');
		await settle();

		await h.service.flushNotices();
		expect(h.dms).toEqual([]); // not due yet

		h.clock.now += 60_000;
		await h.service.flushNotices();
		expect(h.dms).toHaveLength(1);
		expect(h.dms[0]).toBe(
			'Claude Code hit its usage limit on iriss-air (resets ~3:00 PM UTC). 2 agents switched to DeepSeek until then. The others switch when they next get work.',
		);

		// More detections / switches in the same event: no second DM.
		h.service.reportOutput('dev-3', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		await h.service.tick();
		expect(h.dms).toHaveLength(1);

		await h.service.recover('claude-code');
		expect(h.dms).toHaveLength(2);
		expect(h.dms[1]).toBe('Claude Code is available again on iriss-air. 3 agents are switching back from DeepSeek as they finish their current turn.');
	});

	it('says so when no fallback is available', async () => {
		const h = make({ availability: [] });
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		expect(h.dms).toEqual([
			'Claude Code hit its usage limit on iriss-air (resets ~3:00 PM UTC). No fallback runtime is available, so its agents wait until it resets. Set one in Settings → Runtimes.',
		]);
	});

	it('retries a notice that could not be delivered, and does not re-send after a restart', async () => {
		const h = make();
		let up = false;
		h.deps.notifier = () => ({ sendToOwner: async (text: string) => (up ? (h.dms.push(text), true) : false) });
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		expect(h.dms).toHaveLength(0);
		up = true;
		await h.service.flushNotices();
		expect(h.dms).toHaveLength(1);

		// A restarted backend reads the persisted state: no second DM.
		const restarted = new RuntimeFallbackService({ ...h.deps, store: h.store });
		await restarted.flushNotices();
		expect(h.dms).toHaveLength(1);
	});
});

describe('RuntimeFallbackService — snapshot', () => {
	it('shows the badge, exhausted runtimes and availability', async () => {
		const h = make();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		const snap = await h.service.snapshot();
		expect(snap.overrides).toEqual([expect.objectContaining({ sessionName: 'dev-1', badge: 'on DeepSeek (Claude limit)', runtime: 'crewly-agent' })]);
		expect(snap.exhausted.map((e) => e.runtime)).toEqual(['claude-code']);
		expect(snap.runtimes.find((r) => r.runtime === 'claude-code')).toMatchObject({ exhausted: true });
		expect(h.service.overrideView('dev-2')).toBeNull();
	});
});

describe('RuntimeFallbackService — a second Claude Code account (#942)', () => {
	const CHAIN = ['claude-code', 'claude-code@b', 'crewly-agent'];
	const WITH_B: RuntimeAvailability[] = [
		{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
		{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: true },
		{ runtime: 'claude-code@b', label: 'Claude Code (b)', selectable: true },
	];
	const makeB = (probe: ProbeResult = 'limited') => make({ availability: WITH_B, initial: { settings: { chain: CHAIN } }, probe });

	it('moves the agent to account B first; it still runs Claude Code, on B', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.probe).toHaveBeenCalledWith('claude-code');
		expect(h.store.load().overrides['dev-1']).toMatchObject({ runtime: 'claude-code@b', primary: 'claude-code', primarySessionId: 'claude-convo-1' });
		expect(h.service.overrideFor('dev-1')).toBe('claude-code');
		expect(h.service.accountFor('dev-1')).toBe('b');
		expect(h.service.accountFor('dev-2')).toBeNull();
		await expect(h.service.resolveLaunch({ sessionName: 'dev-1', configured: 'claude-code', isOrchestrator: false })).resolves.toEqual({
			runtime: 'claude-code',
			overridden: true,
			claudeAccount: 'b',
		});
		expect(h.service.takeKickoffNote('dev-1')).toContain('from Claude Code to Claude Code (b)');
		expect(h.relaunched).toEqual(['dev-1']);
	});

	it('a limit on account B marks B (not the default login) and moves on along the chain', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.probe.mockClear();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.probe).toHaveBeenCalledWith('claude-code@b');
		const state = h.store.load();
		expect(Object.keys(state.exhausted).sort()).toEqual(['claude-code', 'claude-code@b']);
		expect(state.overrides['dev-1']).toMatchObject({ runtime: 'crewly-agent', primary: 'claude-code', primarySessionId: 'claude-convo-1' });
		expect(h.service.accountFor('dev-1')).toBeNull();
	});

	it('an agent started while the default login is out starts on B', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		await expect(h.service.resolveLaunch({ sessionName: 'dev-3', configured: 'claude-code', memberId: 'm3', isOrchestrator: false })).resolves.toMatchObject({
			runtime: 'claude-code',
			claudeAccount: 'b',
		});
	});

	it('agents on B go back to the default login when it is back', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.probe.mockResolvedValue('available');
		h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
		await h.service.tick();
		expect(h.store.load().overrides['dev-1']).toBeUndefined();
		expect(h.conversations.get('dev-1')).toBe('claude-convo-1');
		expect(h.service.accountFor('dev-1')).toBeNull();
	});

	it("an expired login on B marks B signed out, moves the agent on, and asks the owner to sign B in", async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		await h.service.flushNotices();
		h.clock.now += 60_000;
		await h.service.flushNotices();
		h.dms.length = 0;

		expect(h.service.reportLoginExpiry('dev-2')).toBe(false);
		expect(h.service.reportLoginExpiry('dev-1')).toBe(true);
		await settle();
		const state = h.store.load();
		expect(state.exhausted['claude-code@b']).toMatchObject({ kind: 'login', ruleId: 'login_expired' });
		expect(state.overrides['dev-1'].runtime).toBe('crewly-agent');
		expect(h.service.takeKickoffNote('dev-1')).toContain('because the Claude Code (b) login expired');

		h.clock.now += 60_000;
		await h.service.flushNotices();
		expect(h.dms).toEqual(['Claude Code (b) is signed out on iriss-air. Reply `login claude b` to sign it in again. 1 agent switched to DeepSeek meanwhile.']);
	});

	it('signing B in again brings it back after a probe', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.service.reportLoginExpiry('dev-1');
		await settle();
		h.probe.mockClear();
		h.probe.mockResolvedValue('available');
		await h.service.onAccountLogin('b');
		expect(h.probe).toHaveBeenCalledWith('claude-code@b');
		expect(h.store.load().exhausted['claude-code@b']).toBeUndefined();
		// Not signed out (only out of usage): a sign-in changes nothing.
		await h.service.onAccountLogin('other');
		expect(h.store.load().exhausted['claude-code']).toBeDefined();
	});

	it('a sign-in that finds B out of usage keeps it out, as a usage limit', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		h.service.reportLoginExpiry('dev-1');
		await settle();
		h.probe.mockResolvedValue('limited');
		await h.service.onAccountLogin('b');
		expect(h.store.load().exhausted['claude-code@b']).toMatchObject({ kind: 'usage_limit' });
	});

	// crewly#1344: a session moved between accounts always started fresh —
	// the transcript lived in the other account's config dir.
	describe('the conversation travels between Claude Code accounts', () => {
		it('keeps the conversation id when the wiring carried the transcript to B, and says so in the kickoff note; the handover is still written', async () => {
			const h = makeB();
			const carried: unknown[] = [];
			h.deps.carryConversation = async (args) => {
				carried.push(args);
				return true;
			};
			h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
			await settle();
			expect(carried).toEqual([{ sessionName: 'dev-1', from: 'claude-code', to: 'claude-code@b', conversationId: 'claude-convo-1' }]);
			expect(h.conversations.get('dev-1')).toBe('claude-convo-1');
			expect(h.store.load().overrides['dev-1']).toMatchObject({ runtime: 'claude-code@b', primarySessionId: 'claude-convo-1' });
			expect(h.handovers).toHaveLength(1);
			const note = h.service.takeKickoffNote('dev-1') ?? '';
			expect(note).toContain('Your conversation came with you');
			expect(note).not.toContain('fresh conversation');
		});

		it('falls back to a fresh conversation with the handover when the copy fails or throws', async () => {
			for (const carry of [async () => false, async () => { throw new Error('disk'); }]) {
				const h = makeB();
				h.deps.carryConversation = carry;
				h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
				await settle();
				expect(h.conversations.has('dev-1')).toBe(false);
				expect(h.service.takeKickoffNote('dev-1')).toContain('This is a fresh conversation');
			}
		});

		it('never tries to carry a conversation to a runtime that is not Claude Code', async () => {
			const h = make();
			const carry = jest.fn(async () => true);
			h.deps.carryConversation = carry;
			h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
			await settle();
			expect(h.service.overrideFor('dev-1')).toBe('crewly-agent');
			expect(carry).not.toHaveBeenCalled();
			expect(h.conversations.has('dev-1')).toBe(false);
		});

		it('brings the conversation that went on on B back to the default login at the revert, for a running and for a stopped agent', async () => {
			const h = makeB();
			h.deps.carryConversation = async () => true;
			h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
			h.service.beforeDelivery('dev-2', 'claude-code');
			await settle();
			// On B the conversations went on (new ids after a /clear there).
			h.conversations.set('dev-1', 'convo-on-b-1');
			h.conversations.set('dev-2', 'convo-on-b-2');
			h.live.delete('dev-2');
			h.probe.mockResolvedValue('available');
			h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
			await h.service.tick();
			expect(h.service.overrideFor('dev-1')).toBeNull();
			expect(h.conversations.get('dev-1')).toBe('convo-on-b-1');
			expect(h.service.takeKickoffNote('dev-1')).toContain('Your conversation came back with you');
			expect(h.service.overrideFor('dev-2')).toBeNull();
			expect(h.conversations.get('dev-2')).toBe('convo-on-b-2');
		});

		it('resumes the primary conversation from before the switch when the copy back fails', async () => {
			const h = makeB();
			let allow = true;
			h.deps.carryConversation = async () => allow;
			h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
			await settle();
			h.conversations.set('dev-1', 'convo-on-b-1');
			allow = false;
			h.probe.mockResolvedValue('available');
			h.clock.now = Date.UTC(2026, 9, 1, 15, 3);
			await h.service.tick();
			expect(h.conversations.get('dev-1')).toBe('claude-convo-1');
			expect(h.service.takeKickoffNote('dev-1')).toContain('Work went on while you were away');
		});
	});

	it('shows B in the badge', async () => {
		const h = makeB();
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.service.overrideView('dev-1')).toMatchObject({ runtimeLabel: 'Claude Code (b)', badge: 'on Claude Code (b) (Claude limit)' });
	});
});

describe('RuntimeFallbackService — signing in a Claude account does not turn it on as a fallback', () => {
	const AVAIL: RuntimeAvailability[] = [
		{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
		{ runtime: 'antigravity-cli', label: 'Antigravity', selectable: true },
		{ runtime: 'codex-cli', label: 'Codex', selectable: true },
		{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: true },
		{ runtime: 'claude-code@stevehuang0115', label: 'Claude Code (stevehuang0115)', selectable: true },
	];
	const CHAIN = ['claude-code', 'antigravity-cli', 'codex-cli', 'crewly-agent'];
	const NEW = 'claude-code@stevehuang0115';

	const exhaust = (runtime: string) => ({ runtime, since: new Date(T0).toISOString(), kind: 'usage_limit', ruleId: 'x', switched: [], switchedTo: [], notified: true });
	const stuck = (h: Harness, chain: string[]): RuntimeFallbackService => {
		h.deps.listSessions = async () => ['dev-1', 'dev-2', 'nova-1'];
		h.store.save({
			...h.store.load(),
			settings: { ...h.store.load().settings, chain },
			exhausted: { 'claude-code': exhaust('claude-code'), 'antigravity-cli': exhaust('antigravity-cli'), 'codex-cli': exhaust('codex-cli') },
			overrides: { 'dev-2': { runtime: 'antigravity-cli', primary: 'claude-code', reason: 'usage_limit', since: new Date(T0).toISOString() } },
		} as never);
		return new RuntimeFallbackService(h.deps);
	};

	it('does not add a signed-in account to the global order', async () => {
		const h = make({ availability: AVAIL, initial: { settings: { chain: CHAIN } } });
		await h.service.onAccountLogin('stevehuang0115');
		await h.service.onAccountLogin('stevehuang0115');
		await settle();
		expect(h.store.load().settings.chain).toEqual(CHAIN);
	});

	it('does not add it to member orders either, with or without a Claude Code entry', async () => {
		const members = { m1: ['claude-code', 'codex-cli'], m2: ['codex-cli', 'crewly-agent'] };
		const h = make({ availability: AVAIL, initial: { settings: { chain: ['codex-cli'], memberChains: members } } });
		await h.service.onAccountLogin('stevehuang0115');
		await settle();
		const s = h.store.load().settings;
		expect(s.chain).toEqual(['codex-cli']);
		expect(s.memberChains).toEqual(members);
	});

	it('does not move agents stuck on exhausted runtimes to an account the owner has not turned on', async () => {
		const h = make({ availability: AVAIL, initial: { settings: { chain: CHAIN } } });
		const svc = stuck(h, CHAIN);
		await svc.onAccountLogin('stevehuang0115');
		await settle();
		expect(h.store.load().overrides['dev-1']).toBeUndefined();
		expect(h.store.load().overrides['nova-1']).toBeUndefined();
		expect(h.relaunched).toEqual([]);
	});

	it('keeps an entry the owner already has in the order untouched on sign-in', async () => {
		const chain = ['claude-code', NEW, 'antigravity-cli', 'codex-cli', 'crewly-agent'];
		const members = { m1: ['claude-code', NEW, 'codex-cli'] };
		const h = make({ availability: AVAIL, initial: { settings: { chain, memberChains: members } } });
		await h.service.onAccountLogin('stevehuang0115');
		await settle();
		const s = h.store.load().settings;
		expect(s.chain).toEqual(chain);
		expect(s.memberChains).toEqual(members);
	});

	it('an account the owner turned on is still used: agents stuck on exhausted runtimes move to it on sign-in', async () => {
		const chain = ['claude-code', NEW, 'antigravity-cli', 'codex-cli', 'crewly-agent'];
		const h = make({ availability: AVAIL, initial: { settings: { chain } } });
		const svc = stuck(h, chain);
		await svc.onAccountLogin('stevehuang0115');
		await settle();
		const overrides = h.store.load().overrides;
		expect(overrides['dev-1']?.runtime).toBe(NEW);
		expect(overrides['dev-2']?.runtime).toBe(NEW);
		expect(overrides['nova-1']?.runtime).toBe(NEW);
		expect(h.relaunched.sort()).toEqual(['dev-1', 'dev-2', 'nova-1']);
	});

	it('an explicit add through the settings makes the account a fallback target', async () => {
		const h = make({ availability: AVAIL, initial: { settings: { chain: CHAIN } }, probe: 'limited' });
		await h.service.onAccountLogin('stevehuang0115');
		const next = ['claude-code', NEW, 'antigravity-cli', 'codex-cli', 'crewly-agent'];
		expect(h.service.updateSettings({ chain: next }).chain).toEqual(next);
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.store.load().overrides['dev-1']).toMatchObject({ runtime: NEW, primary: 'claude-code' });
	});

	it('without the explicit add, a limit goes to the next runtime, not the signed-in account', async () => {
		const h = make({ availability: AVAIL, initial: { settings: { chain: CHAIN } }, probe: 'limited' });
		await h.service.onAccountLogin('stevehuang0115');
		h.service.reportOutput('dev-1', 'claude-code', CLAUDE_LIMIT, 'output');
		await settle();
		expect(h.store.load().overrides['dev-1']).toMatchObject({ runtime: 'antigravity-cli' });
	});
});

describe('RuntimeFallbackService — runtime not installed / signed in on this machine', () => {
	const availability = (anti: Partial<RuntimeAvailability>): RuntimeAvailability[] => [
		{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
		{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: false, reason: 'No DeepSeek API key' },
		{ runtime: 'antigravity-cli', label: 'Antigravity', selectable: false, reason: 'Not installed', loginProblem: true, ...anti },
		{ runtime: 'codex-cli', label: 'Codex', selectable: true },
	];
	const launch = (h: Harness) => h.service.resolveLaunch({ sessionName: 'ruth-1', configured: 'antigravity-cli', memberId: 'm9', teamId: 't9', isOrchestrator: false });

	it('starts the agent on its fallback chain and remembers the configured runtime', async () => {
		const h = make({ availability: availability({}) });
		await expect(launch(h)).resolves.toMatchObject({ runtime: 'claude-code', overridden: true });
		expect(h.service.overrideFor('ruth-1')).toBe('claude-code');
		expect(h.store.load().exhausted['antigravity-cli']).toMatchObject({ kind: 'login', ruleId: 'not_installed' });
		expect(h.service.takeKickoffNote('ruth-1')).toMatch(/not installed or signed in on this machine/);
	});

	it('does nothing for a runtime whose state is unknown or that is merely blocked for another reason', async () => {
		const h = make({ availability: availability({ loginProblem: undefined, reason: "Sign-in couldn't be checked" }) });
		await expect(launch(h)).resolves.toEqual({ runtime: 'antigravity-cli', overridden: false });
		expect(h.store.load().exhausted['antigravity-cli']).toBeUndefined();
	});

	it('tells the owner once, in words that fit a missing login', async () => {
		const h = make({ availability: availability({ reason: 'Not signed in' }) });
		await launch(h);
		h.clock.now += 60_000;
		await h.service.flushNotices();
		await settle();
		expect(h.dms).toHaveLength(1);
		expect(h.dms[0]).toMatch(/Antigravity is not signed in on iriss-air/);
		expect(h.dms[0]).toMatch(/switch back by themselves/);
	});

	it('switches the agent back by itself once the runtime is installed and signed in', async () => {
		const list = availability({});
		const h = make({ availability: list });
		await launch(h);
		h.live.add('ruth-1');
		(h.deps as { getAgent: RuntimeFallbackDeps['getAgent'] }).getAgent = async (s) =>
			s === 'ruth-1' ? { sessionName: 'ruth-1', name: 'Ruth', primary: 'antigravity-cli', memberId: 'm9', teamId: 't9', isOrchestrator: false } : null;

		// Still missing: nothing changes.
		h.clock.now += 3 * 60_000;
		await h.service.tick();
		expect(h.service.overrideFor('ruth-1')).toBe('claude-code');

		// Logged in (the availability cache is bypassed by the recheck).
		Object.assign(list[2]!, { selectable: true, reason: undefined, loginProblem: undefined });
		h.clock.now += 3 * 60_000;
		await h.service.tick();
		await settle();
		expect(h.store.load().exhausted['antigravity-cli']).toBeUndefined();
		expect(h.service.overrideFor('ruth-1')).toBeNull();
		expect(h.relaunched).toContain('ruth-1');
	});
});

describe('RuntimeFallbackService — two Claude accounts: prefer the better target, clear stale marks', () => {
	const STEVE = 'claude-code@steve';
	const CHAIN = ['claude-code', STEVE, 'antigravity-cli', 'codex-cli', 'crewly-agent'];
	const AVAIL: RuntimeAvailability[] = [
		{ runtime: 'claude-code', label: 'Claude Code', selectable: true },
		{ runtime: STEVE, label: 'Claude Code (steve)', selectable: true },
		{ runtime: 'antigravity-cli', label: 'Antigravity', selectable: true },
		{ runtime: 'codex-cli', label: 'Codex', selectable: true },
		{ runtime: 'crewly-agent', label: 'DeepSeek', selectable: true },
	];
	const ORC: FallbackAgentInfo = { sessionName: 'crewly-orc', name: 'Orc', primary: 'crewly-agent', isOrchestrator: true };
	const iso = (ms: number) => new Date(ms).toISOString();
	const mark = (runtime: string, extra: Record<string, unknown> = {}) => ({
		runtime,
		since: iso(T0 - 60 * 60_000),
		kind: 'usage_limit',
		ruleId: 'x',
		switched: [],
		switchedTo: [],
		notified: true,
		...extra,
	});

	/**
	 * The 2026-10-16 state: DeepSeek out of credit, orc on the second account,
	 * both Claude accounts, Antigravity and Codex marked out of usage.
	 */
	function incident(opts: { orcRuntime?: string; marked?: string[] } = {}) {
		const h = make({ availability: AVAIL });
		(h.deps as { getAgent: RuntimeFallbackDeps['getAgent'] }).getAgent = async (s) => (s === 'crewly-orc' ? ORC : (AGENTS[s] ?? null));
		const marked = opts.marked ?? ['claude-code', STEVE, 'antigravity-cli', 'codex-cli'];
		const exhausted: Record<string, unknown> = { 'crewly-agent': mark('crewly-agent', { kind: 'billing' }) };
		for (const r of marked) exhausted[r] = mark(r, { until: iso(T0 + 30 * 3600_000) });
		h.store.save({
			...h.store.load(),
			settings: { ...h.store.load().settings, chain: CHAIN },
			exhausted,
			overrides: { 'crewly-orc': { runtime: opts.orcRuntime ?? STEVE, primary: 'crewly-agent', reason: 'usage_limit', since: iso(T0 - 15 * 24 * 3600_000) } },
		} as never);
		const service = new RuntimeFallbackService(h.deps);
		return { ...h, service };
	}

	it('moves the orc from the second account back to the default login once it has usage, though DeepSeek is still out', async () => {
		const h = incident({ marked: [STEVE, 'antigravity-cli', 'codex-cli'] });
		await h.service.tick();
		await settle();
		expect(h.store.load().overrides['crewly-orc']).toMatchObject({ runtime: 'claude-code', primary: 'crewly-agent' });
		expect(h.service.accountFor('crewly-orc')).toBeNull();
		expect(h.handovers).toEqual([{ sessionName: 'crewly-orc', from: STEVE, to: 'claude-code', direction: 'upgrade' }]);
		expect(h.relaunched).toEqual(['crewly-orc']);
		expect(h.service.takeKickoffNote('crewly-orc')).toMatch(/Claude Code has usage again, so Crewly moved you there from Claude Code \(steve\); DeepSeek is still unavailable/);
	});

	it('waits for the idle boundary', async () => {
		const h = incident({ marked: [STEVE] });
		h.busy.add('crewly-orc');
		await h.service.tick();
		expect(h.relaunched).toEqual([]);
		h.busy.delete('crewly-orc');
		await h.service.tick();
		await settle();
		expect(h.store.load().overrides['crewly-orc'].runtime).toBe('claude-code');
	});

	it('never moves down the chain at an idle boundary (that is left to the next work)', async () => {
		const h = incident({ orcRuntime: STEVE, marked: ['claude-code'] });
		await h.service.tick();
		await settle();
		expect(h.store.load().overrides['crewly-orc'].runtime).toBe(STEVE);
		expect(h.relaunched).toEqual([]);
	});

	it('stays put while everything better is out', async () => {
		const h = incident();
		await h.service.tick();
		await settle();
		expect(h.store.load().overrides['crewly-orc'].runtime).toBe(STEVE);
		expect(h.relaunched).toEqual([]);
	});

	it('a restart of an orc on an exhausted account starts it on the best available target', async () => {
		const h = incident({ marked: [STEVE, 'antigravity-cli', 'codex-cli'] });
		await expect(h.service.resolveLaunch({ sessionName: 'crewly-orc', configured: 'crewly-agent', isOrchestrator: true })).resolves.toEqual({
			runtime: 'claude-code',
			overridden: true,
		});
		expect(h.store.load().overrides['crewly-orc']).toMatchObject({ runtime: 'claude-code', primary: 'crewly-agent' });
	});

	it('a restart while everything else is out keeps the current target', async () => {
		const h = incident();
		await expect(h.service.resolveLaunch({ sessionName: 'crewly-orc', configured: 'crewly-agent', isOrchestrator: true })).resolves.toEqual({
			runtime: 'claude-code',
			overridden: true,
			claudeAccount: 'steve',
		});
	});

	it('another session working on the default login clears its stale mark, and the orc moves there', async () => {
		const h = incident();
		// Ella runs on the default login (no override) and makes tool calls.
		h.service.reportWorking('dev-1');
		await settle();
		expect(h.store.load().exhausted['claude-code']).toBeUndefined();
		expect(h.store.load().exhausted[STEVE]).toBeDefined();
		await h.service.tick();
		await settle();
		expect(h.store.load().overrides['crewly-orc'].runtime).toBe('claude-code');
	});

	it('a working session on the second account clears that account only', async () => {
		const h = incident();
		h.store.save({ ...h.store.load(), overrides: { ...h.store.load().overrides, 'dev-2': { runtime: STEVE, primary: 'claude-code', reason: 'usage_limit', since: iso(T0) } } } as never);
		const service = new RuntimeFallbackService(h.deps);
		service.reportWorking('dev-2');
		await settle();
		expect(h.store.load().exhausted[STEVE]).toBeUndefined();
		expect(h.store.load().exhausted['claude-code']).toBeDefined();
	});

	it('ignores working signals within the grace after the mark, and throttles per session', async () => {
		const h = incident();
		h.store.save({ ...h.store.load(), exhausted: { ...h.store.load().exhausted, 'claude-code': mark('claude-code', { since: iso(T0 - 30_000) }) } } as never);
		const service = new RuntimeFallbackService(h.deps);
		service.reportWorking('dev-1');
		await settle();
		expect(h.store.load().exhausted['claude-code']).toBeDefined();
		h.clock.now += 3 * 60_000;
		service.reportWorking('dev-1'); // past the grace and the throttle
		await settle();
		expect(h.store.load().exhausted['claude-code']).toBeUndefined();
	});

	it('does nothing for a session on a non-Claude runtime', async () => {
		const h = incident();
		h.service.reportWorking('nova-1');
		await settle();
		expect(Object.keys(h.store.load().exhausted)).toContain('codex-cli');
	});

	it('a sign-in of the default login clears its mark when the probe answers', async () => {
		const h = incident();
		h.probe.mockResolvedValue('available');
		await h.service.onRuntimeLogin('claude-code');
		await settle();
		expect(h.probe).toHaveBeenCalledWith('claude-code');
		expect(h.store.load().exhausted['claude-code']).toBeUndefined();
		expect(h.store.load().overrides['crewly-orc'].runtime).toBe('claude-code');
	});

	it('a sign-in that finds the default login still limited keeps the mark', async () => {
		const h = incident();
		h.probe.mockResolvedValue('limited');
		await h.service.onRuntimeLogin('claude-code');
		expect(h.store.load().exhausted['claude-code']).toMatchObject({ kind: 'usage_limit' });
	});

	it('signing the second account in again clears its usage mark too (not only a sign-out)', async () => {
		const h = incident();
		h.probe.mockResolvedValue('available');
		await h.service.onAccountLogin('steve');
		await settle();
		expect(h.store.load().exhausted[STEVE]).toBeUndefined();
	});
});
