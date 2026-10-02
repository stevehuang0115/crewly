/**
 * Tests for the low-disk guard helpers (pure functions + injected statfs).
 */

import {
	buildLowDiskNotice,
	describeReason,
	diskLevel,
	idleThreshold,
	noticeToSend,
	readFreeBytes,
	recordNotice,
} from './low-disk-guard.js';
import { WORKTREE_JANITOR_CONSTANTS as C } from '../../constants.js';

const GB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;

describe('low-disk guard helpers', () => {
	it('readFreeBytes multiplies available blocks by block size (numbers or bigints) and returns null on failure', async () => {
		expect(await readFreeBytes('/x', async () => ({ bavail: 1000, bsize: 4096 }))).toBe(4_096_000);
		expect(await readFreeBytes('/x', async () => ({ bavail: BigInt(2), bsize: BigInt(512) }))).toBe(1024);
		expect(await readFreeBytes('/x', async () => { throw new Error('ENOENT'); })).toBeNull();
	});

	it('readFreeBytes works against the real filesystem', async () => {
		const free = await readFreeBytes(process.cwd());
		expect(typeof free).toBe('number');
	});

	it('diskLevel uses the 15 GB / 5 GB thresholds', () => {
		expect(diskLevel(C.LOW_DISK_BYTES)).toBe('ok');
		expect(diskLevel(C.LOW_DISK_BYTES - 1)).toBe('low');
		expect(diskLevel(C.CRITICAL_DISK_BYTES - 1)).toBe('critical');
		expect(C.LOW_DISK_BYTES).toBe(15 * GB);
		expect(C.CRITICAL_DISK_BYTES).toBe(5 * GB);
	});

	it('idleThreshold halves in low-disk mode but never below 2h', () => {
		expect(idleThreshold(24 * HOUR, false)).toBe(24 * HOUR);
		expect(idleThreshold(24 * HOUR, true)).toBe(12 * HOUR);
		expect(idleThreshold(72 * HOUR, true)).toBe(36 * HOUR);
		expect(idleThreshold(2 * HOUR, true)).toBe(2 * HOUR);
		expect(idleThreshold(3 * HOUR, true)).toBe(2 * HOUR);
		// A threshold already below the floor is not raised.
		expect(idleThreshold(HOUR, true)).toBe(HOUR);
	});

	it('noticeToSend: normal at most once per 24h, urgent at most once per 6h', () => {
		const t0 = 1_000_000_000_000;
		expect(noticeToSend('ok', {}, t0)).toBeNull();
		expect(noticeToSend('low', {}, t0)).toBe('normal');
		let state = recordNotice({}, 'normal', t0);
		expect(noticeToSend('low', state, t0 + 23 * HOUR)).toBeNull();
		expect(noticeToSend('low', state, t0 + 24 * HOUR)).toBe('normal');
		// Dropping below 5 GB right after a normal notice still sends the urgent one.
		expect(noticeToSend('critical', state, t0 + HOUR)).toBe('urgent');
		state = recordNotice(state, 'urgent', t0 + HOUR);
		expect(state).toEqual({ lastNoticeAt: t0 + HOUR, lastUrgentAt: t0 + HOUR });
		expect(noticeToSend('critical', state, t0 + 6 * HOUR)).toBeNull();
		expect(noticeToSend('critical', state, t0 + 7 * HOUR)).toBe('urgent');
		// An urgent notice also counts for the 24h cadence of normal ones.
		expect(noticeToSend('low', state, t0 + 10 * HOUR)).toBeNull();
	});

	it('buildLowDiskNotice lists the 5 biggest kept items in plain English', () => {
		const items = Array.from({ length: 7 }, (_, i) => ({ path: `/tmp/item-${i}`, bytes: (i + 1) * GB, reason: i % 2 ? 'dirty' : 'unpushed' }));
		const { title, message } = buildLowDiskNotice({ freeBytes: 12.34 * GB, urgent: false, freedBytes: 3 * GB, items });
		expect(title).toBe('Disk space is running low');
		expect(message).toContain('12.3 GB free');
		expect(message).toContain('cleaned up 3.0 GB');
		const bullets = message.split('\n').filter((l) => l.startsWith('•'));
		expect(bullets).toHaveLength(C.LOW_DISK_REPORT_ITEMS);
		expect(bullets[0]).toBe('• /tmp/item-6 (7.0 GB) — has commits that were never pushed');
		expect(bullets[1]).toBe('• /tmp/item-5 (6.0 GB) — has changes that were never committed');
		expect(message).not.toContain('item-1 ');
	});

	it('buildLowDiskNotice marks urgent notices and handles nothing left to list', () => {
		const { title, message } = buildLowDiskNotice({ freeBytes: 2 * GB, urgent: true, freedBytes: 0, items: [] });
		expect(title).toMatch(/URGENT/);
		expect(message).toContain('2.0 GB free');
		expect(message).toContain('nothing more that is safe to delete');
	});

	it('describeReason falls back to the code for unknown reasons', () => {
		expect(describeReason('not-merged')).toBe('has work that is not merged yet');
		expect(describeReason('weird')).toBe('kept (weird)');
	});
});
