/**
 * Tests for `observability-db`.
 *
 * Uses an in-memory SQLite database so every test starts from a clean
 * slate without touching the filesystem.
 *
 * @module services/observability/observability-db.test
 */

import {
  defaultObservabilityDbPath,
  openObservabilityDatabase,
  OBSERVABILITY_MIGRATION_SQL,
  type ObservabilityDatabase,
} from './observability-db.js';

describe('observability-db', () => {
  describe('defaultObservabilityDbPath', () => {
    it('returns an absolute path ending in .crewly/observability.db', () => {
      const p = defaultObservabilityDbPath();
      expect(typeof p).toBe('string');
      expect(p).toMatch(/\.crewly[\\/]observability\.db$/);
    });
  });

  describe('OBSERVABILITY_MIGRATION_SQL', () => {
    it('declares the agent_behavior_log table and indexes', () => {
      expect(OBSERVABILITY_MIGRATION_SQL).toContain(
        'CREATE TABLE IF NOT EXISTS agent_behavior_log',
      );
      expect(OBSERVABILITY_MIGRATION_SQL).toContain('ix_behavior_log_ts');
      expect(OBSERVABILITY_MIGRATION_SQL).toContain('ix_behavior_log_event_ts');
      expect(OBSERVABILITY_MIGRATION_SQL).toContain(
        'ix_behavior_log_agent_event_ts',
      );
    });
  });

  describe('openObservabilityDatabase', () => {
    let db: ObservabilityDatabase;

    afterEach(() => {
      try {
        db?.close();
      } catch {
        /* tolerate double-close in failure paths */
      }
    });

    it('opens an in-memory DB and creates the schema', () => {
      db = openObservabilityDatabase({
        inMemory: true,
        skipIntegrityCheck: true,
      });
      const tableInfo = db
        .prepare("PRAGMA table_info('agent_behavior_log')")
        .all() as Array<{ name: string }>;
      const cols = tableInfo.map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'ts',
          'event_type',
          'agent',
          'subject',
          'task_id',
          'reason',
          'amount',
          'details_json',
        ]),
      );
    });

    it('is idempotent — opening twice does not error', () => {
      db = openObservabilityDatabase({
        inMemory: true,
        skipIntegrityCheck: true,
      });
      // A second exec of the same DDL on the same DB must be safe.
      expect(() => db.exec(OBSERVABILITY_MIGRATION_SQL)).not.toThrow();
    });

    it('creates the expected indexes', () => {
      db = openObservabilityDatabase({
        inMemory: true,
        skipIntegrityCheck: true,
      });
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type='index' AND tbl_name='agent_behavior_log'`,
        )
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'ix_behavior_log_ts',
          'ix_behavior_log_event_ts',
          'ix_behavior_log_agent_event_ts',
        ]),
      );
    });

    it('accepts inserts after migration', () => {
      db = openObservabilityDatabase({
        inMemory: true,
        skipIntegrityCheck: true,
      });
      const stmt = db.prepare(
        `INSERT INTO agent_behavior_log
           (ts, event_type, agent, subject, task_id, reason, amount, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const info = stmt.run(
        Date.now(),
        'agent.action',
        'crewly-orc',
        '',
        'task-1',
        'delegate',
        0,
        '{"foo":1}',
      );
      expect(Number(info.lastInsertRowid)).toBeGreaterThan(0);

      const row = db
        .prepare('SELECT COUNT(*) AS n FROM agent_behavior_log')
        .get() as { n: number };
      expect(row.n).toBe(1);
    });
  });
});
