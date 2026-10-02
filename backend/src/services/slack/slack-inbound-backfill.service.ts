/**
 * Slack inbound backfill — recovers owner messages Cloud never delivered.
 *
 * Why: inbound Slack reaches this machine only through the Cloud relay queue.
 * While queue registration fails (2026-10-02: 429 `quota_exceeded`, 17:26–17:58Z)
 * Cloud queues events for a queue nobody polls, and after the machine
 * re-registers under a new queue id they are not redelivered. The owner's
 * 17:35:51Z message was lost silently.
 *
 * What: after a gap, read the channels this machine already talks to straight
 * from Slack (`conversations.history`, plus replies of threads active in the
 * window) and hand every message we have not stored to the SAME inbound
 * handler live events use, so routing and agent wake-ups are identical.
 * Dedup is by Slack channel + ts against the stored conversation log.
 *
 * Pure of I/O: everything it touches is injected, so it is unit-testable.
 *
 * @module services/slack/slack-inbound-backfill.service
 */

import { SLACK_INBOUND_BACKFILL_CONSTANTS } from '../../constants.js';
import type { SlackFile } from '../../types/slack.types.js';

const C = SLACK_INBOUND_BACKFILL_CONSTANTS;

/** The few Slack message fields the backfill reads. */
export interface BackfillSlackMessage {
	ts: string;
	text?: string;
	user?: string;
	bot_id?: string;
	subtype?: string;
	thread_ts?: string;
	reply_count?: number;
	files?: SlackFile[];
	team?: string;
}

/** Minimal logger. */
export interface BackfillLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** Everything the backfill touches outside itself. */
export interface SlackInboundBackfillDeps {
	/** Slack channels this machine has had inbound traffic in since `sinceMs` */
	listChannels: (sinceMs: number, limit: number) => string[];
	/** Top-level messages in a channel after `oldestTs` (Slack ts), oldest first */
	fetchHistory: (channelId: string, oldestTs: string) => Promise<BackfillSlackMessage[]>;
	/** Replies of one thread after `oldestTs`, oldest first (root excluded) */
	fetchReplies: (channelId: string, threadTs: string, oldestTs: string) => Promise<BackfillSlackMessage[]>;
	/** Whether the message is already stored */
	hasMessage: (channelId: string, ts: string) => boolean;
	/**
	 * The shared inbound handler (`SlackService.handleInboundEvent`). It applies
	 * the allow-list itself and returns null when it drops the event.
	 */
	ingest: (event: BackfillIngestEvent) => unknown;
	/** The workspace bot's user id, to skip our own posts */
	getBotUserId: () => string | null;
	now?: () => number;
	logger: BackfillLogger;
}

/** What is handed to the inbound handler. */
export interface BackfillIngestEvent {
	type: 'message';
	channel: string;
	ts: string;
	text?: string;
	user: string;
	thread_ts?: string;
	files?: SlackFile[];
	team?: string;
}

/** Outcome of one backfill run. */
export interface BackfillResult {
	channelsScanned: number;
	messagesExamined: number;
	ingested: number;
}

/** Convert epoch ms to a Slack ts string (`seconds.micros`). */
export function msToSlackTs(ms: number): string {
	return `${(ms / 1000).toFixed(6)}`;
}

/**
 * Backfills missed owner messages after an inbound outage.
 */
export class SlackInboundBackfillService {
	private running = false;

	/** @param deps - Injected collaborators */
	constructor(private readonly deps: SlackInboundBackfillDeps) {}

	/**
	 * Read Slack for owner messages newer than `gapStartMs` (minus a margin)
	 * that this machine has not stored, and ingest them. A message already
	 * stored, from the bot, or empty is
	 * skipped (the handler drops users off the allow-list). One run at a time; never throws.
	 *
	 * @param gapStartMs - When the outage began (epoch ms)
	 * @returns Counts; `channelsScanned` is 0 when there was nothing to scan
	 */
	async run(gapStartMs: number): Promise<BackfillResult> {
		const result: BackfillResult = { channelsScanned: 0, messagesExamined: 0, ingested: 0 };
		if (this.running) return result;
		this.running = true;
		try {
			const now = (this.deps.now ?? Date.now)();
			const since = Math.max(gapStartMs - C.GAP_MARGIN_MS, now - C.MAX_LOOKBACK_MS);
			const oldestTs = msToSlackTs(since);
			const botUserId = this.deps.getBotUserId();
			const channels = this.deps.listChannels(now - C.CHANNEL_ACTIVITY_WINDOW_MS, C.MAX_CHANNELS);
			for (const channelId of channels) {
				result.channelsScanned++;
				try {
					const top = await this.deps.fetchHistory(channelId, oldestTs);
					const batch: BackfillSlackMessage[] = [...top];
					const threads = top
						.filter((m) => (m.reply_count ?? 0) > 0)
						.map((m) => m.thread_ts ?? m.ts)
						.slice(-C.MAX_THREADS_PER_CHANNEL);
					for (const threadTs of threads) {
						batch.push(...(await this.deps.fetchReplies(channelId, threadTs, oldestTs)));
					}
					const seen = new Set<string>();
					for (const m of batch) {
						// A thread root appears in history AND in its replies.
						if (seen.has(m.ts)) continue;
						seen.add(m.ts);
						result.messagesExamined++;
						if (this.ingestOne(channelId, m, botUserId)) result.ingested++;
					}
				} catch (err) {
					this.deps.logger.warn('Slack backfill failed for a channel (continuing)', {
						channelId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			this.deps.logger.info('Slack inbound backfill done', { since: new Date(since).toISOString(), ...result });
			return result;
		} finally {
			this.running = false;
		}
	}

	/** Ingest one message if it is new and from an allowed human. */
	private ingestOne(channelId: string, m: BackfillSlackMessage, botUserId: string | null): boolean {
		if (!m.ts || !m.user || m.bot_id || (botUserId && m.user === botUserId)) return false;
		if (m.subtype && m.subtype !== 'file_share') return false;
		if (!m.text && !(m.files && m.files.length > 0)) return false;
		if (this.deps.hasMessage(channelId, m.ts)) return false;
		const handled = this.deps.ingest({
			type: 'message',
			channel: channelId,
			ts: m.ts,
			text: m.text,
			user: m.user,
			...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
			...(m.files?.length ? { files: m.files } : {}),
			...(m.team ? { team: m.team } : {}),
		});
		return handled !== null && handled !== undefined;
	}
}
