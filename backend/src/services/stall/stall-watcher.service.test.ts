/**
 * Tests for the stall watcher (crewly#1363, crewly#1362): the ladder for
 * promises, claimed work and background runs, the claim check, cooldowns,
 * the kill switch and the dry run — with a fake clock and fake collaborators.
 *
 * @module services/stall/stall-watcher.service.test
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { STALL_WATCHER_CONSTANTS as C } from '../../constants.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import type { RequestOpenItem } from '../../types/v2/open-item.types.js';
import { InFlightRunsStore } from './in-flight-runs.store.js';
import {
	StallWatcherService,
	causeText,
	contextBefore,
	durationWords,
	ladderDue,
	ownerLanguage,
	isUncardedOwnerQuestion,
	promiseOwnerLine,
	questionOwnerLine,
	runOwnerLine,
	stallWatcherDryRun,
	stallWatcherEnabled,
	type StallIncomingMessage,
	type StallSignal,
	type StallThreadMessage,
	type StallWatcherDeps,
} from './stall-watcher.service.js';

const T0 = Date.parse('2026-10-16T23:15:00Z');
const H = 3600_000;
const MIN = 60_000;

const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as StallWatcherDeps['logger'];

interface Harness {
	service: StallWatcherService;
	deps: StallWatcherDeps & {
		deliverToAgent: jest.Mock<Promise<boolean>, [string, string]>;
		notifyOwner: jest.Mock<Promise<boolean>, [string]>;
		onOwnerTold: jest.Mock<void, [string]>;
		releaseClaim: jest.Mock<Promise<void>, [string, string]>;
		recordPromiseStep: jest.Mock;
		trace: jest.Mock;
	};
	clock: { now: number };
	requests: Request[];
	items: WorkItem[];
	claims: TaskClaim[];
	threads: Map<string, StallThreadMessage[]>;
	signals: Map<string, StallSignal | null>;
	assignments: Set<string>;
	ownerThread: boolean;
}

/**
 * A watcher on fakes. `env` defaults to an armed (not dry) watcher.
 */
async function harness(dir: string, env: NodeJS.ProcessEnv = { [C.ENV_DRY_RUN]: 'false' }): Promise<Harness> {
	const clock = { now: T0 };
	const requests: Request[] = [];
	const items: WorkItem[] = [];
	const claims: TaskClaim[] = [];
	const threads = new Map<string, StallThreadMessage[]>();
	const signals = new Map<string, StallSignal | null>();
	const assignments = new Set<string>();
	const h: Partial<Harness> = { clock, requests, items, claims, threads, signals, assignments, ownerThread: true };
	const deps: Harness['deps'] = {
		listRequests: async () => requests,
		listWorkItems: async () => items,
		activeClaims: async () => claims,
		ticketLinkedWorkItemIds: async () => new Set(items.filter((w) => w.metadata?.ticketLinked === true).map((w) => w.id)),
		threadMessages: async (ref) => threads.get(`${ref.channelId}/${ref.threadId}`) ?? [],
		stallOf: async ({ workItemId }) => signals.get(workItemId) ?? null,
		releaseClaim: jest.fn(async (_workItemId: string, _reason: string) => undefined),
		deliverToAgent: jest.fn(async (_session: string, _text: string): Promise<boolean> => true),
		leadOf: async (session) => (session === 'pia' || session === 'rex' ? 'ella' : null),
		displayName: async (session) => session.charAt(0).toUpperCase() + session.slice(1),
		notifyOwner: jest.fn(async (_line: string): Promise<boolean> => true),
		onOwnerTold: jest.fn(),
		recordPromiseStep: jest.fn(async () => undefined),
		teammatesOf: async () => [
			{ name: 'Pia', session: 'pia' },
			{ name: 'Ella', session: 'ella' },
			{ name: 'Dana', session: 'dana' },
		],
		assignmentExists: async (speaker, member) => assignments.has(`${speaker}->${member}`),
		isOwnerThread: async () => h.ownerThread as boolean,
		trace: jest.fn(),
		store: new InFlightRunsStore(path.join(dir, 'in-flight-runs.json')),
		now: () => clock.now,
		env,
		logger,
	};
	const service = new StallWatcherService(deps);
	return Object.assign(h, { service, deps }) as Harness;
}

const msg = (over: Partial<StallThreadMessage> & { createdAt: number }): StallThreadMessage => ({
	id: `m-${over.createdAt}`,
	senderType: 'agent',
	senderId: 'pia',
	content: '',
	...over,
});

