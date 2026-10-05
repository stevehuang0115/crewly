import { RestoreQueue, orderRestoreEntries, restoreConcurrencyFromEnv, RESTORE_TIER, type RestoreEntry } from './restore-queue.js';

const tick = () => new Promise((r) => setImmediate(r));

/** An entry whose run() the test settles by hand. */
function entry(name: string, tier: number, extra: Partial<RestoreEntry> = {}) {
	const started: number[] = [];
	let settle: (ok: boolean) => void = () => undefined;
	const e: RestoreEntry = {
		name, tier, reason: 'test',
		run: (attempt) => { started.push(attempt); return new Promise((res) => { settle = (ok) => res({ success: ok }); }); },
		...extra,
	};
	return { e, started, finish: (ok = true) => settle(ok) };
}

describe('restore queue', () => {
	it('orders owner (oldest first), orchestrator, leads, others', () => {
		const mk = (name: string, tier: number, ownerSince?: number) => ({ name, tier, reason: '', ownerSince, run: async () => ({ success: true }) });
		const order = orderRestoreEntries([
			mk('dev', RESTORE_TIER.OTHER), mk('lead', RESTORE_TIER.LEAD), mk('orc', RESTORE_TIER.ORCHESTRATOR),
			mk('o2', RESTORE_TIER.OWNER, 200), mk('o1', RESTORE_TIER.OWNER, 100),
		]).map((e) => e.name);
		expect(order).toEqual(['o1', 'o2', 'orc', 'lead', 'dev']);
	});

	it('clamps concurrency from env', () => {
		expect(restoreConcurrencyFromEnv(undefined)).toBe(1);
		expect(restoreConcurrencyFromEnv('2')).toBe(2);
		expect(restoreConcurrencyFromEnv('9')).toBe(3);
		expect(restoreConcurrencyFromEnv('0')).toBe(1);
	});

	it('starts the next agent only when the previous one is ready (concurrency 1)', async () => {
		const a = entry('a', 4); const b = entry('b', 4);
		const q = new RestoreQueue(1, 60_000);
		const done = q.start([a.e, b.e]);
		await tick();
		expect(a.started).toEqual([0]); expect(b.started).toEqual([]);
		expect(q.stats()).toMatchObject({ pending: 1, started: 1, ready: 0 });
		a.finish(); await tick(); await tick();
		expect(b.started).toEqual([0]);
		b.finish(); await done;
		expect(q.stats()).toMatchObject({ running: false, pending: 0, ready: 2 });
	});

	it('runs up to the concurrency limit', async () => {
		const [a, b, c] = ['a', 'b', 'c'].map((n) => entry(n, 4));
		const q = new RestoreQueue(2, 60_000);
		const done = q.start([a.e, b.e, c.e]);
		await tick();
		expect([a.started.length, b.started.length, c.started.length]).toEqual([1, 1, 0]);
		a.finish(); b.finish(); await tick(); await tick(); c.finish(); await done;
	});

	it('moves an agent to the front on an owner wake, keeps order on other wakes', async () => {
		const a = entry('a', 4); const b = entry('b', 4); const c = entry('c', 4);
		const q = new RestoreQueue(1, 60_000);
		const done = q.start([a.e, b.e, c.e]);
		await tick();
		expect(q.wake('c', false)).toBe(true);
		expect(q.stats().order).toEqual(['b', 'c']);
		expect(q.wake('c', true)).toBe(true);
		expect(q.stats().order).toEqual(['c', 'b']);
		expect(q.wake('a', true)).toBe(false); // already started
		a.finish(); await tick(); await tick();
		expect(c.started).toEqual([0]); expect(b.started).toEqual([]);
		c.finish(); await tick(); await tick(); b.finish(); await done;
	});

	it('moves on after the per-agent timeout and retries it once later', async () => {
		jest.useFakeTimers();
		try {
			const a = entry('a', 4); const b = entry('b', 4);
			const q = new RestoreQueue(1, 1000);
			const done = q.start([a.e, b.e]);
			await jest.advanceTimersByTimeAsync(1001);
			expect(b.started).toEqual([0]);
			b.finish();
			await jest.advanceTimersByTimeAsync(1);
			expect(a.started).toEqual([0, 1]);
			a.finish();
			await jest.advanceTimersByTimeAsync(1);
			await done;
			expect(q.stats()).toMatchObject({ timedOut: 1, ready: 2, failed: 0 });
		} finally { jest.useRealTimers(); }
	});

	it('gives up after the retry times out too', async () => {
		jest.useFakeTimers();
		try {
			const a = entry('a', 4);
			const q = new RestoreQueue(1, 1000);
			const done = q.start([a.e]);
			await jest.advanceTimersByTimeAsync(2100);
			await done;
			expect(q.stats()).toMatchObject({ timedOut: 2, failed: 1, ready: 0 });
		} finally { jest.useRealTimers(); }
	});

	it('runs onReady per agent right after it registers, before the next starts', async () => {
		const calls: string[] = [];
		const a = entry('a', 4, { onReady: async () => { calls.push('recover-a'); } });
		const b = entry('b', 4, { onReady: async () => { calls.push('recover-b'); } });
		const q = new RestoreQueue(1, 60_000);
		const done = q.start([a.e, b.e]);
		await tick();
		expect(calls).toEqual([]);
		a.finish(); await tick(); await tick();
		expect(calls).toEqual(['recover-a']); expect(b.started).toEqual([0]);
		b.finish(); await done;
		expect(calls).toEqual(['recover-a', 'recover-b']);
	});

	it('counts a failed start and carries on', async () => {
		const a = entry('a', 4); const b = entry('b', 4);
		const q = new RestoreQueue(1, 60_000);
		const done = q.start([a.e, b.e]);
		await tick(); a.finish(false); await tick(); await tick(); b.finish(); await done;
		expect(q.stats()).toMatchObject({ failed: 1, ready: 1 });
	});
});
