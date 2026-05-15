/**
 * MessageStore — CRUD for `chat_messages` plus the server-side
 * sequence assigner described in tech-spec §4.
 *
 * Key properties:
 * - Every insert assigns `seq = MAX(seq)+1` for the channel inside a
 *   transaction that also bumps `chat_channels.last_message_at`.
 * - Concurrent writes serialize through the SQLite write lock; the
 *   `UNIQUE(channel_id, seq)` constraint is a belt-and-braces guard.
 * - `clientMessageId` is an optional idempotency key stored in
 *   `metadata.clientMessageId`; duplicate inserts surface the
 *   persisted row instead of erroring.
 *
 * @module services/chat-v2/sqlite/message.store
 */

import { randomUUID } from 'crypto';
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatContentType,
  type ChatMessageCursorPayload,
  type ChatMessageRow,
  type ChatSenderType,
} from '../types.js';
import type { ChatDatabase } from './chat-db.js';

// ---------------------------------------------------------------------------
// Constants — shared SELECT column list, single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical column list for `chat_messages` SELECTs. Including all Phase A
 * columns (mentions / thread_id) here keeps every read path in this store
 * mapping to a fully-populated `ChatMessageRow`.
 */
const MESSAGE_SELECT_COLUMNS = `
  id, channel_id, seq, sender_type, sender_id, content, content_type,
  created_at, metadata, mentions, thread_id
`;

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Encode a pagination cursor to an opaque base64url string.
 *
 * @param payload - Cursor fields
 * @returns Opaque base64url-encoded JSON string
 */
