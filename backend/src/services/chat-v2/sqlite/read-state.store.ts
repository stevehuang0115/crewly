/**
 * ReadStateStore — the owner's per-channel read marker (#1400).
 *
 * One row per channel in `chat_read_state` holds `last_read_seq`: every message
 * with `seq <= last_read_seq` counts as read. Unread = messages that are not
 * the owner's own and not system notes with `seq > last_read_seq`. A channel
 * with no row has marker 0.
 *
 * Authorization lives in `ChatV2Service`; this store only does the SQL.
 *
 * @module services/chat-v2/sqlite/read-state.store
 */

import type { ChatDatabase } from './chat-db.js';

/** Read marker plus the unread count it implies, as sent on the wire. */
export interface ChannelReadState {
  channelId: string;
  lastReadSeq: number;
  unreadCount: number;
}

/** SQL predicate selecting the messages that can be unread (aliased `m`). */
const UNREAD_PREDICATE = `m.sender_type != 'user' AND m.content_type != 'system_note'`;

/** SQLite-backed store for the owner's read markers. */
export class ReadStateStore {
  constructor(private readonly db: ChatDatabase) {}

  /**
   * Current marker for a channel.
   *
   * @param channelId - Channel id
   * @returns `last_read_seq`, or 0 when the channel has no row
   */
  getLastReadSeq(channelId: string): number {
    const row = this.db
      .prepare('SELECT last_read_seq FROM chat_read_state WHERE channel_id = ?')
      .get(channelId) as { last_read_seq: number } | undefined;
    return row?.last_read_seq ?? 0;
  }

  /**
   * Number of unread messages in a channel for a given marker.
   *
   * @param channelId - Channel id
   * @param lastReadSeq - Marker to count past
   * @returns Unread count
   */
  countUnreadAfter(channelId: string, lastReadSeq: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_messages m
         WHERE m.channel_id = ? AND m.seq > ? AND ${UNREAD_PREDICATE}`,
      )
      .get(channelId, lastReadSeq) as { n: number };
    return row.n;
  }

  /**
   * Marker and unread count of one channel.
   *
   * @param channelId - Channel id
   * @returns The channel's read state
   */
  get(channelId: string): ChannelReadState {
    const lastReadSeq = this.getLastReadSeq(channelId);
    return { channelId, lastReadSeq, unreadCount: this.countUnreadAfter(channelId, lastReadSeq) };
  }

  /**
   * Move the marker forward only: `max(current, seq ?? channel max seq)`.
   * A `seq` beyond the channel's last message is clamped to it, so a stale or
   * bogus client value can never hide messages that arrive later.
   *
   * @param channelId - Channel id
   * @param seq - Read up to this seq; omit to read everything
   * @param nowIso - Clock for `updated_at` (tests)
   * @returns The new state
   */
  markRead(channelId: string, seq?: number, nowIso: string = new Date().toISOString()): ChannelReadState {
    const maxSeq = this.maxSeq(channelId);
    const target = Math.min(seq === undefined ? maxSeq : seq, maxSeq);
    const next = Math.max(this.getLastReadSeq(channelId), target);
    this.write(channelId, next, nowIso);
    return this.get(channelId);
  }

  /**
   * Mark the message at `seq` (and everything after it) unread: the marker
   * becomes `seq - 1`. May move backward — that is the point.
   *
   * @param channelId - Channel id
   * @param seq - `seq` of the message to keep unread (>= 1)
   * @param nowIso - Clock for `updated_at` (tests)
   * @returns The new state
   */
  markUnread(channelId: string, seq: number, nowIso: string = new Date().toISOString()): ChannelReadState {
    this.write(channelId, Math.max(0, seq - 1), nowIso);
    return this.get(channelId);
  }

  /**
   * Channels (among `channelIds`) with unread messages, with their markers.
   * One grouped query instead of one per channel.
   *
   * @param channelIds - Candidate channel ids
   * @returns Only channels with `unreadCount > 0`
   */
  listUnread(channelIds: string[]): ChannelReadState[] {
    if (channelIds.length === 0) return [];
    const out: ChannelReadState[] = [];
    // Chunk to stay under SQLite's bound-parameter limit.
    for (let i = 0; i < channelIds.length; i += 500) {
      const chunk = channelIds.slice(i, i + 500);
      const marks = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT m.channel_id AS channelId,
                  COALESCE(rs.last_read_seq, 0) AS lastReadSeq,
                  COUNT(*) AS unreadCount
           FROM chat_messages m
           LEFT JOIN chat_read_state rs ON rs.channel_id = m.channel_id
           WHERE m.channel_id IN (${marks})
             AND m.seq > COALESCE(rs.last_read_seq, 0)
             AND ${UNREAD_PREDICATE}
           GROUP BY m.channel_id`,
        )
        .all(...chunk) as ChannelReadState[];
      out.push(...rows);
    }
    return out;
  }

  /**
   * Drop a channel's marker (used when the channel is deleted).
   *
   * @param channelId - Channel id
   */
  delete(channelId: string): void {
    this.db.prepare('DELETE FROM chat_read_state WHERE channel_id = ?').run(channelId);
  }

  /** Largest `seq` in a channel, 0 when empty. */
  private maxSeq(channelId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM chat_messages WHERE channel_id = ?')
      .get(channelId) as { s: number };
    return row.s;
  }

  /** Upsert the marker. */
  private write(channelId: string, lastReadSeq: number, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO chat_read_state (channel_id, last_read_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET last_read_seq = excluded.last_read_seq,
                                               updated_at = excluded.updated_at`,
      )
      .run(channelId, lastReadSeq, nowIso);
  }
}
