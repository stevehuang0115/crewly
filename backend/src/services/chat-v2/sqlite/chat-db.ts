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
import { pathToFileURL } from 'url';
import { LoggerService, type ComponentLogger } from '../../core/logger.service.js';

// ---------------------------------------------------------------------------
// Lazy better-sqlite3 loader — avoids a hard native-module dep at import time
// ---------------------------------------------------------------------------

/**
 * CJS-style `require` scoped to this module. `better-sqlite3` is a native
 * addon and must be loaded via CJS `require`, but this module compiles to
 * ESM where the bare `require` global is undefined.
 *
 * Anchor `createRequire` to `process.argv[1]` (entry script) instead of
 * `import.meta.url`. We previously used `new Function('return import.meta.url')()`
 * to dodge ts-jest's TS1343 (CJS test compile rejects literal `import.meta`),
 * but that trick fails at RUNTIME under ESM because `new Function(...)`
 * evaluates in non-module scope where `import.meta` is a SyntaxError.
 * `process.argv[1]` is always inside the project tree and lets Node's
 * resolver walk up to find `node_modules`.
 */
const nodeRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(pathToFileURL(process.argv[1] || process.cwd()).href);

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
// Migration DDL (Phase 1 base + Phase A Slack-like extensions)
// ---------------------------------------------------------------------------

/**
 * Idempotent base DDL — Phase 1 schema with Phase A column additions baked in.
 *
 * Safe to run every boot.
 *
 * Differences vs. the literal spec §3.2:
 * - Added `IF NOT EXISTS` on every CREATE so reboots don't fail.
 * - PRAGMAs set outside the transaction (SQLite disallows PRAGMA in txn).
 *
 * Phase A additions (SEALED design 2026-04-25 §3.1 + §3.2) are reflected
 * directly in the CREATE TABLE bodies so a fresh-install database lands on
 * the new schema in one shot. Pre-existing databases (created under the
 * Phase 1 schema) get the same columns added by `applyPhaseAColumnUpgrades`
 * below, which uses `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`.
 */
export const CHAT_V2_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS chat_channels (
  id                TEXT PRIMARY KEY,
  agent_session     TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,
  name              TEXT NOT NULL,
  purpose           TEXT,
  created_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  last_message_at   INTEGER,
  -- Phase A (SEALED §3.1): channel-type discriminator. 'dm' preserves the
  -- Phase 1 1:1 user↔agent contract; 'channel' is the Slack-like team
  -- surface. Existing rows backfill to 'dm' via applyPhaseAColumnUpgrades.
  type              TEXT NOT NULL DEFAULT 'dm' CHECK(type IN ('dm','channel')),
  -- Phase A (SEALED §3.1): team workspace link. Required at the service
  -- layer when type='channel'; null for type='dm'.
  team_id           TEXT,
  -- Phase A (SEALED §3.1): optional project link for project-scoped channels.
  project_id        TEXT,
  -- Phase A (SEALED §3.1): for type='dm', the resolved member-ID being DM'd
  -- (distinct from agent_session which is the wire-level binding key).
  target_member_id  TEXT
);

CREATE INDEX IF NOT EXISTS ix_channels_owner
  ON chat_channels(owner_user_id, archived_at);

-- Phase A indexes that reference the new columns (type, team_id, thread_id)
-- live in CHAT_V2_PHASE_A_INDEX_SQL below — they must be created AFTER
-- applyPhaseAColumnUpgrades runs so the columns exist on legacy DBs.

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
  metadata     TEXT,
  -- Phase A (SEALED §3.2): JSON-encoded array of mention IDs (member or
  -- team) referenced inline in the content field. Stored as a JSON string;
  -- service layer treats null as []. Bounded at insert time; see types.ts.
  mentions     TEXT,
  -- Phase A (SEALED §3.2): optional Slack-style thread root. When set,
  -- this message is a reply within the thread rooted at thread_id.
  thread_id    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_channel_seq
  ON chat_messages(channel_id, seq);

