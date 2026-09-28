/**
 * CloudOutboxStore — reads and trims the durable `cloud_outbox` that the
 * `chat_messages` triggers fill, keeps the uploader's `cloud_sync_state`, and
 * pages history for the first-sign-in backfill
 * (specs/unified-conversations-cloud-store.md §A.4, §B.3, §B.4).
 *
 * The outbox is on disk, so a machine that is offline or signed out loses
 * nothing: rows wait until the uploader drains them.
 *
 * @module services/chat-v2/sqlite/cloud-outbox.store
 */

import type { ChatChannelType, ChatContentType, ChatSenderType } from '../types.js';
import type { ChatDatabase } from './chat-db.js';

/** One outbox row. */
export interface OutboxEntry {
  seq: number;
  messageId: string;
  op: 'upsert' | 'delete';
  enqueuedAt: number;
}

/** Attachment metadata (never the bytes — owner decision O4). */
export interface UploadAttachmentRow {
  kind: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
}

/** A message with everything the uploader sends about it. */
export interface UploadMessageRow {
  rowid: number;
  id: string;
  channelId: string;
  senderType: ChatSenderType;
  senderId: string;
  content: string;
  contentType: ChatContentType;
  createdAt: number;
  metadata: string | null;
  mentions: string | null;
  threadId: string | null;
  source: string | null;
  direction: string | null;
  senderKind: string | null;
  agentSession: string | null;
  extRef: string | null;
  cloudSync: number | null;
  channelName: string;
  channelType: ChatChannelType;
  /** First member of a huddle — the agent a message addressed to nobody in particular is filed under. */
  leadMember: string | null;
  attachments: UploadAttachmentRow[];
}

/** Position in `created_at ASC, rowid ASC` order. */
export interface BackfillCursor {
  createdAt: number;
  rowid: number;
}

/** Raw SELECT shape before attachments are attached. */
interface RawUploadRow {
  rowid: number;
  id: string;
  channel_id: string;
  sender_type: ChatSenderType;
  sender_id: string;
  content: string;
  content_type: ChatContentType;
  created_at: number;
  metadata: string | null;
  mentions: string | null;
  thread_id: string | null;
  source: string | null;
  direction: string | null;
  sender_kind: string | null;
  agent_session: string | null;
  ext_ref: string | null;
  cloud_sync: number | null;
  channel_name: string | null;
  channel_type: ChatChannelType | null;
  lead_member: string | null;
}

/** Columns of an upload row. */
const UPLOAD_COLUMNS = `
  m.rowid AS rowid, m.id, m.channel_id, m.sender_type, m.sender_id, m.content, m.content_type,
  m.created_at, m.metadata, m.mentions, m.thread_id, m.source, m.direction, m.sender_kind,
  m.agent_session, m.ext_ref, m.cloud_sync, c.name AS channel_name, c.type AS channel_type,
  (SELECT member_session FROM chat_channel_members cm
    WHERE cm.channel_id = m.channel_id ORDER BY cm.joined_at ASC, cm.member_session ASC LIMIT 1) AS lead_member
`;

/** SQLite's bound-parameter ceiling is 999 on old builds; stay well under it. */
const IN_CHUNK = 500;

/** SQLite-backed outbox + sync-state store. */
export class CloudOutboxStore {
  constructor(private readonly db: ChatDatabase) {}

  /**
   * The oldest outbox rows, in upload order.
   *
   * @param limit - Maximum rows
   * @returns Rows ordered by `seq`
   */
  peek(limit: number): OutboxEntry[] {
    const rows = this.db
      .prepare('SELECT seq, message_id, op, enqueued_at FROM cloud_outbox ORDER BY seq ASC LIMIT ?')
      .all(limit) as Array<{ seq: number; message_id: string; op: 'upsert' | 'delete'; enqueued_at: number }>;
    return rows.map((r) => ({ seq: r.seq, messageId: r.message_id, op: r.op, enqueuedAt: r.enqueued_at }));
  }

  /**
   * Remove every outbox row up to and including `seq` (Cloud has them).
   *
   * @param seq - Highest acknowledged outbox seq
   * @returns Rows removed
   */
  ackThrough(seq: number): number {
    return this.db.prepare('DELETE FROM cloud_outbox WHERE seq <= ?').run(seq).changes;
  }

