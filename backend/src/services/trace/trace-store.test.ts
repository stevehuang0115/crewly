/**
 * Tests for the run trace store: append/read, index + refs, size cap,
 * retention, and that write failures are swallowed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore, type TraceFsOps } from './trace-store.js';
import type { TraceEvent, TraceRoot } from './trace.types.js';

const DAY = 24 * 60 * 60 * 1000;

function root(traceId: string, at: Date): TraceRoot {
	return { traceId, kind: 'request', summary: 'TKT-0001: build it', createdAt: at.toISOString(), actor: { kind: 'owner' }, refs: { requestId: 'r1' } };
}

function event(traceId: string, at: Date, summary = 'something'): TraceEvent {
	return { ts: at.toISOString(), traceId, type: 'skill.call', actor: { kind: 'agent', session: 'dev-1' }, refs: {}, summary, outcome: 'ok' };
}

/** Let the store's chained writes and a triggered sweep run. */
async function settle(store: TraceStore): Promise<void> {
	await store.flush();
	await new Promise((r) => setImmediate(r));
	await store.flush();
}

describe('TraceStore', () => {
	let dir: string;
	let now: Date;
	let stores: TraceStore[];

	const make = (opts: Partial<ConstructorParameters<typeof TraceStore>[0]> = {}): TraceStore => {
		const s = new TraceStore({ dir, now: () => now, indexFlushDelayMs: 5, ...opts });
		stores.push(s);
		return s;
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
		now = new Date('2026-10-03T10:00:00Z');
		stores = [];
	});

	afterEach(async () => {
		for (const s of stores) {
			await s.flush().catch(() => undefined);
			s.dispose();
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes the root first and reads events back in pages', async () => {
		const store = make();
		const id = 'tr-20261003-00000001';
		expect(store.createRoot(root(id, now))).toBe(true);
		for (let i = 0; i < 5; i++) store.append(event(id, now, `call ${i}`));
		const page = await store.read(id, 1, 2);
		expect(page).not.toBeNull();
		expect(page!.total).toBe(6);
		expect(page!.events.map((e) => e.summary)).toEqual(['call 0', 'call 1']);
		expect(page!.root.summary).toBe('TKT-0001: build it');
		const first = await store.read(id, 0, 1);
		expect(first!.events[0].type).toBe('trace.root');
		const lines = fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8').trim().split('\n');
		expect(lines).toHaveLength(6);
	});

	it('refuses bad ids, duplicate roots and events for unknown traces', () => {
		const store = make();
		expect(store.createRoot(root('../../evil', now))).toBe(false);
		expect(store.createRoot(root('tr-20261003-00000001', now))).toBe(true);
		expect(store.createRoot(root('tr-20261003-00000001', now))).toBe(false);
		expect(store.append(event('tr-20261003-0000ffff', now))).toBe(false);
	});

	it('keeps an index with refs that survives a restart', async () => {
		const a = make();
		const id = 'tr-20261003-00000002';
		a.createRoot(root(id, now));
		a.linkRef('workItem', 'wi-1', id);
		a.linkRef('workItem', 'wi-1', 'tr-20261003-00000009'); // first link wins (and unknown traces are ignored)
		await a.flush();
		const b = make();
		expect(b.traceByRef('workItem', 'wi-1')).toBe(id);
		expect(b.traceByRef('workItem', 'nope')).toBeNull();
		expect(b.list().map((e) => e.traceId)).toEqual([id]);
		expect(b.getEntry(id)?.eventCount).toBe(1);
	});

	it('lists by recency, since and root kind', () => {
		const store = make();
		store.createRoot(root('tr-20261001-00000001', new Date('2026-10-01T00:00:00Z')));
		store.createRoot({ ...root('tr-20261003-00000002', now), kind: 'experiment' });
		expect(store.list().map((e) => e.traceId)).toEqual(['tr-20261003-00000002', 'tr-20261001-00000001']);
		expect(store.list({ since: new Date('2026-10-02T00:00:00Z') }).map((e) => e.traceId)).toEqual(['tr-20261003-00000002']);
		expect(store.list({ rootKind: 'request' }).map((e) => e.traceId)).toEqual(['tr-20261001-00000001']);
		expect(store.list({ limit: 1 })).toHaveLength(1);
	});

	it('caps a trace with one truncated marker and drops what follows', async () => {
		const store = make({ maxEvents: 3 });
		const id = 'tr-20261003-00000003';
		store.createRoot(root(id, now));
		store.append(event(id, now, 'one'));
		store.append(event(id, now, 'two'));
		store.append(event(id, now, 'three'));
		store.append(event(id, now, 'four'));
		const page = await store.read(id);
		expect(page!.truncated).toBe(true);
		expect(page!.events.map((e) => e.type)).toEqual(['trace.root', 'skill.call', 'skill.call', 'trace.truncated']);
	});

	it('caps by bytes too', async () => {
		const store = make({ maxBytes: 900 });
		const id = 'tr-20261003-00000004';
		store.createRoot(root(id, now));
		for (let i = 0; i < 10; i++) store.append(event(id, now, 'x'.repeat(150)));
		const page = await store.read(id);
		expect(page!.truncated).toBe(true);
		expect(page!.events[page!.events.length - 1].type).toBe('trace.truncated');
		expect(fs.statSync(path.join(dir, `${id}.jsonl`)).size).toBeLessThan(1400);
	});

	it('swallows write failures (a turn is never broken by tracing)', async () => {
		const failing: TraceFsOps = {
			mkdir: async () => undefined,
			appendFile: async () => {
				throw new Error('disk full');
			},
			writeFile: async () => {
				throw new Error('disk full');
			},
			rename: async () => undefined,
			readFile: async () => {
				throw new Error('gone');
			},
			unlink: async () => undefined,
			readdir: async () => [],
			stat: async () => ({ mtimeMs: 0 }),
		};
		const store = make({ fs: failing });
		const id = 'tr-20261003-00000005';
		expect(() => store.createRoot(root(id, now))).not.toThrow();
		expect(() => store.append(event(id, now))).not.toThrow();
		await expect(store.flush()).resolves.toBeUndefined();
		expect(store.writeFailures).toBeGreaterThan(0);
		const page = await store.read(id);
		expect(page!.events).toEqual([]);
	});

	it('deletes traces idle for longer than the retention, with their refs and orphan files', async () => {
		const store = make({ retentionMs: 90 * DAY });
		const old = 'tr-20260601-00000006';
		const fresh = 'tr-20261003-00000007';
		store.createRoot(root(old, new Date(now.getTime() - 100 * DAY)));
		store.linkRef('workItem', 'wi-old', old);
		store.createRoot(root(fresh, now));
		await store.flush();
		const orphan = path.join(dir, 'tr-20260101-0000aaaa.jsonl');
		fs.writeFileSync(orphan, '{}\n');
		const past = (now.getTime() - 120 * DAY) / 1000;
		fs.utimesSync(orphan, past, past);

		// (The first write already ran a sweep on its own; run one explicitly too.)
		await store.sweep();
		expect(store.has(old)).toBe(false);
		expect(store.has(fresh)).toBe(true);
		expect(store.traceByRef('workItem', 'wi-old')).toBeNull();
		expect(fs.existsSync(path.join(dir, `${old}.jsonl`))).toBe(false);
		expect(fs.existsSync(orphan)).toBe(false);
		expect(fs.existsSync(path.join(dir, `${fresh}.jsonl`))).toBe(true);
	});

	it('runs the retention sweep on its own on the first write when one is due', async () => {
		const a = make({ retentionMs: 90 * DAY });
		const old = 'tr-20260601-00000008';
		a.createRoot(root(old, now));
		await settle(a);
		await a.sweep(); // persists the index with lastSweepAt = now
		expect(a.has(old)).toBe(true);

		now = new Date(now.getTime() + 91 * DAY);
		const b = make({ retentionMs: 90 * DAY });
		expect(b.has(old)).toBe(true);
		b.createRoot(root('tr-20260902-00000009', now));
		await settle(b);
		expect(b.has(old)).toBe(false);
		expect(b.has('tr-20260902-00000009')).toBe(true);
	});
});