CREATE INDEX IF NOT EXISTS ix_messages_channel_created
  ON chat_messages(channel_id, created_at DESC);

-- Phase 1: partial unique index for clientMessageId-based idempotency (spec §4.4)
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

/**
 * Phase A indexes that reference Phase A columns. Must run AFTER
 * `applyPhaseAColumnUpgrades` adds those columns on pre-Phase-A databases —
 * otherwise the partial-index `WHERE` clauses fail with "no such column".
 *
 * On a fresh database this runs after `CHAT_V2_MIGRATION_SQL` has already
 * baked the columns into the CREATE TABLE bodies, so each step is a
 * harmless no-op (`CREATE INDEX IF NOT EXISTS`).
 */
export const CHAT_V2_PHASE_A_INDEX_SQL = `
-- Phase A (SEALED §3.1): the 1:1 agent-binding only applies to type='dm'
-- channels. type='channel' rows have agent_session='' and many such rows
-- can coexist for the same team; the partial index intentionally excludes
-- them so the unique constraint doesn't fire on multi-agent channels.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_agent_dm_active
  ON chat_channels(agent_session)
  WHERE archived_at IS NULL AND type = 'dm';

-- Phase A (SEALED §3.1): scoped lookup for "all channels in team T" and
-- "project P channels". Indexes by team first because team-scoped reads
-- are the dominant Phase B+ access pattern.
CREATE INDEX IF NOT EXISTS ix_channels_team
  ON chat_channels(team_id, archived_at)
  WHERE team_id IS NOT NULL;

-- Phase A (SEALED §3.2): thread-pane lookup. Filtered to non-null so the
-- (smaller) index only covers actual threaded replies.
CREATE INDEX IF NOT EXISTS ix_messages_thread
  ON chat_messages(thread_id, seq)
  WHERE thread_id IS NOT NULL;
`;

// ---------------------------------------------------------------------------
// Phase A column-upgrade helpers — additive, idempotent, NOT destructive
// ---------------------------------------------------------------------------

/**
 * Spec for one column we want to ensure exists on a table.
 *
 * `addClause` is the body of an `ALTER TABLE ... ADD COLUMN <addClause>`
 * statement (the column name is included). SQLite restricts ADD COLUMN
 * defaults to constants; that constraint is satisfied by every entry below.
 */
interface ColumnSpec {
  /** Column name, used both for PRAGMA presence-check and the ADD COLUMN clause. */
  name: string;
  /** ADD COLUMN clause body, e.g. `team_id TEXT`. Must not include `ALTER TABLE`. */
  addClause: string;
}

/** Phase A column additions for `chat_channels`. */
const CHAT_CHANNELS_PHASE_A_COLUMNS: ColumnSpec[] = [
  // NOT NULL DEFAULT 'dm' lets ALTER TABLE backfill existing rows in one shot.
  { name: 'type', addClause: "type TEXT NOT NULL DEFAULT 'dm'" },
  { name: 'team_id', addClause: 'team_id TEXT' },
  { name: 'project_id', addClause: 'project_id TEXT' },
  { name: 'target_member_id', addClause: 'target_member_id TEXT' },
];

/** Phase A column additions for `chat_messages`. */
const CHAT_MESSAGES_PHASE_A_COLUMNS: ColumnSpec[] = [
  { name: 'mentions', addClause: 'mentions TEXT' },
  { name: 'thread_id', addClause: 'thread_id TEXT' },
];

/**
 * Add a column to `table` if (and only if) it isn't already present.
 *
 * Uses `PRAGMA table_info(<table>)` to enumerate existing columns. SQLite
 * does not have an `ADD COLUMN IF NOT EXISTS` form, so this guarded
 * approach is the standard idempotent shape.
 *
 * @param db - The chat database handle
 * @param table - Target table
 * @param spec - Column to ensure
 * @returns `true` if a column was added, `false` if it already existed
 */