const promiseRequest = (item: Partial<RequestOpenItem> = {}): Request =>
	({
		id: 'req-1',
		ticketNumber: 41,
		status: 'awaiting_followup',
		chatRef: { channelId: 'ch', messageId: 'root', threadRootId: 'root' },
		openItems: [
			{
				id: 'c-1',
				type: 'commitment',
				text: '一小时内给 W41 完整版',
				agent: 'pia',
				sourceMessageId: 'p1',
				createdAt: new Date(T0).toISOString(),
				status: 'open',
				due: new Date(T0 + H).toISOString(),
				dueSource: 'text',
				...item,
			},
		],
	}) as unknown as Request;

const chineseThread = (): StallThreadMessage[] => [
	msg({ id: 'root', senderType: 'user', senderId: 'owner', content: '这个可能需要做一个教程视频？可以让 Pia 团队去做', createdAt: T0 - 10 * MIN }),
	msg({ id: 'ok', senderType: 'agent', senderId: 'ella', content: '方案可以，开始吧。', createdAt: T0 - 2 * MIN }),
	msg({ id: 'p1', senderType: 'agent', senderId: 'pia', content: '好，一小时内给 W41 完整版。', createdAt: T0 }),
];

describe('StallWatcherService', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-watcher-'));
		jest.clearAllMocks();
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	describe('switches', () => {
		it('the kill switch stops passes and messages', async () => {
			const h = await harness(dir, { [C.ENV_KILL_SWITCH]: 'false' });
			expect(h.service.enabled()).toBe(false);
			expect((await h.service.tick()).skipped).toBe('disabled');
			await h.service.onMessage({ id: 'x', channelId: 'ch', senderType: 'agent', senderId: 'rex', content: '已经开跑，预计 1 小时', createdAt: T0 });
			expect(h.service.runsOf('rex')).toEqual([]);
			h.service.start();
			h.service.stop();
		});

		it('the first pass arms the watcher and the first day is a dry run: logged, nothing sent', async () => {
			const h = await harness(dir, {});
			h.requests.push(promiseRequest());
			h.clock.now = T0 + 2 * H;
			const first = await h.service.tick();
			expect(first.dryRun).toBe(true);
			expect(first.promises.agent).toBe(1);
			expect(h.deps.deliverToAgent).not.toHaveBeenCalled();
			expect(h.deps.recordPromiseStep).not.toHaveBeenCalled();
			expect((await h.deps.store.load()).armedAt).toBe(T0 + 2 * H);
			// A day later the same promise (still open) is acted on for real: the dry-run stamps were not recorded upstream.
			h.clock.now = T0 + 2 * H + C.ARM_DELAY_MS;
			const later = new StallWatcherService({ ...h.deps, now: () => h.clock.now, env: {} });
			const second = await later.tick();
			expect(second.dryRun).toBe(false);
			// The ladder remembered the dry-run agent step (one day old) and moves to the lead.
			expect(second.promises.lead).toBe(1);
			expect(h.deps.deliverToAgent).toHaveBeenCalledWith('ella', expect.stringContaining('promised the owner'));
		});

		it('stallWatcherDryRun honours the env override and the arm delay', () => {
			expect(stallWatcherDryRun(undefined, T0, {})).toBe(true);
			expect(stallWatcherDryRun(T0 - C.ARM_DELAY_MS + 1, T0, {})).toBe(true);
			expect(stallWatcherDryRun(T0 - C.ARM_DELAY_MS, T0, {})).toBe(false);
			expect(stallWatcherDryRun(T0 - C.ARM_DELAY_MS, T0, { [C.ENV_DRY_RUN]: 'true' })).toBe(true);
			expect(stallWatcherDryRun(undefined, T0, { [C.ENV_DRY_RUN]: 'false' })).toBe(false);
			expect(stallWatcherEnabled({})).toBe(true);
			expect(stallWatcherEnabled({ [C.ENV_KILL_SWITCH]: 'FALSE' })).toBe(false);
		});
	});

	describe('promises to the owner (Pia, 2026-10-16 23:15Z)', () => {
		it('climbs agent (1.5×, with the approval context) → lead (3×) → owner (lead grace), once each, then once a day', async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest());
			h.threads.set('ch/root', chineseThread());

			h.clock.now = T0 + H + 20 * MIN; // under 1.5×
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });

			h.clock.now = T0 + 90 * MIN;
			expect((await h.service.tick()).promises).toEqual({ agent: 1, lead: 0, owner: 0 });
			const [agent, text] = h.deps.deliverToAgent.mock.calls[0];
			expect(agent).toBe('pia');
			expect(text).toMatch(/^\[STALL\] You told the owner "一小时内给 W41 完整版" 1\.5 hours ago and gave yourself about 1 hour/);
			expect(text).toContain('Context — the last message before your promise (Ella): "方案可以，开始吧。"');
			expect(text).toContain('do not wait for another');
			expect(h.deps.recordPromiseStep).toHaveBeenCalledWith('req-1', 'c-1', 'agent', new Date(T0 + 90 * MIN));
			expect(h.deps.trace).toHaveBeenCalledWith(expect.objectContaining({ session: 'pia', data: expect.objectContaining({ step: 'agent' }) }));

			h.clock.now = T0 + 2 * H + 59 * MIN; // under 3×, and the agent is not nudged twice
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });

			h.clock.now = T0 + 3 * H;
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 1, owner: 0 });
			expect(h.deps.deliverToAgent).toHaveBeenLastCalledWith('ella', expect.stringMatching(/^\[STALL\] Pia promised the owner "一小时内给 W41 完整版" 3 hours ago \(estimate 1 hour\)/));
			expect(h.deps.recordPromiseStep).toHaveBeenCalledWith('req-1', 'c-1', 'lead', new Date(T0 + 3 * H));

			h.clock.now = T0 + 3 * H + 29 * MIN; // inside the lead's grace
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
			expect(h.deps.notifyOwner).not.toHaveBeenCalled();

			h.clock.now = T0 + 3 * H + 30 * MIN;
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 1 });
			expect(h.deps.notifyOwner).toHaveBeenCalledTimes(1);
			// #1387: the stalled agent is reported once for the weekly owner-pulls count.
			expect(h.deps.onOwnerTold).toHaveBeenCalledTimes(1);
			expect(h.deps.onOwnerTold).toHaveBeenCalledWith('pia');
			expect(h.deps.notifyOwner.mock.calls[0][0]).toBe('Pia 说大约 1 小时 内给「一小时内给 W41 完整版」，现在过了 3.5 小时 还没有，已经提醒过 Pia，也问了 Ella。');
			expect(h.deps.recordPromiseStep).toHaveBeenCalledWith('req-1', 'c-1', 'owner', new Date(T0 + 3 * H + 30 * MIN));

			h.clock.now = T0 + 10 * H; // not again the same day
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
			h.clock.now = T0 + 3 * H + 30 * MIN + C.OWNER_LINE_INTERVAL_MS; // one line per day
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 1 });
			expect(h.deps.deliverToAgent).toHaveBeenCalledTimes(2);
		});

		it('the owner line is English when the owner wrote in English', async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest({ text: 'full W41 version within the hour' }));
			h.threads.set('ch/root', [msg({ id: 'root', senderType: 'user', senderId: 'owner', content: 'Can your team make a tutorial video?', createdAt: T0 - MIN })]);
			for (const at of [T0 + 90 * MIN, T0 + 3 * H, T0 + 3 * H + 30 * MIN]) {
				h.clock.now = at;
				await h.service.tick();
			}
			expect(h.deps.notifyOwner.mock.calls[0][0]).toBe('Pia said "full W41 version within the hour" would come in about 1 hour; 3.5 hours later nothing has arrived. Pia has been reminded and I asked Ella.');
		});

		it('the owner is not told when the lead answered in the thread', async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest());
			h.threads.set('ch/root', chineseThread());
			h.clock.now = T0 + 90 * MIN;
			await h.service.tick();
			h.clock.now = T0 + 3 * H;
			await h.service.tick();
			h.threads.set('ch/root', [...chineseThread(), msg({ id: 'lead-reply', senderId: 'ella', content: '我来跟，Pia 的渲染挂了，重跑中。', createdAt: T0 + 3 * H + 5 * MIN })]);
			h.clock.now = T0 + 3 * H + 30 * MIN;
			expect((await h.service.tick()).promises.owner).toBe(0);
			expect(h.deps.notifyOwner).not.toHaveBeenCalled();
		});

		it('a short estimate still waits the 20-minute floor', async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest({ due: new Date(T0 + 5 * MIN).toISOString() }));
			h.clock.now = T0 + 8 * MIN;
			expect((await h.service.tick()).promises.agent).toBe(0);
			h.clock.now = T0 + 20 * MIN;
			expect((await h.service.tick()).promises.agent).toBe(1);
		});

		it("respects the open-items sweep's nudge for the cooldown and its stamps as steps taken", async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest({ nudgedAt: new Date(T0 + 85 * MIN).toISOString(), status: 'overdue' }));
			h.clock.now = T0 + 90 * MIN;
			expect((await h.service.tick()).promises.agent).toBe(0); // the sweep nudged 5 min ago
			h.clock.now = T0 + 85 * MIN + C.NUDGE_COOLDOWN_MS;
			expect((await h.service.tick()).promises.agent).toBe(1);

			const told = await harness(dir);
			told.requests.push(promiseRequest({ stallNudgedAt: new Date(T0 + 90 * MIN).toISOString(), leadNotifiedAt: new Date(T0 + 3 * H).toISOString(), ownerNotifiedAt: new Date(T0 + 3 * H + 30 * MIN).toISOString() }));
			told.clock.now = T0 + 5 * H;
			expect((await told.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
			expect(told.deps.deliverToAgent).not.toHaveBeenCalled();
			expect(told.deps.notifyOwner).not.toHaveBeenCalled();
		});

		it('skips delivered, cancelled, waiting-on-owner and undated items', async () => {
			const h = await harness(dir);
			h.requests.push(
				promiseRequest({ status: 'delivered' }),
				{ ...promiseRequest({ status: 'waiting_owner' }), id: 'req-2' } as Request,
				{ ...promiseRequest({ due: undefined }), id: 'req-3' } as Request,
				{ ...promiseRequest(), id: 'req-4', status: 'cancelled' } as Request,
			);
			h.clock.now = T0 + 10 * H;
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
		});
	});

	describe('owner questions asked in prose (crewly#1369)', () => {
		const question = (over: Partial<RequestOpenItem> = {}): Request =>
			promiseRequest({ id: 'q-1', type: 'question', text: 'Should I close PR #1138?', ownerQuestion: true, due: new Date(T0 + 24 * H).toISOString(), dueSource: 'default', ...over });

		it('climbs agent (make it a card) → lead → the owner gets the question once', async () => {
			const h = await harness(dir);
			h.requests.push(question());
			h.threads.set('ch/root', [msg({ id: 'root', senderType: 'user', senderId: 'owner', content: 'What is left on the Gmail work?', createdAt: T0 - MIN })]);
			h.clock.now = T0 + 30 * H;
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
			h.clock.now = T0 + 36 * H;
			expect((await h.service.tick()).promises.agent).toBe(1);
			expect(h.deps.deliverToAgent.mock.calls[0][1]).toMatch(/^\[STALL\] You asked the owner "Should I close PR #1138\?" 36 hours ago and no answer is on file\./);
			expect(h.deps.deliverToAgent.mock.calls[0][1]).toContain('decision card (ask-owner)');
			expect(h.deps.recordPromiseStep).toHaveBeenCalledWith('req-1', 'q-1', 'agent', new Date(T0 + 36 * H));
			h.clock.now = T0 + 72 * H;
			expect((await h.service.tick()).promises.lead).toBe(1);
			expect(h.deps.deliverToAgent).toHaveBeenLastCalledWith('ella', expect.stringContaining('Pia asked the owner "Should I close PR #1138?"'));
			h.clock.now = T0 + 72 * H + 30 * MIN;
			expect((await h.service.tick()).promises.owner).toBe(1);
			expect(h.deps.notifyOwner.mock.calls[0][0]).toBe('Pia asked you 3 days ago: "Should I close PR #1138?" — there is no answer from you yet. One line is enough, or say "skip".');
		});

		it('carded, answered, plain and undated questions are not followed up here', async () => {
			const h = await harness(dir);
			h.requests.push(
				question({ decisionId: 'D-1' }),
				{ ...question({ status: 'resolved' }), id: 'req-2' } as Request,
				{ ...question({ ownerQuestion: undefined }), id: 'req-3' } as Request,
				{ ...question({ due: undefined }), id: 'req-4' } as Request,
			);
			h.clock.now = T0 + 100 * H;
			expect((await h.service.tick()).promises).toEqual({ agent: 0, lead: 0, owner: 0 });
		});

		it('helpers', () => {
			expect(isUncardedOwnerQuestion({ type: 'question', ownerQuestion: true, due: 'x' } as RequestOpenItem)).toBe(true);
			expect(isUncardedOwnerQuestion({ type: 'commitment', ownerQuestion: true, due: 'x' } as RequestOpenItem)).toBe(false);
			expect(questionOwnerLine('zh', { name: 'Ella', what: '要不要关掉 PR #1138？', elapsedMs: 36 * H })).toBe('Ella 36 小时前问你：「要不要关掉 PR #1138？」还没有你的回答。回一句就行，或者说「不用了」。');
		});
	});

	describe('claimed WorkItems', () => {
		const running = (): WorkItem => ({ id: 'wi-1', title: 'Cut the 9:16 version', status: 'running', target: 'pia', createdAt: new Date(T0).toISOString() }) as unknown as WorkItem;
		const claim = (): TaskClaim => ({ id: 'cl-1', workItemId: 'wi-1', agentId: 'pia', status: 'active', claimedAt: new Date(T0).toISOString() }) as TaskClaim;

		it('nudges the claimer with the cause, then releases the claim and tells the lead after a second window', async () => {
			const h = await harness(dir);
			h.items.push(running());
			h.claims.push(claim());
			h.signals.set('wi-1', { ms: 31 * MIN, cause: 'runtime_quota', detail: 'Claude usage limit reached' });
			h.clock.now = T0 + 31 * MIN;
			expect((await h.service.tick()).claims).toEqual({ nudged: 1, released: 0 });
			expect(h.deps.deliverToAgent).toHaveBeenCalledWith('pia', '[STALL] Work item wi-1 ("Cut the 9:16 version") has shown no progress for 31 min — runtime out of usage or signed out (Claude usage limit reached). Continue it now, or release it with a one-line reason.');

			h.signals.set('wi-1', { ms: 45 * MIN, cause: 'runtime_quota', detail: 'Claude usage limit reached' });
			h.clock.now = T0 + 45 * MIN;
			expect((await h.service.tick()).claims).toEqual({ nudged: 0, released: 0 });

			h.signals.set('wi-1', { ms: 61 * MIN, cause: 'nobody_pushing', detail: 'Nothing was open and nobody was working' });
			h.clock.now = T0 + 61 * MIN;
			expect((await h.service.tick()).claims).toEqual({ nudged: 0, released: 1 });
			expect(h.deps.releaseClaim).toHaveBeenCalledWith('wi-1', expect.stringContaining('no progress for 61 min after a reminder'));
			expect(h.deps.deliverToAgent).toHaveBeenLastCalledWith('ella', expect.stringMatching(/^\[STALL\] Pia's work item wi-1 .* claim was released and it is queued again, unassigned/));
			expect(h.deps.trace).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'wi-1', data: expect.objectContaining({ step: 'lead' }) }));

			h.clock.now = T0 + 2 * H; // nothing more from the watcher
			expect((await h.service.tick()).claims).toEqual({ nudged: 0, released: 0 });
		});

		it('a stall under the threshold, a stall waiting on the owner, a ticket-linked item or no trace does nothing', async () => {
			const h = await harness(dir);
			h.items.push(running());
			h.claims.push(claim());
			h.clock.now = T0 + H;
			h.signals.set('wi-1', { ms: 10 * MIN, cause: 'nobody_pushing', detail: '' });
			expect((await h.service.tick()).claims.nudged).toBe(0);
			h.signals.set('wi-1', { ms: 2 * H, cause: 'waiting_on_owner', detail: 'D-7 open' });
			expect((await h.service.tick()).claims.nudged).toBe(0);
			h.signals.set('wi-1', null);
			expect((await h.service.tick()).claims.nudged).toBe(0);
			h.items[0] = { ...running(), metadata: { ticketLinked: true } } as unknown as WorkItem;
			h.signals.set('wi-1', { ms: 2 * H, cause: 'nobody_pushing', detail: '' });
			expect((await h.service.tick()).claims.nudged).toBe(0);
			expect(h.deps.deliverToAgent).not.toHaveBeenCalled();
		});

		it('progress clears the ladder so a later stall starts a fresh cycle', async () => {
			const h = await harness(dir);
			h.items.push(running());
			h.claims.push(claim());
			h.signals.set('wi-1', { ms: 40 * MIN, cause: 'nobody_pushing', detail: '' });
			h.clock.now = T0 + 40 * MIN;
			expect((await h.service.tick()).claims.nudged).toBe(1);
			h.signals.set('wi-1', null);
			h.clock.now = T0 + 50 * MIN;
			await h.service.tick();
			h.signals.set('wi-1', { ms: 35 * MIN, cause: 'nobody_pushing', detail: '' });
			h.clock.now = T0 + 2 * H;
			expect((await h.service.tick()).claims).toEqual({ nudged: 1, released: 0 });
		});
	});

	describe('background runs (Rex, 2026-10-17 14:44Z)', () => {
		const announce = (over: Partial<StallIncomingMessage> = {}): StallIncomingMessage => ({
			id: 'rex-1',
			channelId: 'room',
			senderType: 'agent',
			senderId: 'rex',
			content: '已经开跑了，预计 1 小时左右出结果。',
			createdAt: T0,
			...over,
		});

		it('registers a run from the announcement and protects the agent until expectedBy + grace', async () => {
			const h = await harness(dir);
			await h.service.onMessage(announce());
			const runs = h.service.runsOf('rex');
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ id: 'rex-1', channelId: 'room', threadId: 'rex-1', estimateMs: H, estimateSource: 'text', expectedBy: T0 + H });
			expect(h.service.protectedRunReason('rex')).toMatch(/a background run it announced \("已经开跑了，预计 1 小时左右出结果。"\) is expected by 2026-10-17T00:15:00.000Z/);
			h.clock.now = T0 + H + C.RUN_PROTECTION_GRACE_MS - 1;
			expect(h.service.protectedRunReason('rex')).not.toBeNull();
			h.clock.now = T0 + H + C.RUN_PROTECTION_GRACE_MS;
			expect(h.service.protectedRunReason('rex')).toBeNull();
			expect(h.service.protectedRunReason('pia')).toBeNull();
			// Persisted.
			expect((await h.deps.store.load()).runs).toHaveLength(1);
		});

		it('registers jobs submitted to an outside generator with no duration at the default estimate (crewly#1386)', async () => {
			const h = await harness(dir);
			await h.service.onMessage(announce({ id: 'pia-1', senderId: 'pia', content: '三条片段已经提交到 Flow 了，作为第 3 步的预览。让它们跑完，对比后看差多少。' }));
			const runs = h.service.runsOf('pia');
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ id: 'pia-1', estimateMs: C.RUN_DEFAULT_ESTIMATE_MS, estimateSource: 'default', expectedBy: T0 + C.RUN_DEFAULT_ESTIMATE_MS });
		});

		it('ignores interim marks, posts without a duration, and a second announcement in the same thread', async () => {
			const h = await harness(dir);
			await h.service.onMessage(announce({ metadata: { interim: true } }));
			await h.service.onMessage(announce({ id: 'rex-0', content: 'Kicked off the render.' }));
			expect(h.service.runsOf('rex')).toEqual([]);
			await h.service.onMessage(announce());
			await h.service.onMessage(announce({ id: 'rex-2', threadId: 'rex-1', content: '第二段也开跑了，预计 30 分钟', createdAt: T0 + MIN }));
			expect(h.service.runsOf('rex')).toHaveLength(1);
		});

		it("the agent's own post with a file, a link or a finished / failed report closes the run", async () => {
			const h = await harness(dir);
			await h.service.onMessage(announce());
			await h.service.onMessage(announce({ id: 'rex-3', threadId: 'rex-1', content: '还在跑', createdAt: T0 + 10 * MIN }));
			expect(h.service.runsOf('rex')).toHaveLength(1);
			await h.service.onMessage(announce({ id: 'rex-4', threadId: 'rex-1', content: '出来了', createdAt: T0 + 50 * MIN, attachmentCount: 1 }));
			expect(h.service.runsOf('rex')).toEqual([]);
			await h.service.onMessage(announce({ id: 'rex-5', createdAt: T0 + H }));
			await h.service.onMessage(announce({ id: 'rex-6', threadId: 'rex-5', content: '渲染挂了，我重跑。', createdAt: T0 + H + MIN }));
			expect(h.service.runsOf('rex')).toEqual([]);
		});

		it('climbs the ladder when nothing lands in the thread, and clears when the thread shows the result', async () => {
			const h = await harness(dir);
			await h.service.onMessage(announce());
			h.threads.set('room/rex-1', [msg({ id: 'rex-1', senderId: 'rex', content: '已经开跑了，预计 1 小时左右出结果。', createdAt: T0 })]);
			h.clock.now = T0 + H + 10 * MIN;
			expect((await h.service.tick()).runs).toEqual({ agent: 0, lead: 0, owner: 0, cleared: 0 });
			h.clock.now = T0 + 90 * MIN;
			expect((await h.service.tick()).runs).toEqual({ agent: 1, lead: 0, owner: 0, cleared: 0 });
			expect(h.deps.deliverToAgent).toHaveBeenCalledWith('rex', expect.stringMatching(/^\[STALL\] You said "已经开跑了，预计 1 小时左右出结果。" 1\.5 hours ago \(estimate 1 hour\)/));
			h.clock.now = T0 + 3 * H;
			expect((await h.service.tick()).runs).toEqual({ agent: 0, lead: 1, owner: 0, cleared: 0 });
			expect(h.deps.deliverToAgent).toHaveBeenLastCalledWith('ella', expect.stringContaining('Rex said "已经开跑了，预计 1 小时左右出结果。"'));
			h.clock.now = T0 + 3 * H + 30 * MIN;
			expect((await h.service.tick()).runs).toEqual({ agent: 0, lead: 0, owner: 1, cleared: 0 });
			expect(h.deps.notifyOwner).toHaveBeenCalledWith('Rex said "已经开跑了，预计 1 小时左右出结果。" (about 1 hour); 3.5 hours later there is no result in the thread. Rex has been reminded and I asked Ella.');
			// The result arrives (read from the thread, e.g. posted through Slack): the record goes.
			h.threads.set('room/rex-1', [...(h.threads.get('room/rex-1') ?? []), msg({ id: 'rex-9', senderId: 'rex', content: 'https://drive.google.com/file/d/abc', createdAt: T0 + 4 * H })]);
			h.clock.now = T0 + 5 * H;
			expect((await h.service.tick()).runs).toEqual({ agent: 0, lead: 0, owner: 0, cleared: 1 });
			expect(h.service.runsOf('rex')).toEqual([]);
		});
	});

	describe('"X is doing it" (Ella, 2026-10-16 23:54Z)', () => {
		const ellaSays = (content = '对，视频已经是 Pia 在做了，录屏 + AI 配音，75 秒。'): StallIncomingMessage => ({
			id: 'ella-1',
			channelId: 'mk',
			threadId: 'root',
			senderType: 'agent',
			senderId: 'ella',
			content,
			createdAt: T0,
		});

		it('tells the speaker once when nothing is assigned to the teammate within the window; never the owner', async () => {
			const h = await harness(dir);
			await h.service.onMessage(ellaSays());
			h.clock.now = T0 + 5 * MIN;
			expect((await h.service.tick()).teammateClaims).toEqual({ checked: 0, nudged: 0 });
			h.clock.now = T0 + C.CLAIM_CHECK_WINDOW_MS;
			expect((await h.service.tick()).teammateClaims).toEqual({ checked: 1, nudged: 1 });
			expect(h.deps.deliverToAgent).toHaveBeenCalledTimes(1);
			expect(h.deps.deliverToAgent).toHaveBeenCalledWith('ella', expect.stringMatching(/^\[CLAIM-CHECK\] You told the owner Pia is doing it \("对，视频已经是 Pia 在做了，录屏 \+ AI 配音，75 秒。"\); nothing is assigned to Pia/));
			expect(h.deps.notifyOwner).not.toHaveBeenCalled();
			expect(h.deps.trace).toHaveBeenCalledWith(expect.objectContaining({ session: 'ella', data: expect.objectContaining({ reason: 'claim_check', member: 'pia' }) }));
			h.clock.now = T0 + 2 * C.CLAIM_CHECK_WINDOW_MS;
			expect((await h.service.tick()).teammateClaims).toEqual({ checked: 0, nudged: 0 });
		});

		it('stays quiet when a WorkItem or ticket for the teammate exists', async () => {
			const h = await harness(dir);
			h.assignments.add('ella->pia');
			await h.service.onMessage(ellaSays());
			h.clock.now = T0 + C.CLAIM_CHECK_WINDOW_MS;
			expect((await h.service.tick()).teammateClaims).toEqual({ checked: 1, nudged: 0 });
			expect(h.deps.deliverToAgent).not.toHaveBeenCalled();
		});

		it('ignores claims outside owner threads, unknown names, and the same claim said twice', async () => {
			const h = await harness(dir);
			h.ownerThread = false;
			await h.service.onMessage(ellaSays());
			h.ownerThread = true;
			await h.service.onMessage(ellaSays('Rex 在做。'));
			await h.service.onMessage({ ...ellaSays(), id: 'ella-2', createdAt: T0 + MIN });
			await h.service.onMessage({ ...ellaSays(), id: 'ella-3', createdAt: T0 + 2 * MIN });
			h.clock.now = T0 + C.CLAIM_CHECK_WINDOW_MS + 2 * MIN;
			expect((await h.service.tick()).teammateClaims).toEqual({ checked: 1, nudged: 1 });
		});

		it('one nudge per agent per cooldown, whatever the kind (two promises → the second waits)', async () => {
			const h = await harness(dir);
			h.requests.push(promiseRequest(), { ...promiseRequest({ id: 'c-2', text: '9:16 版也一起给' }), id: 'req-2' } as Request);
			h.clock.now = T0 + 90 * MIN;
			expect((await h.service.tick()).promises.agent).toBe(1);
			h.clock.now = T0 + 90 * MIN + C.NUDGE_COOLDOWN_MS - MIN;
			expect((await h.service.tick()).promises.agent).toBe(0);
			h.clock.now = T0 + 90 * MIN + C.NUDGE_COOLDOWN_MS;
			expect((await h.service.tick()).promises.agent).toBe(1);
			expect(h.deps.deliverToAgent).toHaveBeenCalledTimes(2);
			expect(h.deps.deliverToAgent.mock.calls.every(([to]) => to === 'pia')).toBe(true);
		});
	});

	describe('helpers', () => {
		it('durationWords in both languages', () => {
			expect(durationWords(40 * MIN)).toBe('40 minutes');
			expect(durationWords(MIN)).toBe('1 minute');
			expect(durationWords(90 * MIN)).toBe('1.5 hours');
			expect(durationWords(H)).toBe('1 hour');
			expect(durationWords(3 * 24 * H)).toBe('3 days');
			expect(durationWords(40 * MIN, 'zh')).toBe('40 分钟');
			expect(durationWords(2 * H, 'zh')).toBe('2 小时');
			expect(durationWords(2 * 24 * H, 'zh')).toBe('2 天');
		});

		it('ownerLanguage reads the owner, not the agents', () => {
			expect(ownerLanguage([msg({ senderType: 'user', senderId: 'o', content: '这个要做视频', createdAt: 1 }), msg({ content: 'Working on it now, ETA one hour.', createdAt: 2 })])).toBe('zh');
			expect(ownerLanguage([msg({ senderType: 'user', senderId: 'o', content: 'Please make the video', createdAt: 1 })])).toBe('en');
			expect(ownerLanguage([])).toBe('en');
		});

		it('contextBefore is the last non-agent, non-system message before the promise', () => {
			const thread = chineseThread();
			expect(contextBefore(thread, 'pia', T0)?.id).toBe('ok');
			expect(contextBefore([...thread, msg({ id: 'sys', senderType: 'system', senderId: 'crewly', content: 'note', createdAt: T0 - MIN })], 'pia', T0)?.id).toBe('ok');
			expect(contextBefore(thread, 'ella', T0 - 5 * MIN)?.id).toBe('root');
			expect(contextBefore([], 'pia', T0)).toBeNull();
		});

		it('ladderDue applies the multipliers and the floor', () => {
			expect(ladderDue(T0, H)).toEqual({ agentDue: T0 + 90 * MIN, leadDue: T0 + 3 * H });
			expect(ladderDue(T0, 5 * MIN)).toEqual({ agentDue: T0 + 20 * MIN, leadDue: T0 + 50 * MIN });
		});

		it('causeText and the owner lines', () => {
			expect(causeText({ ms: 1, cause: 'nobody_pushing', detail: 'nobody pushing' })).toBe('nobody pushing');
			expect(causeText({ ms: 1, cause: 'delivery_failure', detail: 'write failed' })).toBe('a message was not delivered (write failed)');
			expect(promiseOwnerLine('zh', { name: 'Pia', what: 'W41', estimateMs: H, elapsedMs: 3 * H, leadName: null })).toContain('团队里没有负责人可问');
			expect(promiseOwnerLine('en', { name: 'Pia', what: 'W41', estimateMs: H, elapsedMs: 3 * H, leadName: null })).toContain('there is no team lead to ask');
			expect(runOwnerLine('zh', { name: 'Rex', head: '开跑', estimateMs: H, elapsedMs: 3 * H, leadName: 'Ella' })).toBe('Rex 说「开跑」大约 1 小时，现在过了 3 小时 还没有结果，已经提醒过 Rex，也问了 Ella。');
		});
	});
});
