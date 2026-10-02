/**
 * Tests for the Slack history reader.
 *
 * @module services/slack/slack-history-reader.test
 */

import { createSlackHistoryReader } from './slack-history-reader.js';

const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

describe('createSlackHistoryReader', () => {
	it('returns history oldest first and sends the bearer token and oldest', async () => {
		const f = jest.fn().mockResolvedValue(reply({ ok: true, messages: [{ ts: '3' }, { ts: '2' }] }));
		const r = createSlackHistoryReader(() => 'xoxb-t', f);
		expect((await r.fetchHistory('C1', '1.0')).map((m) => m.ts)).toEqual(['2', '3']);
		const [url, init] = f.mock.calls[0];
		expect(url).toContain('conversations.history');
		expect(url).toContain('channel=C1');
		expect(url).toContain('oldest=1.0');
		expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer xoxb-t' });
	});

	it('drops the thread root from replies', async () => {
		const f = jest.fn().mockResolvedValue(reply({ ok: true, messages: [{ ts: '5' }, { ts: '6' }] }));
		const r = createSlackHistoryReader(() => 't', f);
		expect((await r.fetchReplies('C1', '5', '1.0')).map((m) => m.ts)).toEqual(['6']);
	});

	it('throws on a Slack error and when there is no token', async () => {
		const f = jest.fn().mockResolvedValue(reply({ ok: false, error: 'ratelimited' }));
		await expect(createSlackHistoryReader(() => 't', f).fetchHistory('C1', '1')).rejects.toThrow('ratelimited');
		await expect(createSlackHistoryReader(() => null, f).fetchHistory('C1', '1')).rejects.toThrow('token');
	});
});
