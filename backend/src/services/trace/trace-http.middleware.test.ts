/**
 * Tests for the run trace HTTP middleware: skill calls are attributed to the
 * calling session's trace, refusals become guard blocks, and agent → agent
 * messages carry the sender's trace.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { TraceStore, setTraceStoreForTesting } from './trace-store.js';
import { setTraceContextForTesting } from './trace-context.service.js';
import { classifySkillStatus, traceHttpMiddleware } from './trace-http.middleware.js';
import { ensureTraceForSession, noteTurnDelivery, startGoalTrace } from './trace-recorder.js';

describe('traceHttpMiddleware', () => {
	let dir: string;
	let store: TraceStore;
	let app: Express;
	let received: unknown[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mw-'));
		store = new TraceStore({ dir, indexFlushDelayMs: 5 });
		setTraceStoreForTesting(store);
		setTraceContextForTesting(null);
		received = [];
		app = express();
		app.use(express.json());
		const router = express.Router();
		router.use(traceHttpMiddleware);
		router.post('/task-pool/add', (req, res) => {
			// The call itself starts work: a pending owner root becomes a trace.
			ensureTraceForSession(req.headers['x-agent-session'] as string);
			res.status(201).json({ success: true });
		});
		router.get('/task-pool/:id', (_req, res) => res.json({ success: true }));
		router.post('/project-tickets/x', (_req, res) => res.status(409).json({ success: false, error: 'That ticket is closed' }));
		router.post('/boom', (_req, res) => res.status(500).json({ success: false, error: 'internal' }));
		router.get('/agent-hooks/pre-tool', (_req, res) => res.json({ ok: true }));
		router.post('/terminal/:session/write', (req, res) => {
			received.push(req.body);
			res.json({ success: true });
		});
		router.post('/terminal/:session/deliver', (req, res) => {
			received.push(req.body);
			res.json({ success: true });
		});
		app.use('/api', router);
	});

	afterEach(async () => {
		await store.flush();
		setTraceStoreForTesting(null);
		setTraceContextForTesting(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const eventsOf = async (id: string) => (await store.read(id, 0, 1000))!.events;

	it('attributes a skill call to the session turn trace', async () => {
		const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
		await request(app).get('/api/task-pool/2c2a1c55-1111-4111-8111-111111111111').set('X-Agent-Session', 'dev-1').expect(200);
		const call = (await eventsOf(id)).find((e) => e.type === 'skill.call');
		expect(call).toMatchObject({ outcome: 'ok', actor: { kind: 'agent', session: 'dev-1' }, refs: { skill: 'GET /task-pool/:id', session: 'dev-1' }, data: { status: 200 } });
	});

	it('records refusals as guard blocks and failures as errors, with the error text', async () => {
		const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
		await request(app).post('/api/project-tickets/x').set('X-Agent-Session', 'dev-1').send({}).expect(409);
		await request(app).post('/api/boom').set('X-Agent-Session', 'dev-1').send({}).expect(500);
		const evs = await eventsOf(id);
		expect(evs.find((e) => e.type === 'guard.block')).toMatchObject({ outcome: 'blocked', summary: expect.stringContaining('That ticket is closed') });
		expect(evs.find((e) => e.type === 'error')).toMatchObject({ outcome: 'failed', refs: { skill: 'POST /boom' } });
	});

	it('records a call that started the trace itself', async () => {
		noteTurnDelivery('crewly-orc', '[CHAT:c1:abcd1234] please build the page');
		await request(app).post('/api/task-pool/add').set('X-Agent-Session', 'crewly-orc').send({}).expect(201);
		const [entry] = store.list();
		expect(entry.root.kind).toBe('owner_message');
		expect((await eventsOf(entry.traceId)).some((e) => e.type === 'skill.call' && e.refs.skill === 'POST /task-pool/add')).toBe(true);
	});

	it('skips hooks, owner calls and sessions without a trace', async () => {
		const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'dev-1' })!;
		await request(app).get('/api/agent-hooks/pre-tool').set('X-Agent-Session', 'dev-1').expect(200);
		await request(app).get('/api/task-pool/abc').expect(200);
		await request(app).get('/api/task-pool/abc').set('X-Agent-Session', 'other').expect(200);
		expect((await eventsOf(id)).filter((e) => e.type === 'skill.call')).toHaveLength(0);
		expect(store.list()).toHaveLength(1);
	});

	it('appends the sender trace to agent → agent messages (write and deliver)', async () => {
		const id = startGoalTrace({ kind: 'goal', summary: 'g', session: 'tl-1' })!;
		await request(app).post('/api/terminal/dev-1/write').set('X-Agent-Session', 'tl-1').send({ data: 'check the build', mode: 'message' }).expect(200);
		await request(app).post('/api/terminal/dev-1/deliver').set('X-Agent-Session', 'tl-1').send({ message: 'and the tests' }).expect(200);
		await request(app).post('/api/terminal/dev-1/write').set('X-Agent-Session', 'tl-1').send({ data: '\u0003' }).expect(200);
		expect(received).toEqual([
			{ data: `check the build\n[TRACE:${id}]`, mode: 'message' },
			{ message: `and the tests\n[TRACE:${id}]` },
			{ data: '\u0003' },
		]);
		expect((await eventsOf(id)).filter((e) => e.type === 'message.agent')).toHaveLength(2);
	});

	it('maps statuses to event types', () => {
		expect(classifySkillStatus(200)).toEqual({ type: 'skill.call', outcome: 'ok' });
		expect(classifySkillStatus(202)).toEqual({ type: 'skill.call', outcome: 'queued' });
		expect(classifySkillStatus(403).type).toBe('guard.block');
		expect(classifySkillStatus(429).type).toBe('guard.block');
		expect(classifySkillStatus(404)).toEqual({ type: 'error', outcome: 'failed' });
	});
});
