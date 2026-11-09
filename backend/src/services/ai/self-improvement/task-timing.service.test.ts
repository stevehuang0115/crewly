import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	TaskTimingService,
	TaskTimingRecord,
	classifyTaskKind,
	formatMinutes,
	formatReflection,
	formatTimingBlock,
	normalizeTaskKind,
	parseEtaMinutes,
	summarizeTimings,
} from './task-timing.service.js';

function rec(kind: string, actualMinutes: number, etaMinutes?: number, id = `wi-${Math.random()}`): TaskTimingRecord {
	return {
		agent: 'dex',
		workItemId: id,
		title: 't',
		kind,
		actualMinutes,
		completedAt: '2026-10-18T00:00:00.000Z',
		...(etaMinutes !== undefined ? { etaMinutes } : {}),
	};
}

describe('classifyTaskKind', () => {
	it.each([
		['Verify: EP03 cut', 'review'],
		['Research licensed B-roll libraries', 'research'],
		['Revise EP02 narration (round 3)', 'revision'],
		['番外 第 6 版 改字幕', 'revision'],
		['Add burned-subtitle capability to the director', 'new-capability'],
		['Cut a new Tokyo film', 'new-build'],
		['Weekly sync', 'other'],
	])('%s -> %s', (title, kind) => {
		expect(classifyTaskKind(title)).toBe(kind);
	});
});

describe('input parsing', () => {
	it('normalizes kinds and rejects unusable ones', () => {
		expect(normalizeTaskKind('New Build')).toBe('new-build');
		expect(normalizeTaskKind('')).toBeUndefined();
		expect(normalizeTaskKind(5)).toBeUndefined();
		expect(normalizeTaskKind('x'.repeat(40))).toBeUndefined();
	});

	it('accepts positive ETAs up to the cap', () => {
		expect(parseEtaMinutes(20)).toBe(20);
		expect(parseEtaMinutes('45')).toBe(45);
		expect(parseEtaMinutes(0)).toBeUndefined();
		expect(parseEtaMinutes(-3)).toBeUndefined();
		expect(parseEtaMinutes(1e9)).toBeUndefined();
		expect(parseEtaMinutes('soon')).toBeUndefined();
	});

	it('formats minutes and hours', () => {
		expect(formatMinutes(18)).toBe('18 min');
		expect(formatMinutes(60)).toBe('60 min');
		expect(formatMinutes(156)).toBe('2.6 h');
	});
});

describe('summarizeTimings', () => {
	it('reports kinds with n>=2, excludes spans over 24 h, and computes the ETA bias', () => {
		const summary = summarizeTimings([
			rec('revision', 11, 60),
			rec('revision', 23, 60),
			rec('revision', 60, 60),
			rec('revision', 3000, 60), // a wait, not work
			rec('research', 40),
		]);
		expect(summary.kinds).toEqual([
			{ kind: 'revision', n: 3, medianMinutes: 23, fastestMinutes: 11, slowestMinutes: 60 },
		]);
		expect(summary.etaBias).toBeCloseTo(60 / 23);
	});

	it('has no bias with fewer than two ETAs', () => {
		expect(summarizeTimings([rec('revision', 10, 20), rec('revision', 12)]).etaBias).toBeNull();
	});
});

describe('formatTimingBlock', () => {
	it('is null without history', () => {
		expect(formatTimingBlock({ kinds: [], etaBias: null })).toBeNull();
	});

	it('lists kinds, the bias and the ETA instruction', () => {
		const block = formatTimingBlock(summarizeTimings([rec('revision', 20, 50), rec('revision', 26, 65)]));
		expect(block).toContain('revision median 23 min (20 min–26 min, n=2)');
		expect(block).toContain('Your ETAs run 2.5x actual.');
		expect(block).toContain('base it on your own median for that kind');
		expect(block).toContain('report-progress');
	});

	it('says ETAs are about right within the tolerance', () => {
		const block = formatTimingBlock(summarizeTimings([rec('revision', 20, 22), rec('revision', 30, 30)]));
		expect(block).toContain('Your ETAs are about right.');
	});
});

