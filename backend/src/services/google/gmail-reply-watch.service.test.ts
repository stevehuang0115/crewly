/**
 * Tests for GmailReplyWatchService (CREW-257): history.list polling on a fake
 * clock — wake within 60 s, one list call per tick, no calls with no watches,
 * a persisted cursor, expiry and disconnect clean-up.
 *
 * @module services/google/gmail-reply-watch.service.test
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type { GmailThreadMessage } from './gmail.service.js';
import { GmailReplyWatchService, type GmailWatchApi } from './gmail-reply-watch.service.js';

type Msg = GmailThreadMessage & { threadId: string };
const POLL = GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_POLL_MS;

/** A fake mailbox: messages with history ids; history.list returns those after a cursor. */
class FakeMailbox implements GmailWatchApi {
	messages: Array<Msg & { h: number }> = [];
	h = 100;
	calls = { getProfile: 0, listHistoryAdded: 0, getMessageMeta: 0, getThread: 0 };
	expired = false;
	starts: string[] = [];
	add(id: string, threadId: string, labelIds: string[] = ['INBOX']): void {
		this.h += 1;
		this.messages.push({ id, threadId, from: 'them@x.y', subject: 'Re', snippet: '', labelIds, h: this.h });
	}
	async getProfile() {
		this.calls.getProfile += 1;
		return { emailAddress: 'o@x.y', historyId: String(this.h) };
	}
	async listHistoryAdded(start: string) {
		this.calls.listHistoryAdded += 1;
		this.starts.push(start);
		if (this.expired) throw Object.assign(new Error('too old'), { status: 404 });
		return { historyId: String(this.h), added: this.messages.filter((m) => m.h > Number(start)).map((m) => ({ id: m.id, threadId: m.threadId })) };
	}
	async getMessageMeta(id: string) {
		this.calls.getMessageMeta += 1;
		return this.messages.find((m) => m.id === id)!;
	}
	async getThread(threadId: string) {
		this.calls.getThread += 1;
		return this.messages.filter((m) => m.threadId === threadId);
	}
}

let file: string;
let box: FakeMailbox;
let connected: boolean;
let events: AgentEvent[];
let nowMs: number;

function make(): GmailReplyWatchService {
	current = new GmailReplyWatchService({
		file,
		gmailFor: () => box,
		accountConnected: async () => connected,
		defaultAccount: async () => 'o@x.y',
		publish: (e) => events.push(e),
		now: () => nowMs,
	});
	return current;
}

/** Advance the fake clock and timers by ms, letting async ticks settle. */
let current: GmailReplyWatchService | undefined;
async function advance(ms: number): Promise<void> {
	// In small steps, letting each tick finish: it does real file I/O the fake clock cannot drive.
	for (let left = ms; left > 0; left -= 5_000) {
		const step = Math.min(5_000, left);
		nowMs += step;
		await jest.advanceTimersByTimeAsync(step);
		await current?.whenIdle();
	}
}

beforeEach(async () => {
	jest.useFakeTimers();
	nowMs = Date.parse('2026-10-06T12:00:00Z');
	file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gmail-watch-')), 'watches.json');
	box = new FakeMailbox();
	box.add('m1', 't1', ['SENT']);
	connected = true;
	events = [];
});
afterEach(() => jest.useRealTimers());

