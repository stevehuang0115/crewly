/**
 * Tests for the append-only activity log (crewly#881).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ActivityLogService,
	actorFromCaller,
	getActivityLog,
	isActivityActorType,
	maskForActivity,
	recordActivity,
	setActivityLogForTesting,
	summarizeChange,
	type ActivityFsOps,
} from './activity-log.service.js';
import type { ComponentLogger } from '../core/logger.service.js';

const quiet = (): ComponentLogger => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as ComponentLogger;

describe('ActivityLogService', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-log-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		setActivityLogForTesting(null);
	});

	it('appends one JSON line per entry into the month file and reads newest first', async () => {
		let t = Date.parse('2026-10-25T10:00:00Z');
		const log = new ActivityLogService({ dir, now: () => new Date((t += 1000)), logger: quiet() });
		log.record({ actor: { type: 'owner', via: 'owner-session' }, action: 'team.member.updated', target: { type: 'member', id: 'm1', name: 'Ella' }, after: { role: 'lead' } });
		log.record({ actor: { type: 'agent', id: 'dev-ann', via: 'agent-badge' }, action: 'team.member.added', target: { type: 'member', id: 'm2' } });
		await log.flush();
		const file = path.join(dir, '2026-10.jsonl');
		const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ action: 'team.member.updated', ts: '2026-10-25T10:00:01.000Z', after: { role: 'lead' } });
		const all = await log.list();
		expect(all.map((e) => e.action)).toEqual(['team.member.added', 'team.member.updated']);
		expect(new Set(all.map((e) => e.id)).size).toBe(2);
	});

	it('filters by actor, action prefix, target and time window, and caps the limit', async () => {
		let t = Date.parse('2026-09-28T00:00:00Z');
		const log = new ActivityLogService({ dir, now: () => new Date((t += 24 * 3600 * 1000)), logger: quiet() });
		// 09-29 owner team.updated, 09-30 agent decision.asked, 10-01 owner decision.resolved, 10-02 system team.deleted
		log.record({ actor: { type: 'owner' }, action: 'team.updated', target: { type: 'team', id: 't1' } });
		log.record({ actor: { type: 'agent', id: 'dev-ann' }, action: 'decision.asked', target: { type: 'decision', id: 'd1' } });
		log.record({ actor: { type: 'owner', id: 'U1' }, action: 'decision.resolved', target: { type: 'decision', id: 'd1' } });
		log.record({ actor: { type: 'system', id: 'scheduler:nightly' }, action: 'team.deleted', target: { type: 'team', id: 't1' } });
		await log.flush();
		expect(fs.readdirSync(dir).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);

		expect((await log.list({ actorType: 'owner' })).map((e) => e.action)).toEqual(['decision.resolved', 'team.updated']);
		expect((await log.list({ actorId: 'dev-ann' })).map((e) => e.action)).toEqual(['decision.asked']);
		expect((await log.list({ action: 'team.' })).map((e) => e.action)).toEqual(['team.deleted', 'team.updated']);
		expect((await log.list({ action: 'team.updated' })).map((e) => e.action)).toEqual(['team.updated']);
		expect((await log.list({ targetType: 'decision', targetId: 'd1' })).map((e) => e.action)).toEqual(['decision.resolved', 'decision.asked']);
		expect((await log.list({ since: '2026-10-01T00:00:00Z' })).map((e) => e.action)).toEqual(['team.deleted', 'decision.resolved']);
		expect((await log.list({ until: '2026-09-30T23:59:59Z' })).map((e) => e.action)).toEqual(['decision.asked', 'team.updated']);
		expect((await log.list({ limit: 1 })).map((e) => e.action)).toEqual(['team.deleted']);
	});

	it('masks secret-looking keys and cuts long strings before writing', async () => {
		const log = new ActivityLogService({ dir, logger: quiet() });
		log.record({
			actor: { type: 'owner' },
			action: 'team.updated',
			target: { type: 'team', id: 't1' },
			after: { slackBotToken: 'xoxb-123', apiKey: 'k', nested: { password: 'p', fine: 'ok' }, long: 'x'.repeat(500) },
			note: 'y'.repeat(500),
		});
		await log.flush();
		const [e] = await log.list();
		expect(e.after).toEqual({ slackBotToken: '***', apiKey: '***', nested: { password: '***', fine: 'ok' }, long: `${'x'.repeat(400)}…` });
		expect(e.note).toHaveLength(401);
		expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')).not.toContain('xoxb-123');
	});

	it('skips damaged lines and an empty directory, and logs instead of throwing on a failed write', async () => {
		fs.writeFileSync(path.join(dir, '2026-10.jsonl'), 'not json\n{"id":"a","ts":"2026-10-01T00:00:00.000Z","action":"x","actor":{"type":"owner"},"target":{"type":"t","id":"1"}}\n{"half":true}\n');
		const log = new ActivityLogService({ dir, logger: quiet() });
		expect((await log.list()).map((e) => e.id)).toEqual(['a']);
		expect(await new ActivityLogService({ dir: path.join(dir, 'missing'), logger: quiet() }).list()).toEqual([]);

		const logger = quiet();
		const failing: ActivityFsOps = {
			mkdir: async () => undefined,
			appendFile: async () => {
				throw new Error('disk full');
			},
			readFile: async () => '',
			readdir: async () => [],
		};
		const broken = new ActivityLogService({ dir, fs: failing, logger });
		expect(() => broken.record({ actor: { type: 'system' }, action: 'x', target: { type: 't', id: '1' } })).not.toThrow();
		await broken.flush();
		expect(logger.warn).toHaveBeenCalledWith('Activity log write failed', expect.objectContaining({ error: 'disk full' }));
	});

	it('recordActivity writes to the process-wide log and never throws', async () => {
		const log = new ActivityLogService({ dir, logger: quiet() });
		setActivityLogForTesting(log);
		expect(getActivityLog()).toBe(log);
		recordActivity({ actor: { type: 'owner' }, action: 'team.updated', target: { type: 'team', id: 't1' } });
		await log.flush();
		expect(await log.list()).toHaveLength(1);
	});
});

describe('helpers', () => {
	it('summarizeChange keeps only the changed fields, masked, and leaves out equal and absent ones', () => {
		expect(summarizeChange({ name: 'Ella', role: 'dev', modelId: 'a' }, { name: 'Ella', role: 'lead', modelId: undefined, token: 'xoxb' })).toEqual({
			before: { role: 'dev', modelId: 'a' },
			after: { role: 'lead', token: '***' },
		});
		expect(summarizeChange(null, { name: 'New' })).toEqual({ after: { name: 'New' } });
		expect(summarizeChange({ name: 'Old' }, null)).toEqual({ before: { name: 'Old' } });
		expect(summarizeChange({ a: 1 }, { a: 1 })).toEqual({});
	});

	it('maskForActivity walks arrays and objects', () => {
		expect(maskForActivity([{ secret: 's', n: 1 }, 'ok', null])).toEqual([{ secret: '***', n: 1 }, 'ok', null]);
		expect(maskForActivity({ authorization: undefined })).toEqual({ authorization: undefined });
	});

	it('actorFromCaller maps identities to owner / agent / system', () => {
		expect(actorFromCaller({ kind: 'owner', via: 'owner-session' })).toEqual({ type: 'owner', via: 'owner-session' });
		expect(actorFromCaller({ kind: 'relay-owner', via: 'relay' })).toEqual({ type: 'owner', via: 'relay' });
		expect(actorFromCaller({ kind: 'cloud', via: 'cloud' })).toEqual({ type: 'owner', via: 'cloud' });
		expect(actorFromCaller({ kind: 'agent', via: 'agent-badge', session: 'dev-ann' })).toEqual({ type: 'agent', id: 'dev-ann', via: 'agent-badge' });
		expect(actorFromCaller({ kind: 'scheduler', via: 'scheduler', sender: 'scheduler:nightly' })).toEqual({ type: 'system', id: 'scheduler:nightly', via: 'scheduler' });
		expect(actorFromCaller({ kind: 'anonymous', via: 'none' })).toEqual({ type: 'system', id: 'anonymous', via: 'none' });
	});

	it('isActivityActorType accepts the three kinds only', () => {
		expect(isActivityActorType('owner')).toBe(true);
		expect(isActivityActorType('agent')).toBe(true);
		expect(isActivityActorType('system')).toBe(true);
		expect(isActivityActorType('robot')).toBe(false);
		expect(isActivityActorType(1)).toBe(false);
	});
});
