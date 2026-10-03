/**
 * End-to-end propagation of a run trace through the real services:
 *
 *   owner ticket → orchestrator turn → delegate (task pool add) → claim →
 *   [CREWLY-DISPATCH] brief with the trace header → worker turn → skill call
 *   → usage entry; auto-claim → redelivered brief → worker turn; and status
 *   reports routed to the orchestrator / a team lead carry the trace.
 *
 * Only the HTTP write to the agent terminal is replaced: the mock hands the
 * text to `noteTurnDelivery`, exactly what `/terminal/:s/write` does.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { TraceStore, setTraceStoreForTesting } from './trace-store.js';
import { getTraceContext, setTraceContextForTesting } from './trace-context.service.js';
import { noteTurnDelivery } from './trace-recorder.js';
import { traceHttpMiddleware } from './trace-http.middleware.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { RequestService } from '../v3/request.service.js';
import { WorkItemDispatchSubscriber } from '../v3/workitem-dispatch.subscriber.js';
import { AgentAutoClaimService } from '../v3/agent-auto-claim.service.js';
import { OrcStatusRouterService } from '../orc/orc-status-router.service.js';
import { OrcWakeCounter } from '../orc/orc-wake-counter.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import type { EnqueueMessageInput } from '../../types/messaging.types.js';
import type { Team } from '../../types/index.js';

const writes: Array<{ session: string; data: string }> = [];

jest.mock('axios', () => ({
	__esModule: true,
	default: {
		post: jest.fn(async (url: string, body: { data?: string }) => {
			const m = /\/api\/terminal\/([^/]+)\/write$/.exec(url);
			if (m && typeof body?.data === 'string') {
				const session = decodeURIComponent(m[1]);
				writes.push({ session, data: body.data });
				// What /terminal/:s/write does after a successful message-mode write.
				noteTurnDelivery(session, body.data, 'pty');
			}
			return { data: { success: true } };
		}),
		get: jest.fn(async () => ({ data: {} })),
	},
}));

describe('run trace propagation', () => {
	let dir: string;
	let store: TraceStore;
	let pool: TaskPoolService;

	const eventsOf = async (id: string) => (await store.read(id, 0, 1000))!.events;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-prop-'));
		store = new TraceStore({ dir: path.join(dir, 'traces'), indexFlushDelayMs: 5 });
		setTraceStoreForTesting(store);
		setTraceContextForTesting(null);
		writes.length = 0;
		RequestService.resetInstance();
		RequestService.getInstance(path.join(dir, 'project'));
		TaskPoolService.resetInstance();
		pool = TaskPoolService.getInstance();
		WorkItemDispatchSubscriber.resetInstance();
		WorkItemDispatchSubscriber.getInstance().setTaskConversationPreparer({
			prepareForTask: async () => ({ cleared: false }),
		} as unknown as Parameters<WorkItemDispatchSubscriber['setTaskConversationPreparer']>[0]);
		AgentAutoClaimService.resetInstance();
		TokenUsageService.resetInstance();
	});

	afterEach(async () => {
		await pool.destroy().catch(() => undefined);
		TaskPoolService.resetInstance();
		RequestService.resetInstance();
		WorkItemDispatchSubscriber.resetInstance();
		AgentAutoClaimService.resetInstance();
		TokenUsageService.resetInstance();
		await store.flush();
		setTraceStoreForTesting(null);
		setTraceContextForTesting(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('carries one id from an owner ticket through delegate, dispatch, the worker turn, a skill call and usage', async () => {
		// 1. Ticket intake turns the owner's message into a Request: the root.
		const ticket = await RequestService.getInstance().create({
			sourceConversationItemId: 'slack-1',
			title: 'Build the pricing page',
			description: 'Build the pricing page',
			ticketNumber: 1,
			origin: { channel: 'slack-dm', ref: 'slack-1', author: 'U1' },
		});
		const traceId = ticket.traceId!;
		expect(traceId).toMatch(/^tr-\d{8}-[0-9a-f]{8}$/);

		// 2. The orchestrator's turn is about that ticket.
		noteTurnDelivery('crewly-orc', `[CHAT:c1:abcd1234] [TICKET:TKT-001 ${ticket.id}] Build the pricing page`, 'pty');
		expect(getTraceContext().currentTrace('crewly-orc')).toBe(traceId);

		// 3. delegate-task: /task-pool/add with the orc's session, then claim.
		const wi = createWorkItem({ type: 'delegate', owner: 'orchestrator', target: 'dev-1', title: 'Pricing page', metadata: { delegatedBy: 'crewly-orc' } });
		await pool.addToPool(wi, { creatorSession: 'crewly-orc' });
		expect(wi.traceId).toBe(traceId);
		expect(await pool.claimSpecificItem('dev-1', wi.id)).not.toBeNull();
		const stored = (await pool.findWorkItem(wi.id))!;
		expect(stored.traceId).toBe(traceId);

		// 4. The brief carries the trace in its header; the worker's turn joins it.
		expect(await WorkItemDispatchSubscriber.getInstance().dispatchTo(stored)).toBe(true);
		const brief = writes.find((w) => w.session === 'dev-1')!;
		expect(brief.data).toContain(`  Trace: [TRACE:${traceId}]`);
		expect(getTraceContext().currentTrace('dev-1')).toBe(traceId);

		// 5. A skill call from the worker is attributed without any skill change.
		const app = express();
		app.use(express.json());
		const router = express.Router();
		router.use(traceHttpMiddleware);
		router.get('/task-pool/:id', (_req, res) => res.json({ success: true }));
		app.use('/api', router);
		await request(app).get(`/api/task-pool/${wi.id}`).set('X-Agent-Session', 'dev-1').expect(200);

		// 6. Usage the worker spends is tagged.
		TokenUsageService.getInstance().recordUsage('dev-1', 'dev-1', 5000, 300, 'claude-sonnet-5');
		const usage: Array<{ traceId?: string }> = [];
		TokenUsageService.getInstance().forEachEvent((_s, e) => usage.push(e));
		expect(usage[0].traceId).toBe(traceId);

		const evs = await eventsOf(traceId);
		const types = evs.map((e) => e.type);
		expect(types[0]).toBe('trace.root');
		expect(types).toEqual(expect.arrayContaining(['request.created', 'turn.delivered', 'workitem.created', 'workitem.status', 'skill.call', 'usage']));
		expect(evs.find((e) => e.type === 'workitem.status')).toMatchObject({ data: { from: 'queued', to: 'running' }, actor: { kind: 'agent', session: 'dev-1' } });
		expect(evs.filter((e) => e.type === 'turn.delivered').map((e) => [e.refs.session, e.data?.kind])).toEqual([
			['crewly-orc', 'owner_message'],
			['dev-1', 'dispatch'],
		]);
		expect(store.list()).toHaveLength(1);
		expect(store.traceByRef('workItem', wi.id)).toBe(traceId);
	});

	it('an untraced owner message becomes the root when the orchestrator delegates', async () => {
		noteTurnDelivery('crewly-orc', '[CHAT:c1:abcd1234] Please fix the login bug', 'pty');
		expect(store.list()).toHaveLength(0);
		const wi = createWorkItem({ type: 'delegate', owner: 'orchestrator', target: 'dev-1', title: 'Fix login', metadata: { delegatedBy: 'crewly-orc' } });
		await pool.addToPool(wi, { creatorSession: 'crewly-orc' });
		const [entry] = store.list();
		expect(entry.root).toMatchObject({ kind: 'owner_message', summary: 'Please fix the login bug', actor: { kind: 'owner' } });
		expect(wi.traceId).toBe(entry.traceId);
	});

	it('auto-claim delivers the brief with the trace and the worker turn joins it', async () => {
		const ticket = await RequestService.getInstance().create({
			sourceConversationItemId: 'chat-2',
			title: 'Write the release notes',
			description: 'Write the release notes',
			ticketNumber: 2,
			origin: { channel: 'chat', ref: 'chat-2', author: 'owner' },
		});
		const traceId = ticket.traceId!;
		// Queued by the system with only the ticket link (no creator session).
		const wi = createWorkItem({ type: 'delegate', owner: 'system', target: 'dev-2', title: 'Release notes', requestId: ticket.id });
		await pool.addToPool(wi);
		expect(wi.traceId).toBe(traceId);

		const result = await AgentAutoClaimService.getInstance().tryAutoClaimForAgent('dev-2');
		expect(result?.workItemId).toBe(wi.id);
		const brief = writes.find((w) => w.session === 'dev-2')!;
		expect(brief.data).toContain(`[TRACE:${traceId}]`);
		expect(getTraceContext().currentTrace('dev-2')).toBe(traceId);

		const types = (await eventsOf(traceId)).map((e) => e.type);
		expect(types).toEqual(expect.arrayContaining(['workitem.created', 'workitem.status', 'harness.redelivery', 'turn.delivered']));
	});

	it('status reports routed to the orchestrator or a team lead carry the trace id', async () => {
		const ticket = await RequestService.getInstance().create({
			sourceConversationItemId: 'slack-3',
			title: 'Ship the SEO fixes',
			description: 'Ship the SEO fixes',
			ticketNumber: 3,
			origin: { channel: 'slack-dm', ref: 'slack-3', author: 'U1' },
		});
		const traceId = ticket.traceId!;
		const wi = createWorkItem({ type: 'delegate', owner: 'orchestrator', target: 'dev-3', title: 'SEO fixes', requestId: ticket.id, metadata: { delegatedBy: 'crewly-orc' } });
		await pool.addToPool(wi);
		await pool.claimSpecificItem('dev-3', wi.id);

		const queued: EnqueueMessageInput[] = [];
		const team = { id: 't1', name: 'Web', members: [
			{ id: 'm1', name: 'Lead', sessionName: 'tl-3', role: 'team-leader' },
			{ id: 'm2', name: 'Dev', sessionName: 'dev-3', role: 'developer' },
		] } as unknown as Team;
		const router = new OrcStatusRouterService({
			enqueue: (input) => queued.push(input),
			poolItems: () => pool.getAllItems(),
			teams: async () => [team],
			isOrchestrator: (name) => name === 'crewly-orc',
			now: () => Date.now(),
			counter: new OrcWakeCounter(),
		});

		// [DONE] on orc-delegated work wakes the orchestrator.
		const done = await router.route({ content: '[DONE] SEO fixes shipped', sender: 'dev-3', conversationId: 'c1', workItemId: wi.id, deliveryOwed: false, orcText: '[DONE] SEO fixes shipped' });
		expect(done.action).toBe('orc');
		// [BLOCKED] goes to the team lead first.
		const blocked = await router.route({ content: '[BLOCKED] need GSC access', sender: 'dev-3', conversationId: 'c1', workItemId: wi.id, deliveryOwed: false, orcText: '[BLOCKED] need GSC access' });
		expect(blocked.action).toBe('team-lead');
		router.stop();

		expect(queued).toHaveLength(2);
		for (const q of queued) expect(q.content.endsWith(`[TRACE:${traceId}]`)).toBe(true);
		expect(queued[0].content.startsWith('Agent status: [DONE]')).toBe(true);

		// When the queue delivers it, the orchestrator's turn joins the trace.
		noteTurnDelivery('crewly-orc', `[CHAT:c1:abcd1234] ${queued[0].content}`, 'pty');
		expect(getTraceContext().currentTrace('crewly-orc')).toBe(traceId);
		const evs = await eventsOf(traceId);
		expect(evs.filter((e) => e.type === 'status.routed').map((e) => e.data?.route)).toEqual(['orc', 'team-lead']);
		expect(evs.some((e) => e.type === 'turn.delivered' && e.refs.session === 'crewly-orc' && e.data?.kind === 'status')).toBe(true);
	});
});
