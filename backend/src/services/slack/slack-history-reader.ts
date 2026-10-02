/**
 * Slack history reader — `conversations.history` / `conversations.replies`
 * over the plain Web API (no Cloud, no Bolt), for the inbound backfill.
 *
 * @module services/slack/slack-history-reader
 */

import { SLACK_INBOUND_BACKFILL_CONSTANTS } from '../../constants.js';
import type { BackfillSlackMessage } from './slack-inbound-backfill.service.js';

const C = SLACK_INBOUND_BACKFILL_CONSTANTS;

/** fetch-compatible function (injectable for tests). */
export type HistoryFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The two reads the backfill needs. */
export interface SlackHistoryReader {
	/** Top-level messages after `oldestTs`, oldest first */
	fetchHistory(channelId: string, oldestTs: string): Promise<BackfillSlackMessage[]>;
	/** Replies of a thread after `oldestTs`, oldest first, root excluded */
	fetchReplies(channelId: string, threadTs: string, oldestTs: string): Promise<BackfillSlackMessage[]>;
}

/**
 * Build a reader that calls the Slack Web API with a bot token.
 *
 * @param getToken - Current bot token (null = Slack not configured)
 * @param fetchImpl - fetch override for tests
 * @returns The reader; its methods throw on a Slack `ok:false` or HTTP error
 */
export function createSlackHistoryReader(
	getToken: () => string | null,
	fetchImpl: HistoryFetch = (input, init) => fetch(input, init),
): SlackHistoryReader {
	async function call(method: string, params: Record<string, string>): Promise<{ messages?: BackfillSlackMessage[] }> {
		const token = getToken();
		if (!token) throw new Error('Slack bot token not available');
		const res = await fetchImpl(`${C.API_BASE}/${method}?${new URLSearchParams(params).toString()}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
		});
		const body = (await res.json()) as { ok: boolean; error?: string; messages?: BackfillSlackMessage[] };
		if (!res.ok || !body.ok) throw new Error(`${method} failed: ${body.error ?? res.status}`);
		return body;
	}
	return {
		async fetchHistory(channelId, oldestTs) {
			const body = await call('conversations.history', { channel: channelId, oldest: oldestTs, limit: String(C.HISTORY_LIMIT) });
			// history is newest first
			return [...(body.messages ?? [])].reverse();
		},
		async fetchReplies(channelId, threadTs, oldestTs) {
			const body = await call('conversations.replies', { channel: channelId, ts: threadTs, oldest: oldestTs, limit: String(C.HISTORY_LIMIT) });
			return (body.messages ?? []).filter((m) => m.ts !== threadTs);
		},
	};
}
