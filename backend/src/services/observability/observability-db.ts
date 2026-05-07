/**
 * Observability SQLite bootstrap.
 *
 * Opens (or creates) `~/.crewly/observability.db` and applies the
 * idempotent migration for `agent_behavior_log`. The schema is a
 * single append-only table that backs Crewly's minimal internal
 * metrics (delegate-first rate, escalation patterns, slack-delivery
 * failure counters, prompt-size trends).
 *
 * This module mirrors the lazy `better-sqlite3` loader pattern from
 * `services/chat-v2/sqlite/chat-db.ts` so the native module never
 * loads at import time — only when an opener is first called.
 *
 * @module services/observability/observability-db
 */

import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createBareModuleRequire } from '../../utils/node-require.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

// ---------------------------------------------------------------------------
// Lazy better-sqlite3 loader (same pattern as chat-db.ts)
// ---------------------------------------------------------------------------

/**
 * CJS-style `require` scoped to this module. `better-sqlite3` is a
 * native addon and must be loaded via CJS `require`, but this module
 * compiles to ESM where the bare `require` global is undefined.
 *
 * Anchor: see `backend/src/utils/node-require.utils.ts` — the helper
 * hides `import.meta.url` behind direct `eval` so ts-jest's CommonJS
 * transpile does not see the meta-property token. The createRequire
 * anchor is THIS file's URL.
 */
const nodeRequire = createBareModuleRequire(
  typeof require === 'function' ? require : null,
);

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
export type ObservabilityDatabase = import('better-sqlite3').Database;

// ---------------------------------------------------------------------------
// Migration DDL
// ---------------------------------------------------------------------------

/**
 * Idempotent base DDL for the observability database.
 *
 * Single table strategy: every behavior event lives in
 * `agent_behavior_log`, discriminated by `event_type`. Per-event-type
 * payload variation is captured in the optional `subject`, `task_id`,
 * `reason`, `amount`, and `details_json` columns. This keeps the
 * schema small while supporting later additive event types without
 * migrations.
 *
 * Indexes are scoped to the most common query shapes for the weekly
 * digest (per-agent, per-event-type, per-time-window).
 */
export const OBSERVABILITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agent_behavior_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  event_type    TEXT NOT NULL,
  agent         TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  task_id       TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  amount        INTEGER NOT NULL DEFAULT 0,
  details_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS ix_behavior_log_ts
  ON agent_behavior_log(ts);

CREATE INDEX IF NOT EXISTS ix_behavior_log_event_ts
  ON agent_behavior_log(event_type, ts);

CREATE INDEX IF NOT EXISTS ix_behavior_log_agent_event_ts
  ON agent_behavior_log(agent, event_type, ts);
`;

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/**
 * Default on-disk path for the observability database.
 *
 * Lives next to the chat database under `~/.crewly/` so operators have a
 * single directory to back up / inspect.
 *
 * @returns Absolute path to `~/.crewly/observability.db`
 */
export function defaultObservabilityDbPath(): string {
  return path.join(getCrewlyHomePath(), 'observability.db');
}

// ---------------------------------------------------------------------------
// Opener
// ---------------------------------------------------------------------------

/**
 * Options accepted by `openObservabilityDatabase`.
 */
export interface OpenObservabilityDatabaseOptions {
  /**
   * Absolute path to the SQLite file. Parent directories are created
   * as needed. Defaults to `defaultObservabilityDbPath()`.
   */
  dbPath?: string;
  /**
   * When true, uses SQLite `:memory:` regardless of `dbPath`. Intended
   * for unit tests. Defaults to false.
   */
  inMemory?: boolean;
  /**
   * When true, suppress the integrity-check warning on open. Tests use
   * this to avoid noisy logs. Defaults to false.
   */
  skipIntegrityCheck?: boolean;
  /** Optional logger override — defaults to `LoggerService`. */
  logger?: ComponentLogger;
}

/**
 * Open (or create) the observability database, apply PRAGMAs, run the
 * idempotent migration, and run a boot-time integrity check.
 *
 * Safe to call multiple times during a single process lifetime — each
 * call returns a fresh `Database` handle the caller is responsible for
 * closing. In production, code should hold a single shared handle and
 * close it during graceful shutdown.
 *
 * @param options - Opener options
 * @returns A ready-to-use better-sqlite3 Database handle
 *
 * @example
 * ```ts
 * const db = openObservabilityDatabase();
 * // ... use db ...
 * db.close();
 * ```
 */
export function openObservabilityDatabase(
  options: OpenObservabilityDatabaseOptions = {},
): ObservabilityDatabase {
  const logger =
    options.logger ??
    LoggerService.getInstance().createComponentLogger('ObservabilityDb');

  const dbPath = options.dbPath ?? defaultObservabilityDbPath();

  if (!options.inMemory) {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const Database = getBetterSqlite3();
  const target = options.inMemory ? ':memory:' : dbPath;
  const db = new Database(target);

  // PRAGMAs — must be set outside any transaction.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Apply migration idempotently. `exec` accepts multiple statements.
  db.exec(OBSERVABILITY_MIGRATION_SQL);

  if (!options.skipIntegrityCheck) {
    try {
      const rows = db.pragma('integrity_check') as Array<{
        integrity_check: string;
      }>;
      const first = rows[0]?.integrity_check;
      if (first && first !== 'ok') {
        logger.warn('Observability DB integrity check reported issues', {
          result: first,
        });
      }
    } catch (err) {
      logger.warn(
        'Observability DB integrity check threw — continuing without gating startup',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  logger.info('Observability DB opened', { path: target });
  return db;
}
