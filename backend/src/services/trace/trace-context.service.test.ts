/**
 * Tests for the per-session trace context: resolution from delivered text,
 * pending owner-message roots, and lookups by time.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from './trace-store.js';
import { TraceContext, classifyDelivery, defaultIdleClearMs } from './trace-context.service.js';
import { parseInboundOrigin } from '../orc/orc-reply-route.service.js';
import { appendTraceMarker } from './trace-markers.js';

const WI = '2c2a1c55-1111-4111-8111-111111111111';
const REQ = '9b1f0d1e-0000-4000-8000-000000000001';

describe('classifyDelivery', () => {
	it.each([
		['[CHAT:conv:abcd1234] can you build the page?', 'owner_message'],
		['\n[CREWLY-DISPATCH] WorkItem x queued for you (type=delegate).', 'dispatch'],
		['[CREWLY-DISPATCH] 3 WorkItems are still queued for you — this one message covers all of them.', 'redelivery'],
		['[TASK RE-DELIVERY] You were working on this task', 'redelivery'],
		['[CHAT:orc-status] Agent status: [DONE] shipped', 'status'],
		['Status from dev-1 (reports to you): done', 'status'],
		['[DECISION D-4] The owner chose Approve', 'decision'],
		['[FOLLOW-UP TKT-0187] still owed', 'follow_up'],
		['[SYSTEM] scheduled check', 'system'],
		['plain text from another agent', 'system'],
	])('%s → %s', (text, kind) => {
		expect(classifyDelivery(text)).toBe(kind);
	});
});

describe('start-anchored parsers still work on marked messages', () => {
	const marker = 'tr-20261003-0123abcd';
	it('parseInboundOrigin', () => {
		expect(parseInboundOrigin(appendTraceMarker('[CHAT:a721f48d:abcd1234] <owner@Orchestrator>\n\nhi', marker))).toEqual({ conversationId: 'a721f48d' });
	});
	it('classifyDelivery', () => {
		expect(classifyDelivery(appendTraceMarker('[TASK] build the page', marker))).toBe('dispatch');
		expect(classifyDelivery(appendTraceMarker('[SYSTEM] check', marker))).toBe('system');
		expect(classifyDelivery(appendTraceMarker('[CHAT:c1:abcd1234] hi', marker))).toBe('owner_message');
	});
});

describe('TraceContext', () => {
	let dir: string;
	let store: TraceStore;
	let clock: number;
	let ctx: TraceContext;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ctx-'));
		clock = Date.parse('2026-10-03T10:00:00Z');
		store = new TraceStore({ dir, now: () => new Date(clock), indexFlushDelayMs: 5 });
		ctx = new TraceContext(() => store, () => clock);
	});

	afterEach(async () => {
		await store.idle();
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a [TRACE] marker makes the trace current and records the delivery', async () => {
		const id = ctx.startTrace({ kind: 'request', summary: 'TKT-0001', actor: { kind: 'owner' } })!;
		expect(ctx.noteTurnDelivery('dev-1', `[CREWLY-DISPATCH] WorkItem x queued\n  Trace: [TRACE:${id}]`)).toBe(id);
		expect(ctx.currentTrace('dev-1')).toBe(id);
		const page = await store.read(id);
		const delivered = page!.events.find((e) => e.type === 'turn.delivered');
		expect(delivered?.data).toMatchObject({ kind: 'dispatch', runtime: 'pty' });
		expect(delivered?.refs.session).toBe('dev-1');
	});

	it('resolves ticket markers and work item ids through the index', () => {
		const a = ctx.startTrace({ kind: 'request', summary: 'a', actor: { kind: 'owner' } })!;
		const b = ctx.startTrace({ kind: 'request', summary: 'b', actor: { kind: 'owner' } })!;
		store.linkRef('request', REQ, a);
		store.linkRef('workItem', WI, b);
		expect(ctx.noteTurnDelivery('orc', `[CHAT:c1:abcd1234] [TICKET:TKT-0001 ${REQ}] please build it`)).toBe(a);
		expect(ctx.noteTurnDelivery('dev-1', `Reminder: WorkItem ${WI} is still open`)).toBe(b);
		expect(ctx.resolveTracesFromText('nothing here')).toEqual([]);
	});

	it('an unknown marker is ignored', () => {
		expect(ctx.resolveTracesFromText('[TRACE:tr-20261003-deadbeef]')).toEqual([]);
	});

	it('an untraced owner message waits as a pending root until the turn starts work', async () => {
		const prev = ctx.startTrace({ kind: 'request', summary: 'old', actor: { kind: 'owner' }, session: 'orc' })!;
		expect(ctx.currentTrace('orc')).toBe(prev);

		expect(ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] how are you?')).toBeNull();
		expect(ctx.currentTrace('orc')).toBeNull();
		expect(store.list()).toHaveLength(1);

		clock += 1000;
		const id = ctx.ensureTraceForSession('orc')!;
		expect(id).not.toBe(prev);
		expect(ctx.ensureTraceForSession('orc')).toBe(id);
		const entry = store.getEntry(id)!;
		expect(entry.root.kind).toBe('owner_message');
		expect(entry.root.summary).toBe('how are you?');
		expect(entry.root.actor).toEqual({ kind: 'owner' });
		const page = await store.read(id);
		expect(page!.events.map((e) => e.type)).toEqual(['trace.root', 'turn.delivered']);
	});

	it('a pending root expires', () => {
		ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] hello');
		clock += 7 * 60 * 60 * 1000;
		expect(ctx.ensureTraceForSession('orc')).toBeNull();
	});

	it.each([
		['[SYSTEM] are you still working?'],
		['[SCHEDULED CHECK-IN - Please continue] hourly check'],
		['[SIGNAL DIGEST] 3 actions for visa.careerengine.us'],
		['[CREWLY-DISPATCH] WorkItem 2c2a1c55-9999-4111-8111-111111111111 queued for you (type=delegate).'],
	])('an untraced delivery (%s) ends the current trace', (text) => {
		ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' });
		clock += 1000;
		expect(ctx.noteTurnDelivery('dev-1', text)).toBeNull();
		expect(ctx.currentTrace('dev-1')).toBeNull();
		expect(ctx.traceAt('dev-1', clock + 10)).toBeNull();
		expect(ctx.ensureTraceForSession('dev-1')).toBeNull();
	});

	it('an untraced owner message after a run ends it and waits as a pending root', () => {
		const old = ctx.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'orc' })!;
		ctx.noteTurnDelivery('orc', '[CHAT:c1:abcd1234] new topic: fix the footer');
		expect(ctx.currentTrace('orc')).toBeNull();
		const next = ctx.ensureTraceForSession('orc');
		expect(next).not.toBe(old);
		expect(store.getEntry(next!)?.root.kind).toBe('owner_message');
	});

	it('the current trace ends after the idle gap unless the session keeps working', () => {
		const idle = new TraceContext(() => store, () => clock, 30 * 60_000);
		const id = idle.startTrace({ kind: 'goal', summary: 'g', actor: { kind: 'owner' }, session: 'dev-1' })!;
		const t0 = clock;
		clock += 20 * 60_000;
		idle.touch('dev-1');
		clock += 20 * 60_000;
		expect(idle.currentTrace('dev-1')).toBe(id);
		clock += 31 * 60_000;
		expect(idle.currentTrace('dev-1')).toBeNull();
		// A call after the gap does not revive it.
		idle.touch('dev-1');
		expect(idle.currentTrace('dev-1')).toBeNull();
		// Usage is attributed by time: inside the active stretch yes, after the gap no.
		expect(idle.traceAt('dev-1', t0 + 39 * 60_000)).toBe(id);
		expect(idle.traceAt('dev-1', t0 + 75 * 60_000)).toBeNull();
	});

	it('reads the idle gap from CREWLY_TRACE_IDLE_CLEAR_MINUTES', () => {
		const before = process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES;
		process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES = '5';
		try {
			expect(defaultIdleClearMs()).toBe(5 * 60_000);
		} finally {
			if (before === undefined) delete process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES;
			else process.env.CREWLY_TRACE_IDLE_CLEAR_MINUTES = before;
		}
		expect(defaultIdleClearMs()).toBe(30 * 60_000);
	});

	it('clearIfCurrent ends only the named trace', () => {
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		expect(ctx.clearIfCurrent('dev-1', 'tr-20261003-00000000')).toBe(false);
		expect(ctx.currentTrace('dev-1')).toBe(a);
		expect(ctx.clearIfCurrent('dev-1', a)).toBe(true);
		expect(ctx.currentTrace('dev-1')).toBeNull();
	});

	it('with several traces in one delivery the current one is kept and each records it', async () => {
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' } })!;
		expect(ctx.noteTurnDelivery('dev-1', `batch [TRACE:${b}] [TRACE:${a}]`)).toBe(a);
		expect((await store.read(b))!.events.some((e) => e.type === 'turn.delivered')).toBe(true);
	});

	it('looks up the trace a session was on at a given time', () => {
		const t0 = clock;
		const a = ctx.startTrace({ kind: 'goal', summary: 'a', actor: { kind: 'owner' }, session: 'dev-1' })!;
		clock += 60_000;
		const b = ctx.startTrace({ kind: 'goal', summary: 'b', actor: { kind: 'owner' }, session: 'dev-1' })!;
		expect(ctx.traceAt('dev-1', t0 + 30_000)).toBe(a);
		expect(ctx.traceAt('dev-1', clock + 1)).toBe(b);
		expect(ctx.traceAt('dev-1', t0 - 1)).toBeNull();
		expect(ctx.traceAt('nobody')).toBeNull();
	});

	it('never throws when the store does', () => {
		const broken = new TraceContext(() => {
			throw new Error('no store');
		});
		expect(broken.noteTurnDelivery('dev-1', 'hello')).toBeNull();
		expect(broken.startTrace({ kind: 'goal', summary: 'x', actor: { kind: 'owner' } })).toBeNull();
		expect(broken.record({ traceId: 'tr-20261003-00000001', type: 'usage', actor: { kind: 'system' }, summary: 'x' })).toBe(false);
	});
});