describe('GmailReplyWatchService', () => {
	it('wakes the owning agent within 60 s of a new history record (fake clock)', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		const addedAt = nowMs;
		await advance(10_000);
		box.add('m2', 't1'); // the supplier replies
		let wokeAt = -1;
		for (let waited = 0; waited < 90_000 && wokeAt < 0; waited += 1_000) {
			await advance(1_000);
			if (events.length) wokeAt = nowMs;
		}
		expect(events).toHaveLength(1);
		expect(wokeAt - (addedAt + 10_000)).toBeLessThanOrEqual(60_000);
		expect(events[0]).toMatchObject({ type: 'gmail:reply_received', threadId: 't1', target: 'lyra', newValue: 'm2' });
		expect(events[0].sessionName).not.toBe('lyra');
		expect(POLL).toBeLessThanOrEqual(30_000);
		svc.stop();
	});

	it('makes no Gmail calls while nothing is watched', async () => {
		const svc = make();
		await svc.start();
		expect(jest.getTimerCount()).toBe(0); // armed only when something is watched
		await advance(5 * POLL);
		expect(box.calls).toEqual({ getProfile: 0, listHistoryAdded: 0, getMessageMeta: 0, getThread: 0 });
		expect(jest.getTimerCount()).toBe(0); // no timer at all while nothing is watched
		await svc.watch('t1', 'lyra');
		expect(jest.getTimerCount()).toBe(1);
		await svc.unwatch('t1', 'lyra');
		await advance(POLL); // the next tick notices there is nothing left and disarms
		expect(jest.getTimerCount()).toBe(0);
		svc.stop();
	});

	it('makes exactly one history.list per tick however many threads are watched', async () => {
		box.add('m3', 't2', ['SENT']);
		box.add('m4', 't3', ['SENT']);
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		await svc.watch('t2', 'lyra');
		await svc.watch('t3', 'ella');
		box.calls.listHistoryAdded = 0;
		box.calls.getThread = 0;
		await advance(3 * POLL);
		expect(box.calls.listHistoryAdded).toBe(3);
		expect(box.calls.getThread).toBe(0); // no per-thread reads: that is only the resync fallback
		expect(box.calls.getMessageMeta).toBe(0);
		svc.stop();
	});

	it('does not fire for history, the owner\'s own mail, or drafts; fetches only matching messages', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		box.add('m2', 't1', ['SENT']);
		box.add('m3', 't1', ['DRAFT']);
		box.add('other', 'tX');
		await advance(POLL);
		expect(events).toHaveLength(0);
		expect(box.calls.getMessageMeta).toBe(2); // not the unwatched thread's message
		svc.stop();
	});

	it('survives a restart: no duplicate wake and no missed reply', async () => {
		const first = make();
		await first.start();
		await first.watch('t1', 'lyra');
		box.add('m2', 't1');
		await advance(POLL);
		expect(events).toHaveLength(1);
		first.stop();
		const cursorAfterM2 = String(box.h);

		box.add('m3', 't1'); // arrives while the backend is down
		const restarted = make();
		await restarted.start(); // restores watches + cursor from disk, re-arms the timer
		box.starts.length = 0;
		await advance(POLL);
		expect(box.starts[0]).toBe(cursorAfterM2); // resumed from the persisted cursor, not the first one
		expect(events.map((e) => e.newValue)).toEqual(['m2', 'm3']);
		// the persisted cursor means m2 was not read again after the restart
		expect(box.calls.getMessageMeta).toBe(2);
		await advance(3 * POLL);
		expect(events).toHaveLength(2);
		restarted.stop();
	});

	it('a non-404 history.list failure keeps the cursor (never advances it) and the reply still fires after recovery', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		box.add('m2', 't1');
		const cursorBefore = (JSON.parse(await fs.readFile(file, 'utf-8')) as { cursors: Record<string, string> }).cursors['o@x.y'];
		const real = box.listHistoryAdded.bind(box);
		box.listHistoryAdded = async () => {
			box.calls.listHistoryAdded += 1;
			throw Object.assign(new Error('backend error'), { status: 500 });
		};
		await advance(POLL * 2);
		expect(events).toHaveLength(0);
		expect((JSON.parse(await fs.readFile(file, 'utf-8')) as { cursors: Record<string, string> }).cursors['o@x.y']).toBe(cursorBefore);
		box.listHistoryAdded = real;
		await advance(POLL);
		expect(events.map((e) => e.newValue)).toEqual(['m2']);
		svc.stop();
	});

	it('caps the stored fired ids so the file cannot grow forever', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		for (let i = 0; i < 560; i++) box.add(`x${i}`, 't1');
		await advance(POLL);
		const saved = JSON.parse(await fs.readFile(file, 'utf-8')) as { watches: Array<{ seen: string[] }> };
		expect(saved.watches[0].seen.length).toBeLessThanOrEqual(500);
		expect(saved.watches[0].seen).toContain('x559');
		svc.stop();
	});

	it('resyncs each watched thread when Gmail says the cursor is too old', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		box.add('m2', 't1');
		box.expired = true;
		await advance(POLL);
		expect(events.map((e) => e.newValue)).toEqual(['m2']);
		expect(box.calls.getThread).toBeGreaterThan(1);
		box.expired = false;
		await advance(POLL);
		expect(events).toHaveLength(1);
		svc.stop();
	});

	it('a resync does not re-fire a reply that already woke the agent', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		box.add('m2', 't1');
		await advance(POLL);
		expect(events).toHaveLength(1);
		box.expired = true;
		await advance(2 * POLL);
		expect(events).toHaveLength(1);
		svc.stop();
	});

	it('expires a watch 14 days after its last reply and stops polling', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		box.add('m2', 't1');
		await advance(POLL);
		expect(await svc.list()).toHaveLength(1);
		nowMs += GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_EXPIRY_MS + 1;
		await advance(POLL);
		expect(await svc.list()).toHaveLength(0);
		const before = box.calls.listHistoryAdded;
		await advance(5 * POLL);
		expect(box.calls.listHistoryAdded).toBe(before);
		svc.stop();
	});

	it('removes the watches of an account that stays disconnected, not after one blip', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		connected = false;
		await advance(POLL);
		expect(await svc.list()).toHaveLength(1);
		connected = true;
		await advance(POLL);
		connected = false;
		await advance(GOOGLE_WORKSPACE_CONSTANTS.GMAIL_WATCH_DISCONNECT_MISSES * POLL);
		expect(await svc.list()).toHaveLength(0);
		box.add('m2', 't1');
		await advance(3 * POLL);
		expect(events).toHaveLength(0);
		svc.stop();
	});

	it('only the owning agent can remove a watch', async () => {
		const svc = make();
		await svc.start();
		await svc.watch('t1', 'lyra');
		expect(await svc.unwatch('t1', 'someone-else')).toBe(false);
		expect(await svc.unwatch('t1', 'lyra')).toBe(true);
		expect(await svc.list()).toHaveLength(0);
		svc.stop();
	});
});