export function encodeCursor(payload: ChatMessageCursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

/**
 * Decode an opaque pagination cursor.
 *
 * @param cursor - The cursor string (or null/undefined)
 * @returns The decoded payload, or null if input is missing
 * @throws {ChatError} `invalid_cursor` (400) if the cursor fails to parse or
 *   doesn't contain the expected fields.
 */
export function decodeCursor(cursor: string | null | undefined): ChatMessageCursorPayload | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Partial<ChatMessageCursorPayload>;
    if (
      typeof parsed.seq !== 'number' ||
      !Number.isFinite(parsed.seq) ||
      typeof parsed.channelId !== 'string' ||
      parsed.channelId.length === 0
    ) {
      throw new Error('missing required fields');
    }
    return { seq: parsed.seq, channelId: parsed.channelId };
  } catch (err) {
    throw new ChatError(
      CHAT_ERROR_CODES.INVALID_CURSOR,
      400,
      `Cursor failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** Options for inserting a message. */
export interface MessageInsertInput {
  channelId: string;
  senderType: ChatSenderType;
  senderId: string;
  content: string;
  contentType?: ChatContentType;
  /** Optional metadata object. Will be JSON-stringified. */
  metadata?: Record<string, unknown>;
  /** Stable client id for idempotent retries; folded into metadata. */
  clientMessageId?: string;
  /**
   * Phase A (SEALED §3.2) — array of mention IDs (member or team)
   * referenced inline in `content`. Stored as a JSON-encoded string in
   * the `mentions` column. Empty array or omitted → null in storage.
   */
  mentions?: string[];
  /**
   * Phase A (SEALED §3.2) — Slack-style thread root. When set, this
   * message is a reply within the thread rooted at `threadId`. Omitted
   * for top-level channel messages.
   */
  threadId?: string;
  /** Override the insert clock (tests). */
  nowMs?: number;
  /** Override the generated id (tests / deterministic callers). */
  id?: string;
}

/** Result of inserting a message — includes whether this was a dedupe hit. */
export interface MessageInsertResult {
  row: ChatMessageRow;
  /** True when the returned row pre-existed under the given clientMessageId. */
  deduped: boolean;
}

/** Options for listing messages with cursor pagination. */
export interface MessageListOptions {
  cursor?: string | null;
  /** 1..100, default 50. */
  limit?: number;
  /** `backward` (default) loads older; `forward` loads newer. */
  direction?: 'backward' | 'forward';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** SQLite-backed store for chat messages. */
export class MessageStore {
  /** Cap on a single page size. */
  static readonly MAX_LIMIT = 100;
  /** Default page size when caller didn't specify. */
  static readonly DEFAULT_LIMIT = 50;

  constructor(private readonly db: ChatDatabase) {}

  /**
   * Insert a message into the channel.
   *
   * Performs sequence assignment (`MAX(seq)+1`) and idempotency dedupe in a
   * single transaction. If a row with the same `(channel_id, clientMessageId)`
   * already exists, returns it with `deduped=true` instead of inserting.
   *
   * Also updates the parent channel's `last_message_at`.
   *
   * @param input - Insert payload
   * @returns The persisted row plus a dedupe flag
   * @throws {ChatError} `channel_not_found` (404) if the channel is missing
   *   (or archived and we want to refuse).
   */
  insert(input: MessageInsertInput): MessageInsertResult {
    const id = input.id ?? randomUUID();
    const createdAt = input.nowMs ?? Date.now();
    const contentType: ChatContentType = input.contentType ?? 'markdown';
    const metadataObj = {
      ...(input.metadata ?? {}),
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    };
    const metadataHasKeys = Object.keys(metadataObj).length > 0;
    const metadataJson = metadataHasKeys ? JSON.stringify(metadataObj) : null;

    // Phase A: serialize mentions to JSON. Treat null/empty as DB-null so
    // legacy rows and "no mentions" share a representation; the read-side
    // mapper translates DB-null back to [].
    const mentionsJson =
      input.mentions && input.mentions.length > 0 ? JSON.stringify(input.mentions) : null;
    const threadId = input.threadId ?? null;

    const txn = this.db.transaction((): MessageInsertResult => {
      // Dedupe check — same clientMessageId + channel → return existing row.
      if (input.clientMessageId) {
        const existing = this.db
          .prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS}
             FROM chat_messages
             WHERE channel_id = ?
               AND json_extract(metadata, '$.clientMessageId') = ?
             LIMIT 1`,
          )
          .get(input.channelId, input.clientMessageId) as ChatMessageRow | undefined;
        if (existing) {
          return { row: existing, deduped: true };
        }
      }

      // Channel existence check — FK catches it too but we want a typed error
      // with a sensible status code.
      const channel = this.db
        .prepare('SELECT id, archived_at FROM chat_channels WHERE id = ?')
        .get(input.channelId) as { id: string; archived_at: number | null } | undefined;
      if (!channel) {
        throw new ChatError(
          CHAT_ERROR_CODES.CHANNEL_NOT_FOUND,
          404,
          `Channel ${input.channelId} not found`,
        );
      }
      if (channel.archived_at) {
        throw new ChatError(
          CHAT_ERROR_CODES.CHANNEL_ARCHIVED,
          404,
          `Channel ${input.channelId} is archived`,
        );
      }

      // Sequence assignment + insert.
      const seqRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
           FROM chat_messages
           WHERE channel_id = ?`,
        )
        .get(input.channelId) as { next_seq: number };

      this.db
        .prepare(
          `INSERT INTO chat_messages
             (id, channel_id, seq, sender_type, sender_id, content, content_type,
              created_at, metadata, mentions, thread_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.channelId,
          seqRow.next_seq,
          input.senderType,
          input.senderId,
          input.content,
          contentType,
          createdAt,
          metadataJson,
          mentionsJson,
          threadId,
        );

      // Touch last_message_at on the parent channel.
      this.db
        .prepare(
          `UPDATE chat_channels
           SET last_message_at = ?
           WHERE id = ?
             AND (last_message_at IS NULL OR last_message_at < ?)`,
        )
        .run(createdAt, input.channelId, createdAt);

      const row = this.db
        .prepare(
          `SELECT ${MESSAGE_SELECT_COLUMNS}
           FROM chat_messages
           WHERE id = ?`,
        )
        .get(id) as ChatMessageRow;
      return { row, deduped: false };
    });

    return txn();
  }

  /**
   * Look up a message by its id.
   *
   * @param id - The message id
   * @returns The row, or null
   */
  getById(id: string): ChatMessageRow | null {
    const row = this.db
      .prepare(
        `SELECT ${MESSAGE_SELECT_COLUMNS}
         FROM chat_messages
         WHERE id = ?`,
      )
      .get(id) as ChatMessageRow | undefined;
    return row ?? null;
  }

  /**
   * List messages for a channel with cursor pagination.
   *
   * @param channelId - The channel id to read
   * @param options - Listing options (cursor, limit, direction)
   * @returns An ordered array of rows and cursors for next/prev pages
   */
  listByChannel(
    channelId: string,
    options?: MessageListOptions,
  ): {
    rows: ChatMessageRow[];
    nextCursor: string | null;
    prevCursor: string | null;
  } {
    const direction = options?.direction ?? 'backward';
    const rawLimit = options?.limit ?? MessageStore.DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(rawLimit, MessageStore.MAX_LIMIT));

    const decoded = decodeCursor(options?.cursor);
    if (decoded && decoded.channelId !== channelId) {
      throw new ChatError(
        CHAT_ERROR_CODES.INVALID_CURSOR,
        400,
        'Cursor belongs to a different channel',
      );
    }

    const rows = this.queryPage(channelId, decoded?.seq ?? null, direction, limit);

    const cursors = this.buildCursors(channelId, rows, direction, limit);
    return { rows, ...cursors };
  }

  /** Execute the paginated SELECT for one page of messages. */
  private queryPage(
    channelId: string,
    fromSeq: number | null,
    direction: 'backward' | 'forward',
    limit: number,
  ): ChatMessageRow[] {
    const cols = MESSAGE_SELECT_COLUMNS;

    if (direction === 'backward') {
      // Loading older: newest-first, seq < cursor.
      if (fromSeq === null) {
        return this.db
          .prepare(
            `SELECT ${cols} FROM chat_messages
             WHERE channel_id = ?
             ORDER BY seq DESC
             LIMIT ?`,
          )
          .all(channelId, limit) as ChatMessageRow[];
      }
      return this.db
        .prepare(
          `SELECT ${cols} FROM chat_messages
           WHERE channel_id = ? AND seq < ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(channelId, fromSeq, limit) as ChatMessageRow[];
    }

    // Forward: oldest-first, seq > cursor.
    if (fromSeq === null) {
      return this.db
        .prepare(
          `SELECT ${cols} FROM chat_messages
           WHERE channel_id = ?
           ORDER BY seq ASC
           LIMIT ?`,
        )
        .all(channelId, limit) as ChatMessageRow[];
    }
    return this.db
      .prepare(
        `SELECT ${cols} FROM chat_messages
         WHERE channel_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(channelId, fromSeq, limit) as ChatMessageRow[];
  }

  /** Compute next/prev cursors based on the page result. */
  private buildCursors(
    channelId: string,
    rows: ChatMessageRow[],
    direction: 'backward' | 'forward',
    limit: number,
  ): { nextCursor: string | null; prevCursor: string | null } {
    // `nextCursor` continues in the current direction; `prevCursor` goes back.
    if (rows.length === 0) {
      return { nextCursor: null, prevCursor: null };
    }
    const isLastPage = rows.length < limit;

    if (direction === 'backward') {
      // rows ordered newest → oldest; the last element has the smallest seq.
      const oldest = rows[rows.length - 1];
      const newest = rows[0];
      return {
        nextCursor: isLastPage
          ? null
          : encodeCursor({ seq: oldest.seq, channelId }),
        prevCursor: encodeCursor({ seq: newest.seq, channelId }),
      };
    }

    // forward: rows ordered oldest → newest; the last element has the largest seq.
    const newest = rows[rows.length - 1];
    const oldest = rows[0];
    return {
      nextCursor: isLastPage ? null : encodeCursor({ seq: newest.seq, channelId }),
      prevCursor: encodeCursor({ seq: oldest.seq, channelId }),
    };
  }

  /**
   * Return the current `MAX(seq)` for a channel, or 0 when empty.
   *
   * @param channelId - The channel id
   * @returns The largest seq, or 0
   */
  getLastSeq(channelId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS last_seq
         FROM chat_messages
         WHERE channel_id = ?`,
      )
      .get(channelId) as { last_seq: number };
    return row.last_seq;
  }

  /** Count messages for a channel. Used by tests and metrics. */
  count(channelId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ?')
      .get(channelId) as { n: number };
    return row.n;
  }

  /**
   * Count all messages across every channel in the database.
   *
   * Onboarding v3 (B1) — used by the cold-start detector to decide whether
   * a fresh OSS install should auto-launch onboarding. The "any chat at all
   * means user has been here before" semantics is intentional: the detector
   * combines this with the per-project `firstLaunchedAt` marker to defend
   * against the case where chat-v2 is wiped accidentally on an existing
   * install (a non-zero count short-circuits onboarding before the marker
   * is even consulted).
   *
   * Single COUNT(*) over the index — O(rows) in the worst case but
   * negligible at install time when the table is empty (the only time the
   * caller actually cares about the result).
   *
   * @returns Total number of persisted chat messages
   */
  countAll(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chat_messages')
      .get() as { n: number };
    return row.n;
  }

  /**
   * Merge a JSON patch into an existing message's metadata column.
   * Implementation of Phase 6.0 of the unified-chat-message-store spec
   * — replaces the legacy `ChatService.updateMessageMetadata` so all
   * mutation flows through the canonical store. SQLite's `json_patch`
   * built-in handles the merge atomically.
   *
   * @param id - Message id to update
   * @param patch - Partial metadata object to merge in (shallow merge)
   * @returns The post-update row, or null if the message doesn't exist
   */
  updateMetadata(id: string, patch: Record<string, unknown>): ChatMessageRow | null {
    const patchJson = JSON.stringify(patch);
    const existing = this.db
      .prepare('SELECT metadata FROM chat_messages WHERE id = ?')
      .get(id) as { metadata: string | null } | undefined;
    if (!existing) {
      return null;
    }
    // SQLite's json_patch merges the right operand into the left,
    // adding missing keys and overwriting existing ones. NULL-safe:
    // when the current metadata is NULL we feed an empty object so
    // the patch becomes the final state.
    const baseExpr = existing.metadata ?? '{}';
    this.db
      .prepare(`UPDATE chat_messages SET metadata = json_patch(?, ?) WHERE id = ?`)
      .run(baseExpr, patchJson, id);
    return this.getById(id);
  }

  /**
   * Find messages with `metadata.slackDeliveryStatus = 'pending'` AND a
   * non-empty `metadata.slackChannelId`, created within the past
   * `maxAgeMs`. Used by `NotifyReconciliationService` to retry Slack
   * deliveries that failed mid-flight.
   *
   * The `slackDeliveryStatus` field is set by callers (legacy code and
   * Phase 3 Slack writes) — this method is the canonical replacement
   * for `ChatService.getMessagesWithPendingSlackDelivery`.
   *
   * @param maxAgeMs - Lookback window in milliseconds
   * @param nowMs - Optional clock override for tests
   * @returns Up to `MAX_LIMIT` matching rows, newest first
   */
  findPendingSlackDelivery(maxAgeMs: number, nowMs?: number): ChatMessageRow[] {
    const cutoff = (nowMs ?? Date.now()) - maxAgeMs;
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_SELECT_COLUMNS}
         FROM chat_messages
         WHERE json_extract(metadata, '$.slackDeliveryStatus') = 'pending'
           AND json_extract(metadata, '$.slackChannelId') IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ${MessageStore.MAX_LIMIT}`,
      )
      .all(cutoff) as ChatMessageRow[];
    return rows;
  }
}