  /** @returns Number of rows waiting in the outbox */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n;
  }

  /** Empty the outbox (account switch / sign-out: the backfill re-sends the window). */
  clear(): void {
    this.db.exec('DELETE FROM cloud_outbox');
  }

  /**
   * Keep the outbox bounded while nothing drains it: drop rows older than
   * `olderThanMs`, then the oldest beyond `maxRows`.
   *
   * @param options.maxRows - Row cap
   * @param options.olderThanMs - Drop rows enqueued before this epoch ms
   * @returns Rows dropped (a history gap on Cloud when > 0)
   */
  trim(options: { maxRows: number; olderThanMs: number }): number {
    let dropped = this.db.prepare('DELETE FROM cloud_outbox WHERE enqueued_at < ?').run(options.olderThanMs).changes;
    const excess = this.count() - options.maxRows;
    if (excess > 0) {
      dropped += this.db
        .prepare('DELETE FROM cloud_outbox WHERE seq IN (SELECT seq FROM cloud_outbox ORDER BY seq ASC LIMIT ?)')
        .run(excess).changes;
    }
    return dropped;
  }

  /**
   * Load messages by id, with their channel and attachment metadata.
   *
   * @param ids - Message ids
   * @returns Map of id → row (ids with no row — deleted since — are absent)
   */
  getMessages(ids: readonly string[]): Map<string, UploadMessageRow> {
    const out = new Map<string, UploadMessageRow>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT ${UPLOAD_COLUMNS}
           FROM chat_messages m LEFT JOIN chat_channels c ON c.id = m.channel_id
           WHERE m.id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as RawUploadRow[];
      for (const row of this.withAttachments(rows)) out.set(row.id, row);
    }
    return out;
  }

  /**
   * One page of syncable history for the backfill, oldest first.
   *
   * @param sinceMs - Only rows created at/after this epoch ms (the plan window)
   * @param after - Resume after this position (exclusive), or null to start
   * @param limit - Page size
   * @returns Rows in `created_at, rowid` order
   */
  backfillPage(sinceMs: number, after: BackfillCursor | null, limit: number): UploadMessageRow[] {
    const params: number[] = [sinceMs];
    let where = 'm.created_at >= ? AND COALESCE(m.cloud_sync, 1) = 1';
    if (after) {
      where += ' AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))';
      params.push(after.createdAt, after.createdAt, after.rowid);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT ${UPLOAD_COLUMNS}
         FROM chat_messages m LEFT JOIN chat_channels c ON c.id = m.channel_id
         WHERE ${where}
         ORDER BY m.created_at ASC, m.rowid ASC
         LIMIT ?`,
      )
      .all(...params) as RawUploadRow[];
    return this.withAttachments(rows);
  }

  /**
   * Read a sync-state value.
   *
   * @param key - State key
   * @returns The value, or null
   */
  getState(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM cloud_sync_state WHERE k = ?').get(key) as { v: string | null } | undefined;
    return row?.v ?? null;
  }

  /**
   * Write (or with `null`, remove) a sync-state value.
   *
   * @param key - State key
   * @param value - Value, or null to delete
   */
  setState(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM cloud_sync_state WHERE k = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO cloud_sync_state(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value);
  }

  /**
   * Remove every sync-state value except the ones listed.
   *
   * @param keep - Keys to preserve
   */
  clearState(keep: readonly string[] = []): void {
    if (keep.length === 0) {
      this.db.exec('DELETE FROM cloud_sync_state');
      return;
    }
    this.db.prepare(`DELETE FROM cloud_sync_state WHERE k NOT IN (${keep.map(() => '?').join(', ')})`).run(...keep);
  }

  /**
   * Attach attachment metadata and map to the camel-case row shape.
   *
   * @param rows - Raw rows
   * @returns Upload rows
   */
  private withAttachments(rows: RawUploadRow[]): UploadMessageRow[] {
    if (rows.length === 0) return [];
    const byMessage = new Map<string, UploadAttachmentRow[]>();
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const atts = this.db
        .prepare(
          `SELECT message_id, kind, mime_type, size_bytes, original_name FROM chat_attachments
           WHERE message_id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as Array<{ message_id: string; kind: string; mime_type: string; size_bytes: number; original_name: string | null }>;
      for (const a of atts) {
        const list = byMessage.get(a.message_id) ?? [];
        list.push({ kind: a.kind, mimeType: a.mime_type, sizeBytes: a.size_bytes, originalName: a.original_name });
        byMessage.set(a.message_id, list);
      }
    }
    return rows.map((r) => ({
      rowid: r.rowid,
      id: r.id,
      channelId: r.channel_id,
      senderType: r.sender_type,
      senderId: r.sender_id,
      content: r.content,
      contentType: r.content_type,
      createdAt: r.created_at,
      metadata: r.metadata,
      mentions: r.mentions,
      threadId: r.thread_id,
      source: r.source,
      direction: r.direction,
      senderKind: r.sender_kind,
      agentSession: r.agent_session,
      extRef: r.ext_ref,
      cloudSync: r.cloud_sync,
      channelName: r.channel_name ?? r.channel_id,
      channelType: r.channel_type ?? 'dm',
      leadMember: r.lead_member,
      attachments: byMessage.get(r.id) ?? [],
    }));
  }
}
