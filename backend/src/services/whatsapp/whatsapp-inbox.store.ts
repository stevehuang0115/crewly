/**
 * WhatsApp Inbox Store
 *
 * Local SQLite store behind the WhatsApp inbox connector: the chats and
 * messages captured from the owner's personal account (read-only), and the
 * reply drafts agents propose. Lives at `~/.crewly/whatsapp/inbox.db`
 * (resolved through `getCrewlyHomePath()`, so `CREWLY_HOME` isolates it).
 *
 * Nothing in here talks to WhatsApp. Sending a draft is the controller's
 * job, gated on the owner's confirmation; this store only records the
 * draft's lifecycle (`pending` → `sending` → `sent` / back to `pending`,
 * or `discarded`) with an atomic claim so a draft can never be sent twice.
 *
 * @module services/whatsapp/whatsapp-inbox.store
 */

import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { WHATSAPP_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { createBareModuleRequire } from '../../utils/node-require.utils.js';
import { loadNativeAddonOrFatal } from '../../utils/native-binding.utils.js';
import type {
  WhatsAppDraft,
  WhatsAppDraftStatus,
  WhatsAppInboxChat,
  WhatsAppInboxEntry,
  WhatsAppInboxMessage,
  WhatsAppMessageKind,
  WhatsAppSearchHit,
} from '../../types/whatsapp.types.js';

/** CJS `require` for the native addon (this module compiles to ESM). */
const nodeRequire = createBareModuleRequire(typeof require === 'function' ? require : null);

/** Type alias for a better-sqlite3 database handle. */
type InboxDatabase = import('better-sqlite3').Database;

/** Owner-only permissions: the inbox holds private conversations. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** In-memory database name accepted by better-sqlite3 (tests). */
export const IN_MEMORY_DB = ':memory:';

/** Idempotent schema; safe to run on every open. */
const INBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  name_rank        INTEGER NOT NULL DEFAULT 0,
  is_group         INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  from_me      INTEGER NOT NULL,
  sender_jid   TEXT,
  sender_name  TEXT,
  text         TEXT NOT NULL DEFAULT '',
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_fromme_ts ON messages(chat_id, from_me, ts);
CREATE INDEX IF NOT EXISTS idx_wa_chats_last ON chats(last_message_at);
CREATE TABLE IF NOT EXISTS drafts (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL UNIQUE,
  code          TEXT NOT NULL UNIQUE,
  chat_id       TEXT NOT NULL,
  text          TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  sent_at       INTEGER,
  discarded_at  INTEGER,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_drafts_status ON drafts(status, created_at);
`;

/** Raw `chats` row. */
interface ChatRow {
  id: string;
  name: string | null;
  name_rank: number;
  is_group: number;
  last_message_at: number | null;
}

/** Raw `messages` row. */
interface MessageRow {
  id: string;
  chat_id: string;
  from_me: number;
  sender_jid: string | null;
  sender_name: string | null;
  text: string;
  ts: number;
  kind: string;
}

/** Raw `drafts` row. */
interface DraftRow {
  id: string;
  seq: number;
  code: string;
  chat_id: string;
  text: string;
  status: string;
  created_at: number;
  created_by: string | null;
  sent_at: number | null;
  discarded_at: number | null;
  last_error: string | null;
}

/** Input for {@link WhatsAppInboxStore.upsertChat}. */
export interface UpsertChatInput {
  /** Chat JID */
  id: string;
  /** Display name, if this source knows one */
  name?: string | null;
  /** Provenance of `name` (see `WHATSAPP_CONSTANTS.NAME_RANKS`); a lower rank never overwrites a higher one */
  nameRank?: number;
  /** Whether the chat is a group (defaults from the JID suffix) */
  isGroup?: boolean;
  /** Epoch ms of the newest message this source knows of (only ever moves forward) */
  lastMessageAt?: number | null;
}

/** Options for {@link WhatsAppInboxStore.listInbox}. */
export interface ListInboxOptions {
  /** Row cap */
  limit: number;
  /** Include group chats (default false — groups are noisy) */
  includeGroups?: boolean;
}

/**
 * Resolve the default inbox database path under the Crewly home.
 *
 * @returns Absolute path to `<crewly home>/whatsapp/inbox.db`
 */
export function getDefaultInboxDbPath(): string {
  return path.join(getCrewlyHomePath(), WHATSAPP_CONSTANTS.DATA_DIR, WHATSAPP_CONSTANTS.INBOX_DB_FILE);
}

/**
 * Format a draft sequence number as its human code.
 *
 * @param seq - Monotonic sequence number
 * @returns Code such as `W12`
 */
export function formatDraftCode(seq: number): string {
  return `${WHATSAPP_CONSTANTS.DRAFT_CODE_PREFIX}${seq}`;
}

/**
 * Parse a user-typed draft code (`W12`, `w12`, `#W12`, `12`) into its sequence number.
 *
 * @param raw - The code as typed
 * @returns The sequence number, or null when the text is not a draft code
 */
export function parseDraftCode(raw: string): number | null {
  const m = /^#?W?(\d+)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Escape `%`, `_` and the escape char itself for a SQL `LIKE ... ESCAPE '\\'`.
 *
 * @param q - Raw search text
 * @returns Pattern-safe text (wrap in `%` yourself)
 */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Whether a JID names a group chat.
 *
 * @param jid - Chat JID
 * @returns True for `...@g.us`
 */
function isGroupJid(jid: string): boolean {
  return jid.endsWith(WHATSAPP_CONSTANTS.GROUP_JID_SUFFIX);
}

/**
 * Map a chats row to the public shape.
 *
 * @param r - Raw row
 * @returns Public chat
 */
function toChat(r: ChatRow): WhatsAppInboxChat {
  return { id: r.id, name: r.name, isGroup: r.is_group === 1, lastMessageAt: r.last_message_at };
}

/**
 * Map a messages row to the public shape.
 *
 * @param r - Raw row
 * @returns Public message
 */
function toMessage(r: MessageRow): WhatsAppInboxMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    fromMe: r.from_me === 1,
    senderJid: r.sender_jid,
    senderName: r.sender_name,
    text: r.text,
    ts: r.ts,
    kind: r.kind as WhatsAppMessageKind,
  };
}

/**
 * Map a drafts row to the public shape.
 *
 * @param r - Raw row
 * @returns Public draft
 */
function toDraft(r: DraftRow): WhatsAppDraft {
  return {
    id: r.id,
    code: r.code,
    seq: r.seq,
    chatId: r.chat_id,
    text: r.text,
    status: r.status as WhatsAppDraftStatus,
    createdAt: r.created_at,
    createdBy: r.created_by,
    sentAt: r.sent_at,
    discardedAt: r.discarded_at,
    lastError: r.last_error,
  };
}

/**
 * SQLite-backed store for the WhatsApp inbox and reply drafts.
 *
 * @example
 * ```typescript
 * const store = new WhatsAppInboxStore(':memory:');
 * store.upsertMessage({ id: 'm1', chatId: '1@s.whatsapp.net', fromMe: false, senderJid: null,
 *   senderName: 'Ann', text: 'hi', ts: Date.now(), kind: 'text' });
 * store.listInbox({ limit: 20 }); // → [{ chat, unansweredCount: 1, ... }]
 * ```
 */
export class WhatsAppInboxStore {
  private readonly db: InboxDatabase;

  /**
   * Open (and migrate) the inbox database.
   *
   * @param dbPath - File path, or `:memory:` for tests. The parent directory
   *   is created owner-only (0700) and the file is chmod 0600.
   * @throws NativeBindingFatalError when better-sqlite3 cannot load
   */
  constructor(dbPath: string = getDefaultInboxDbPath()) {
    const Database = loadNativeAddonOrFatal<typeof import('better-sqlite3')>('better-sqlite3', nodeRequire);
    const inMemory = dbPath === IN_MEMORY_DB;
    if (!inMemory) {
      const dir = path.dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    }
    this.db = new Database(dbPath);
    if (!inMemory) {
      this.db.pragma('journal_mode = WAL');
      try {
        chmodSync(dbPath, PRIVATE_FILE_MODE);
      } catch {
        // Best effort — a filesystem without POSIX modes still works.
      }
    }
    this.db.exec(INBOX_SCHEMA_SQL);
  }

  /**
   * Close the database handle.
   */
  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Chats & messages (capture side)
  // ---------------------------------------------------------------------------

  /**
   * Insert or update a chat.
   *
   * The name only changes when the new source ranks at least as high as the
   * one that set the current name (an address-book name is never replaced by
   * a pushName). `lastMessageAt` only moves forward.
   *
   * @param input - Chat fields known by this source
   */
  upsertChat(input: UpsertChatInput): void {
    const name = input.name && input.name.trim().length > 0 ? input.name.trim() : null;
    const rank = name ? (input.nameRank ?? WHATSAPP_CONSTANTS.NAME_RANKS.CHAT) : WHATSAPP_CONSTANTS.NAME_RANKS.NONE;
    const isGroup = (input.isGroup ?? isGroupJid(input.id)) ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO chats (id, name, name_rank, is_group, last_message_at)
         VALUES (@id, @name, @rank, @isGroup, @last)
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN excluded.name IS NOT NULL AND excluded.name_rank >= chats.name_rank
                       THEN excluded.name ELSE chats.name END,
           name_rank = CASE WHEN excluded.name IS NOT NULL AND excluded.name_rank >= chats.name_rank
                            THEN excluded.name_rank ELSE chats.name_rank END,
           is_group = MAX(chats.is_group, excluded.is_group),
           last_message_at = CASE
             WHEN excluded.last_message_at IS NULL THEN chats.last_message_at
             WHEN chats.last_message_at IS NULL THEN excluded.last_message_at
             ELSE MAX(chats.last_message_at, excluded.last_message_at) END`,
      )
      .run({ id: input.id, name, rank, isGroup, last: input.lastMessageAt ?? null });
  }

  /**
   * Insert or update one message (idempotent on the message id) and advance
   * its chat's `lastMessageAt`, creating the chat row if needed.
   *
   * A re-delivered message keeps its original `fromMe`, chat and timestamp;
   * text, kind and a newly learned sender name are refreshed (edits, late
   * pushNames).
   *
   * @param msg - The message
   */
  upsertMessage(msg: WhatsAppInboxMessage): void {
    this.upsertChat({ id: msg.chatId, lastMessageAt: msg.ts });
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, from_me, sender_jid, sender_name, text, ts, kind)
         VALUES (@id, @chatId, @fromMe, @senderJid, @senderName, @text, @ts, @kind)
         ON CONFLICT(id) DO UPDATE SET
           text = CASE WHEN excluded.text <> '' THEN excluded.text ELSE messages.text END,
           kind = excluded.kind,
           sender_name = COALESCE(excluded.sender_name, messages.sender_name),
           sender_jid = COALESCE(messages.sender_jid, excluded.sender_jid)`,
      )
      .run({
        id: msg.id,
        chatId: msg.chatId,
        fromMe: msg.fromMe ? 1 : 0,
        senderJid: msg.senderJid,
        senderName: msg.senderName,
        text: msg.text,
        ts: msg.ts,
        kind: msg.kind,
      });
  }

  /**
   * Upsert many messages in one transaction (history sync).
   *
   * @param msgs - Messages
   * @returns How many were written
   */
  upsertMessages(msgs: WhatsAppInboxMessage[]): number {
    const tx = this.db.transaction((batch: WhatsAppInboxMessage[]) => {
      for (const m of batch) this.upsertMessage(m);
    });
    tx(msgs);
    return msgs.length;
  }

  /**
   * Upsert many chats in one transaction.
   *
   * @param chats - Chats
   */
  upsertChats(chats: UpsertChatInput[]): void {
    const tx = this.db.transaction((batch: UpsertChatInput[]) => {
      for (const c of batch) this.upsertChat(c);
    });
    tx(chats);
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  /**
   * Look up one chat.
   *
   * @param id - Chat JID
   * @returns The chat, or null
   */
  getChat(id: string): WhatsAppInboxChat | null {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
    return row ? toChat(row) : null;
  }

  /**
   * Chats that need a reply: the newest message is not the owner's.
   *
   * `unansweredCount` counts inbound messages after the owner's last message
   * in that chat (all of them when the owner never wrote there).
   *
   * @param opts - Limit and whether to include groups
   * @returns Entries, newest first
   */
  listInbox(opts: ListInboxOptions): WhatsAppInboxEntry[] {
    const rows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.ts DESC, m.rowid DESC) AS rn
           FROM messages m
         ),
         last_out AS (
           SELECT chat_id, MAX(ts) AS t FROM messages WHERE from_me = 1 GROUP BY chat_id
         )
         SELECT c.id, c.name, c.name_rank, c.is_group, c.last_message_at,
                r.text AS last_text, r.kind AS last_kind, r.sender_name AS last_sender_name, r.ts AS last_ts,
                (SELECT COUNT(*) FROM messages i
                  WHERE i.chat_id = c.id AND i.from_me = 0
                    AND i.ts > COALESCE((SELECT t FROM last_out WHERE last_out.chat_id = c.id), -1)
                ) AS unanswered
         FROM chats c
         JOIN ranked r ON r.chat_id = c.id AND r.rn = 1
         WHERE r.from_me = 0 AND (@includeGroups = 1 OR c.is_group = 0)
         ORDER BY r.ts DESC
         LIMIT @limit`,
      )
      .all({ includeGroups: opts.includeGroups ? 1 : 0, limit: opts.limit }) as Array<
      ChatRow & { last_text: string; last_kind: string; last_sender_name: string | null; last_ts: number; unanswered: number }
    >;
    return rows.map((r) => ({
      chat: toChat(r),
      unansweredCount: r.unanswered,
      lastText: r.last_text,
      lastKind: r.last_kind as WhatsAppMessageKind,
      lastSenderName: r.last_sender_name,
      lastMessageAt: r.last_ts,
    }));
  }

  /**
   * Recent chats, optionally filtered by name or JID substring.
   *
   * @param opts - Limit and optional query
   * @returns Chats, most recently active first (chats with no messages last)
   */
  listChats(opts: { limit: number; q?: string }): WhatsAppInboxChat[] {
    const q = opts.q?.trim();
    const rows = (
      q
        ? this.db
            .prepare(
              `SELECT * FROM chats
               WHERE name LIKE @p ESCAPE '\\' OR id LIKE @p ESCAPE '\\'
               ORDER BY last_message_at IS NULL, last_message_at DESC LIMIT @limit`,
            )
            .all({ p: `%${escapeLike(q)}%`, limit: opts.limit })
        : this.db
            .prepare('SELECT * FROM chats ORDER BY last_message_at IS NULL, last_message_at DESC LIMIT ?')
            .all(opts.limit)
    ) as ChatRow[];
    return rows.map(toChat);
  }

  /**
   * One page of a chat's messages, in chronological order.
   *
   * @param chatId - Chat JID
   * @param opts - Page size and an exclusive upper bound (epoch ms) for paging back
   * @returns The newest `limit` messages older than `before`, oldest first
   */
  listMessages(chatId: string, opts: { limit: number; before?: number }): WhatsAppInboxMessage[] {
    const rows = (
      opts.before !== undefined
        ? this.db
            .prepare('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?')
            .all(chatId, opts.before, opts.limit)
        : this.db
            .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
            .all(chatId, opts.limit)
    ) as MessageRow[];
    return rows.map(toMessage).reverse();
  }

  /**
   * Substring search over message text (case-insensitive for ASCII).
   *
   * @param q - Search text (must be non-empty)
   * @param limit - Row cap
   * @returns Hits, newest first
   */
  search(q: string, limit: number): WhatsAppSearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, c.name AS chat_name FROM messages m
         LEFT JOIN chats c ON c.id = m.chat_id
         WHERE m.text LIKE ? ESCAPE '\\'
         ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(`%${escapeLike(q.trim())}%`, limit) as Array<MessageRow & { chat_name: string | null }>;
    return rows.map((r) => ({ ...toMessage(r), chatName: r.chat_name }));
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /**
   * Record a reply draft with the next monotonic code.
   *
   * @param input - Recipient, text, author session (null = owner) and clock
   * @returns The stored draft (status `pending`)
   */
  createDraft(input: { chatId: string; text: string; createdBy: string | null; now: number }): WhatsAppDraft {
    const create = this.db.transaction((): WhatsAppDraft => {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM drafts').get() as { next: number };
      const seq = row.next;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO drafts (id, seq, code, chat_id, text, status, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, seq, formatDraftCode(seq), input.chatId, input.text, WHATSAPP_CONSTANTS.DRAFT_STATUSES.PENDING, input.now, input.createdBy);
      return this.getDraftById(id) as WhatsAppDraft;
    });
    return create();
  }

  /**
   * Look up a draft by its opaque id.
   *
   * @param id - Draft id
   * @returns The draft, or null
   */
  getDraftById(id: string): WhatsAppDraft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return row ? toDraft(row) : null;
  }

  /**
   * Look up a draft by id or by human code (`W12`, `12`, `#W12`).
   *
   * @param ref - Id or code
   * @returns The draft, or null
   */
  findDraft(ref: string): WhatsAppDraft | null {
    const byId = this.getDraftById(ref);
    if (byId) return byId;
    const seq = parseDraftCode(ref);
    if (seq === null) return null;
    const row = this.db.prepare('SELECT * FROM drafts WHERE seq = ?').get(seq) as DraftRow | undefined;
    return row ? toDraft(row) : null;
  }

  /**
   * List drafts, newest first.
   *
   * @param opts - Optional status filter and row cap
   * @returns Drafts
   */
  listDrafts(opts: { status?: WhatsAppDraftStatus; limit: number }): WhatsAppDraft[] {
    const rows = (
      opts.status
        ? this.db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY seq DESC LIMIT ?').all(opts.status, opts.limit)
        : this.db.prepare('SELECT * FROM drafts ORDER BY seq DESC LIMIT ?').all(opts.limit)
    ) as DraftRow[];
    return rows.map(toDraft);
  }

  /**
   * Atomically move a draft from `pending` to `sending`.
   *
   * Only one caller can win: this is what makes "a draft can't be sent twice"
   * hold under concurrent requests.
   *
   * @param id - Draft id
   * @returns True when this caller now holds the send claim
   */
  claimDraftForSend(id: string): boolean {
    const res = this.db
      .prepare('UPDATE drafts SET status = ? WHERE id = ? AND status = ?')
      .run(WHATSAPP_CONSTANTS.DRAFT_STATUSES.SENDING, id, WHATSAPP_CONSTANTS.DRAFT_STATUSES.PENDING);
    return res.changes === 1;
  }

  /**
   * Mark a claimed draft as sent.
   *
   * @param id - Draft id
   * @param now - Epoch ms of the send
   */
  markDraftSent(id: string, now: number): void {
    this.db
      .prepare('UPDATE drafts SET status = ?, sent_at = ?, last_error = NULL WHERE id = ? AND status = ?')
      .run(WHATSAPP_CONSTANTS.DRAFT_STATUSES.SENT, now, id, WHATSAPP_CONSTANTS.DRAFT_STATUSES.SENDING);
  }

  /**
   * Return a claimed draft to `pending` after a failed send, keeping the error.
   *
   * @param id - Draft id
   * @param error - Why the send failed
   */
  releaseDraftClaim(id: string, error: string): void {
    this.db
      .prepare('UPDATE drafts SET status = ?, last_error = ? WHERE id = ? AND status = ?')
      .run(WHATSAPP_CONSTANTS.DRAFT_STATUSES.PENDING, error, id, WHATSAPP_CONSTANTS.DRAFT_STATUSES.SENDING);
  }

  /**
   * Discard a pending draft.
   *
   * @param id - Draft id
   * @param now - Epoch ms
   * @returns True when the draft was pending and is now discarded
   */
  discardDraft(id: string, now: number): boolean {
    const res = this.db
      .prepare('UPDATE drafts SET status = ?, discarded_at = ? WHERE id = ? AND status = ?')
      .run(WHATSAPP_CONSTANTS.DRAFT_STATUSES.DISCARDED, now, id, WHATSAPP_CONSTANTS.DRAFT_STATUSES.PENDING);
    return res.changes === 1;
  }
}

/** Process-wide store instance (opened lazily). */
let storeInstance: WhatsAppInboxStore | null = null;

/**
 * Get the process-wide inbox store, opening it on first use.
 *
 * @returns The store at {@link getDefaultInboxDbPath}
 */
export function getWhatsAppInboxStore(): WhatsAppInboxStore {
  if (!storeInstance) storeInstance = new WhatsAppInboxStore();
  return storeInstance;
}

/**
 * Close and forget the process-wide store (tests, shutdown).
 */
export function resetWhatsAppInboxStore(): void {
  if (storeInstance) {
    try {
      storeInstance.close();
    } catch {
      // Already closed.
    }
  }
  storeInstance = null;
}