function ensureColumn(db: ChatDatabase, table: string, spec: ColumnSpec): boolean {
  // PRAGMA cannot be parameterized; the table name is inlined. Callers
  // supply only literal table names from the constants above — never
  // user input — so SQL injection is not a concern here.
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (cols.some((c) => c.name === spec.name)) {
    return false;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${spec.addClause}`);
  return true;
}

/**
 * Bring a pre-existing chat database up to Phase A's schema by adding
 * any missing columns and the new indexes / dropping the superseded ones.
 *
 * Safe to run on a fresh database too — every step is no-op idempotent.
 * Specifically:
 *   - `ensureColumn` is a no-op when the column is already present (the
 *     fresh-install case, since the columns are baked into the CREATE
 *     TABLE in `CHAT_V2_MIGRATION_SQL`).
 *   - `DROP INDEX IF EXISTS uq_channel_agent_active` removes the legacy
 *     unconditional partial index so the new dm-scoped one isn't shadowed.
 *     The DROP is metadata-only — no row data is affected.
 *
 * Exported (separately from `openChatDatabase`) so tests can simulate the
 * pre-Phase-A → Phase A migration path explicitly.
 *
 * @param db - The chat database handle
 * @returns A small report describing what changed (for logging)
 */
export function applyPhaseAColumnUpgrades(db: ChatDatabase): {
  channelsAdded: string[];
  messagesAdded: string[];
  legacyIndexDropped: boolean;
} {
  const channelsAdded: string[] = [];
  for (const spec of CHAT_CHANNELS_PHASE_A_COLUMNS) {
    if (ensureColumn(db, 'chat_channels', spec)) {
      channelsAdded.push(spec.name);
    }
  }
  const messagesAdded: string[] = [];
  for (const spec of CHAT_MESSAGES_PHASE_A_COLUMNS) {
    if (ensureColumn(db, 'chat_messages', spec)) {
      messagesAdded.push(spec.name);
    }
  }

  // Drop the legacy `uq_channel_agent_active` partial index — its constraint
  // (`agent_session unique among archived_at IS NULL`) is too strict in the
  // post-Phase-A world where multiple type='channel' rows legitimately share
  // an empty agent_session. The replacement `uq_channel_agent_dm_active`
  // (created below) carries the same semantics scoped to type='dm' rows only.
  //
  // The drop must happen BEFORE creating the new index — if the legacy
  // index were left in place, an INSERT into a type='dm' row would still
  // be checked by both indexes (same expression, different WHERE), which
  // is harmless functionally but wastes write amplification.
  const legacyIdx = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'uq_channel_agent_active'`,
    )
    .get() as { name: string } | undefined;
  let legacyIndexDropped = false;
  if (legacyIdx) {
    db.exec('DROP INDEX IF EXISTS uq_channel_agent_active');
    legacyIndexDropped = true;
  }

  // Now that all Phase A columns are guaranteed to exist, create the
  // Phase A indexes that reference them. Idempotent — `CREATE INDEX IF NOT
  // EXISTS` makes this a no-op on subsequent boots.
  db.exec(CHAT_V2_PHASE_A_INDEX_SQL);

  return { channelsAdded, messagesAdded, legacyIndexDropped };
}

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
  // For fresh databases this creates every table + index in one shot, including
  // the Phase A columns baked into the CREATE TABLE bodies.
  db.exec(CHAT_V2_MIGRATION_SQL);

  // For pre-existing databases (created under Phase 1 schema), additively
  // bring them up to Phase A: add missing columns and drop the superseded
  // legacy `uq_channel_agent_active` index. Every step is no-op idempotent
  // on a fresh DB.
  const upgradeReport = applyPhaseAColumnUpgrades(db);
  if (
    upgradeReport.channelsAdded.length > 0 ||
    upgradeReport.messagesAdded.length > 0 ||
    upgradeReport.legacyIndexDropped
  ) {
    logger.info('Chat DB Phase A schema upgrade applied', upgradeReport);
  }

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