describe('formatReflection', () => {
	it('names kind, estimate, actual and median, and invites a learning on a large gap', () => {
		const r = rec('revision', 18, 60);
		const summary = { kinds: [{ kind: 'revision', n: 12, medianMinutes: 23, fastestMinutes: 11, slowestMinutes: 60 }], etaBias: null };
		expect(formatReflection(r, summary)).toBe(
			"This was a 'revision'. You estimated 60 min; it took 18 min. Your median for 'revision' is 23 min (n=12). " +
				'Your estimate was off by 3.3x; if you see why, record it with record-learning.',
		);
	});

	it('stays one short line without an ETA or history', () => {
		expect(formatReflection(rec('other', 7), { kinds: [], etaBias: null })).toBe("This was a 'other'. It took 7 min.");
	});

	it('flags a span over 24 h as waiting', () => {
		expect(formatReflection(rec('revision', 2000), { kinds: [], etaBias: null })).toContain('waiting, not work');
	});
});

describe('TaskTimingService', () => {
	let home: string;
	let service: TaskTimingService;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-timing-'));
		service = new TaskTimingService(home);
	});

	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it('returns no records and no block for a new agent', () => {
		expect(service.getRecords('dex')).toEqual([]);
		expect(service.getTimingBlock('dex')).toBeNull();
	});

	it('records a completion from claim time, using the stated ETA and kind', () => {
		const line = service.recordCompletion({
			agent: 'dex',
			workItem: {
				id: 'wi-1',
				title: 'Something',
				startedAt: '2026-10-18T10:00:00.000Z',
				metadata: { etaMinutes: 60, taskKind: 'revision' },
			},
			completedAt: new Date('2026-10-18T10:18:00.000Z'),
		});
		expect(line).toContain("This was a 'revision'. You estimated 60 min; it took 18 min.");
		const [stored] = service.getRecords('dex');
		expect(stored).toMatchObject({ workItemId: 'wi-1', kind: 'revision', etaMinutes: 60, actualMinutes: 18 });
		expect(fs.existsSync(path.join(home, '.crewly', 'agents', 'dex', 'task-timings.json'))).toBe(true);
	});

	it('prefers the kind named on completion and falls back to the title', () => {
		const base = { id: 'wi-2', title: 'Research hosting options', startedAt: '2026-10-18T10:00:00.000Z' };
		service.recordCompletion({ agent: 'dex', workItem: base, completedAt: new Date('2026-10-18T10:30:00.000Z') });
		expect(service.getRecords('dex')[0].kind).toBe('research');
		service.recordCompletion({ agent: 'dex', workItem: base, taskKind: 'new-build', completedAt: new Date('2026-10-18T10:30:00.000Z') });
		const records = service.getRecords('dex');
		expect(records).toHaveLength(1); // same WorkItem replaces its earlier record
		expect(records[0].kind).toBe('new-build');
	});

	it('records nothing without a claim time', () => {
		expect(service.recordCompletion({ agent: 'dex', workItem: { id: 'wi-3', title: 'x' } })).toBeNull();
		expect(service.getRecords('dex')).toEqual([]);
	});

	it('builds the block once a kind has two records', () => {
		const at = (m: number): Date => new Date(Date.parse('2026-10-18T10:00:00.000Z') + m * 60000);
		for (const [id, mins] of [['a', 20], ['b', 26]] as const) {
			service.recordCompletion({
				agent: 'dex',
				workItem: { id, title: 'Revise cut', startedAt: '2026-10-18T10:00:00.000Z' },
				completedAt: at(mins),
			});
		}
		expect(service.getTimingBlock('dex')).toContain('revision median 23 min');
	});
});
