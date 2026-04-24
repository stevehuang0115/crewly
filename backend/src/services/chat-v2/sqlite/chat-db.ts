/**
 * Chat V2 SQLite bootstrap.
 *
 * Opens (or creates) the chat database at the configured path, applies
 * the Phase 1 migration idempotently, and returns a ready-to-use
 * `better-sqlite3` Database instance.
 *
 * Schema matches tech-spec §3.2. All tables use `INTEGER ms-since-epoch (UTC)`
 * for timestamps and raw UUID strings for IDs.
 *
 * @module services/chat-v2/sqlite/chat-db
 */

import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';

// ---------------------------------------------------------------------------
// Lazy better-sqlite3 loader — avoids a hard native-module dep at import time
// ---------------------------------------------------------------------------

/**
 * CJS-style `require` scoped to this module. `better-sqlite3` is a native
 * addon and must be loaded via CJS `require`, but this module compiles to
 * ESM (root package has `"type": "module"`) where the bare `require` global
 * is undefined.
 *
 * We cannot write `createRequire(import.meta.url)` as a literal because
 * ts-jest transpiles tests to CommonJS, and TS1343 forbids `import.meta`
 * under CJS. So we read the URL via `new Function()` — invisible to the
 * TS compiler, correct under ESM at runtime. Under CJS (tests) the
 * `typeof require === 'function'` branch wins and the Function body
 * is never evaluated.
 */
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(new Function('return import.meta.url')() as string);

/** Cached reference to the better-sqlite3 module after first successful load. */
let _BetterSqlite3: typeof import('better-sqlite3') | null = null;

/**
 * Load `better-sqlite3` on demand. Throws a clear error if the native
 * addon cannot be loaded (a common symptom after Node upgrades).
 *
 * @returns The lazily-imported better-sqlite3 module
 */
function getBetterSqlite3(): typeof import('better-sqlite3') {
  if (!_BetterSqlite3) {
    try {
      _BetterSqlite3 = nodeRequire('better-sqlite3');
    } catch (err) {
      throw new Error(
        'better-sqlite3 native module failed to load. Run `npm rebuild better-sqlite3` to fix. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return _BetterSqlite3!;
}

/** Type alias for a `better-sqlite3` Database instance. */
export type ChatDatabase = import('better-sqlite3').Database;

// ---------------------------------------------------------------------------
// Migration DDL (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Idempotent Phase 1 DDL. Safe to run every boot.
 *
 * Differences vs. the literal spec §3.2:
 * - Added `IF NOT EXISTS` on every CREATE so reboots don't fail.
 * - PRAGMAs set outside the transaction (SQLite disallows PRAGMA in txn).
 */
export const CHAT_V2_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS chat_channels (
  id              TEXT PRIMARY KEY,
  agent_session   TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  name            TEXT NOT NULL,
  purpose         TEXT,
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER,
  last_message_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_agent_active
  ON chat_channels(agent_session)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_channels_owner
  ON chat_channels(owner_user_id, archived_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  sender_type  TEXT NOT NULL CHECK(sender_type IN ('user','agent','system')),
  sender_id    TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('text','markdown','image_ref','system_note'))
               DEFAULT 'markdown',
  created_at   INTEGER NOT NULL,
  metadata     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_seq
  ON chat_messages(channel_id, seq);

CREATE INDEX IF NOT EXISTS ix_messages_channel_created
  ON chat_messages(channel_id, created_at DESC);

-- Partial unique index for clientMessageId-based idempotency (spec §4.4)
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client_id
  ON chat_messages(channel_id, json_extract(metadata, '$.clientMessageId'))
  WHERE json_extract(metadata, '$.clientMessageId') IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK(kind IN ('image')),
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  local_path    TEXT NOT NULL,
  original_name TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_attachments_message
  ON chat_attachments(message_id);

CREATE TABLE IF NOT EXISTS chat_offline_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL,
  agent_session TEXT NOT NULL,
  message_id    TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  queued_at     INTEGER NOT NULL,
  delivered_at  INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_queue_pending
  ON chat_offline_queue(agent_session, delivered_at)
  WHERE delivered_at IS NULL;
`;

// ---------------------------------------------------------------------------
// Opener
// ---------------------------------------------------------------------------

/**
 * Options accepted by `openChatDatabase`.
 */
export interface OpenChatDatabaseOptions {
  /** Absolute path to the SQLite file. Parent dirs will be created. */
  dbPath: string;
  /**
   * When true, uses SQLite `:memory:` regardless of `dbPath`.
   * Intended for unit tests. Defaults to false.
   */
  inMemory?: boolean;
  /**
   * When true, suppress the integrity-check warning on open. Tests use this
   * to avoid noisy logs. Defaults to false.
   */
  skipIntegrityCheck?: boolean;
  /** Optional logger override — defaults to LoggerService. */
  logger?: ComponentLogger;
}

/**
 * Open (or create) the chat database, apply PRAGMAs, run the Phase 1
 * migration idempotently, and run a boot-time integrity check.
 *
 * @param options - Opener options
 * @returns A ready-to-use better-sqlite3 Database handle
 *
 * @example
 * ```ts
 * const db = openChatDatabase({ dbPath: '/tmp/chat.db' });
 * // ... use db ...
 * db.close();
 * ```
 */
export function openChatDatabase(options: OpenChatDatabaseOptions): ChatDatabase {
  const logger =
    options.logger ??
    LoggerService.getInstance().createComponentLogger('ChatV2Db');

  if (!options.inMemory) {
    const dir = path.dirname(options.dbPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const Database = getBetterSqlite3();
  const target = options.inMemory ? ':memory:' : options.dbPath;
  const db = new Database(target);

  // PRAGMAs — must be set outside any transaction (better-sqlite3 opens statements
  // in autocommit mode by default, so a bare pragma() call is safe).
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // Apply the Phase 1 migration idempotently. `exec` accepts multiple statements.
  db.exec(CHAT_V2_MIGRATION_SQL);

  if (!options.skipIntegrityCheck) {
    try {
      const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const first = rows[0]?.integrity_check;
      if (first && first !== 'ok') {
        logger.warn('Chat DB integrity check reported issues', { result: first });
      }
    } catch (err) {
      logger.warn('Chat DB integrity check threw — continuing without gating startup', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Chat DB opened', { path: target });
  return db;
}
