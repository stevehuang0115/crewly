/**
 * Tests for the Slack inbound backfill (CREW-89).
 *
 * @module services/slack/slack-inbound-backfill.service.test
 */

import { SlackInboundBackfillService, msToSlackTs, type BackfillSlackMessage, type SlackInboundBackfillDeps } from './slack-inbound-backfill.service.js';
import { SLACK_INBOUND_BACKFILL_CONSTANTS as C } from '../../constants.js';

const NOW = 1_790_970_000_000;
const GAP = NOW - 30 * 60 * 1000;

function build(over: Partial<SlackInboundBackfillDeps> = {}, history: BackfillSlackMessage[] = []) {
	const ingest = jest.fn().mockReturnValue({ ok: true });
	const deps: SlackInboundBackfillDeps = {
		listChannels: jest.fn().mockReturnValue(['C1']),
		fetchHistory: jest.fn().mockResolvedValue(history),
		fetchReplies: jest.fn().mockResolvedValue([]),
		hasMessage: jest.fn().mockReturnValue(false),
		ingest,
		getBotUserId: () => 'UBOT',
		now: () => NOW,
		logger: { info: jest.fn(), warn: jest.fn() },
		...over,
	};
	return { svc: new SlackInboundBackfillService(deps), deps, ingest };
}

describe('SlackInboundBackfillService', () => {
	it('ingests an owner message missed during the gap', async () => {
		const { svc, ingest } = build({}, [{ ts: '1790962551.360279', text: 'hi', user: 'UOWNER' }]);
		const r = await svc.run(GAP);
		expect(r).toEqual({ channelsScanned: 1, messagesExamined: 1, ingested: 1 });
		expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', channel: 'C1', ts: '1790962551.360279', user: 'UOWNER', text: 'hi' }));
	});

	it('does not duplicate a message already stored', async () => {
		const { svc, ingest } = build({ hasMessage: jest.fn().mockReturnValue(true) }, [{ ts: '1.1', text: 'hi', user: 'UOWNER' }]);
		const r = await svc.run(GAP);
		expect(r.ingested).toBe(0);
		expect(r.messagesExamined).toBe(1);
		expect(ingest).not.toHaveBeenCalled();
	});

	it('does nothing when there was no gap content (empty history)', async () => {
		const { svc, ingest } = build();
		const r = await svc.run(GAP);
		expect(r).toEqual({ channelsScanned: 1, messagesExamined: 0, ingested: 0 });
		expect(ingest).not.toHaveBeenCalled();
	});

	it('skips bot posts, subtypes and empty messages', async () => {
		const { svc, ingest } = build({}, [
			{ ts: '1.1', text: 'x', user: 'UBOT' },
			{ ts: '1.2', text: 'x', user: 'U1', bot_id: 'B1' },
			{ ts: '1.3', text: 'x', user: 'U1', subtype: 'channel_join' },
			{ ts: '1.4', user: 'U1' },
		]);
		expect((await svc.run(GAP)).ingested).toBe(0);
		expect(ingest).not.toHaveBeenCalled();
	});

	it('reads thread replies and ingests each message once', async () => {
		const root: BackfillSlackMessage = { ts: '2.1', text: 'root', user: 'U1', reply_count: 1 };
		const { svc, ingest, deps } = build(
			{ fetchReplies: jest.fn().mockResolvedValue([root, { ts: '2.2', text: 'reply', user: 'U1', thread_ts: '2.1' }]) },
			[root],
		);
		const r = await svc.run(GAP);
		expect(deps.fetchReplies).toHaveBeenCalledWith('C1', '2.1', expect.any(String));
		expect(r.ingested).toBe(2);
		expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ ts: '2.2', thread_ts: '2.1' }));
	});

	it('does not count events the handler drops', async () => {
		const { svc } = build({ ingest: jest.fn().mockReturnValue(null) }, [{ ts: '1.1', text: 'x', user: 'UNOTALLOWED' }]);
		expect((await svc.run(GAP)).ingested).toBe(0);
	});

	it('starts a margin before the gap and never beyond the max lookback', async () => {
		const { svc, deps } = build();
		await svc.run(GAP);
		expect(deps.fetchHistory).toHaveBeenCalledWith('C1', msToSlackTs(GAP - C.GAP_MARGIN_MS));
		await svc.run(NOW - 10 * C.MAX_LOOKBACK_MS);
		expect(deps.fetchHistory).toHaveBeenLastCalledWith('C1', msToSlackTs(NOW - C.MAX_LOOKBACK_MS));
	});

	it('keeps going when one channel fails', async () => {
		const fetchHistory = jest.fn()
			.mockRejectedValueOnce(new Error('ratelimited'))
			.mockResolvedValueOnce([{ ts: '3.1', text: 'ok', user: 'U1' }]);
		const { svc, deps } = build({ listChannels: jest.fn().mockReturnValue(['C1', 'C2']), fetchHistory });
		const r = await svc.run(GAP);
		expect(r.ingested).toBe(1);
		expect(deps.logger.warn).toHaveBeenCalled();
	});
});
