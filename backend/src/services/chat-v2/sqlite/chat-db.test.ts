/**
 * Tests for openChatDatabase — verifies schema, PRAGMAs, and idempotent migration.
 *
 * @module services/chat-v2/sqlite/chat-db.test
 */

import {
  applyPhaseAColumnUpgrades,
  openChatDatabase,
  setBetterSqlite3LoaderForTesting,
} from './chat-db.js';
import {
  NativeBindingFatalError,
  isNativeBindingFatalError,
} from '../../../utils/native-binding.utils.js';

describe('openChatDatabase', () => {
  function openInMemory() {
    return openChatDatabase({ dbPath: ':memory:', inMemory: true });
  }

  it('creates the Phase 1 tables', () => {
    const db = openInMemory();
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'chat_channels',
          'chat_messages',
          'chat_attachments',
          'chat_offline_queue',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('creates all the expected indexes', () => {
    const db = openInMemory();
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'ix_channels_owner',
          'ix_channels_team',
          'uq_messages_channel_seq',
          'ix_messages_channel_created',
          'uq_messages_client_id',
          'ix_messages_thread',
          'ix_attachments_message',
          'ix_queue_pending',
        ]),
      );
      // Legacy index name must not exist on fresh installs.
      expect(names).not.toEqual(expect.arrayContaining(['uq_channel_agent_active']));
      // Unified-chat-store spec (Option B): the post-Phase-A 1:1 DM
      // constraint was dropped so a single agent can participate in
      // many concurrent channels. Fresh installs MUST NOT have it.
      expect(names).not.toEqual(expect.arrayContaining(['uq_channel_agent_dm_active']));
    } finally {
      db.close();
    }
  });

  it('creates Phase A columns on chat_channels (type, team_id, project_id, target_member_id)', () => {
    const db = openInMemory();
    try {
      const cols = db.pragma('table_info(chat_channels)') as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.has('type')).toBe(true);
      expect(byName.has('team_id')).toBe(true);
      expect(byName.has('project_id')).toBe(true);
      expect(byName.has('target_member_id')).toBe(true);

      // `type` must be NOT NULL with default 'dm' so existing INSERTs that
      // omit it (and pre-Phase-A backfilled rows) end up on the dm path.
      const typeCol = byName.get('type')!;
      expect(typeCol.notnull).toBe(1);
      // SQLite stores defaults with surrounding quotes for string literals.
      expect(typeCol.dflt_value).toMatch(/^'?dm'?$/);
    } finally {
      db.close();
    }
  });

  it('creates Phase A columns on chat_messages (mentions, thread_id)', () => {
    const db = openInMemory();
    try {
      const cols = db.pragma('table_info(chat_messages)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['mentions', 'thread_id']));
    } finally {
      db.close();
    }
  });

  it('enforces foreign keys (chat_messages.channel_id)', () => {
    const db = openInMemory();
    try {
      const fkRows = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      expect(fkRows[0]?.foreign_keys).toBe(1);

      // Inserting a message with a non-existent channel_id must fail.
      expect(() =>
        db
          .prepare(
            `INSERT INTO chat_messages
             (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('msg1', 'nonexistent-channel', 1, 'user', 'u1', 'hello', 'markdown', Date.now()),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('enforces the CHECK constraint on sender_type', () => {
    const db = openInMemory();
    try {
      // First make a parent channel so FK doesn't get in the way.
      db.prepare(
        `INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('ch1', 'sess-a', 'user-a', 'Test', Date.now());

      expect(() =>
        db
          .prepare(
            `INSERT INTO chat_messages
             (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('msg1', 'ch1', 1, 'robot' /* invalid */, 'u1', 'hi', 'markdown', Date.now()),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('allows multiple active dm channels for the same agent (unified-chat-store Option B)', () => {
    // Replaces the previous test that asserted the 1:1 unique index was
    // enforced. Per spec `2026-05-14-unified-chat-message-store.md` the
    // index `uq_channel_agent_dm_active` was dropped so an agent can
    // participate in N concurrent DM-style channels (one per Slack
    // thread, one per web chat session, etc.).
    const db = openInMemory();
    try {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // Three concurrent active DMs for the same agent — formerly a
      // UNIQUE violation on the second insert. All must now succeed.
      expect(() => {
        insert.run('slack-D0AC7-1234', 'shared-agent', 'user-a', 'Slack thread 1', now);
        insert.run('slack-D0AC7-5678', 'shared-agent', 'user-a', 'Slack thread 2', now);
        insert.run('web-conv-abc', 'shared-agent', 'user-b', 'Web chat', now);
      }).not.toThrow();

      const rows = db
        .prepare("SELECT id FROM chat_channels WHERE agent_session = 'shared-agent' ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(['slack-D0AC7-1234', 'slack-D0AC7-5678', 'web-conv-abc']);
    } finally {
      db.close();
    }
  });

  it('does NOT apply the dm-binding unique index to type=channel rows', () => {
    // Phase A SEALED §3.1 — multiple type='channel' rows can legitimately
    // share an empty agent_session ('' wire-binding sentinel). The renamed
    // partial index `uq_channel_agent_dm_active` excludes type='channel'
    // rows via `WHERE archived_at IS NULL AND type = 'dm'`.
    const db = openInMemory();
    try {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO chat_channels
           (id, agent_session, owner_user_id, name, created_at, type, team_id)
         VALUES (?, ?, ?, ?, ?, 'channel', ?)`,
      );
      // Two `#general` channels in different teams, both with the empty
      // agent_session sentinel — no unique-constraint violation.
      expect(() => {
        insert.run('cha-team-1', '', 'user-a', '#general', now, 'team-1');
        insert.run('cha-team-2', '', 'user-a', '#general', now, 'team-2');
      }).not.toThrow();

      const rows = db
        .prepare("SELECT id FROM chat_channels WHERE type = 'channel' ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(['cha-team-1', 'cha-team-2']);
    } finally {
      db.close();
    }
  });

  it('rejects type values outside the {dm, channel} CHECK', () => {
    const db = openInMemory();
    try {
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO chat_channels
               (id, agent_session, owner_user_id, name, created_at, type)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('cha-bad', '', 'user-a', 'Bogus', now, 'group' /* invalid */),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('is idempotent — calling migration twice in a row is safe', () => {
    const db = openInMemory();
    try {
      // The opener already ran once. Apply migration again — no errors.
      // We must re-import to run the raw SQL via exec.
      // Easier: just run the known migration text again from constant.
      const { CHAT_V2_MIGRATION_SQL } = require('./chat-db');
      expect(() => db.exec(CHAT_V2_MIGRATION_SQL)).not.toThrow();
    } finally {
      db.close();
    }
  });

  // Regression guard: root package is `"type": "module"`, so a bare
  // `require('better-sqlite3')` used to throw ReferenceError at runtime.
  // The lazy loader must bridge via createRequire(import.meta.url).
  it('loads better-sqlite3 without ReferenceError under ESM', () => {
    // If createRequire is wired correctly, openInMemory succeeds and we can
    // run a trivial query. If the fix regresses, this throws synchronously.
    const db = openInMemory();
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    } finally {
      db.close();
    }
  });

  describe('applyPhaseAColumnUpgrades — pre-Phase-A migration path', () => {
    /**
     * Recreate the literal Phase 1 schema (pre-Phase-A) so we can verify
     * the additive upgrade. The DDL below intentionally omits Phase A
     * columns and creates the OLD `uq_channel_agent_active` index name,
     * mirroring what a database created before this migration looks like.
     */
    const PRE_PHASE_A_DDL = `
      CREATE TABLE chat_channels (
        id              TEXT PRIMARY KEY,
        agent_session   TEXT NOT NULL,
        owner_user_id   TEXT NOT NULL,
        name            TEXT NOT NULL,
        purpose         TEXT,
        created_at      INTEGER NOT NULL,
        archived_at     INTEGER,
        last_message_at INTEGER
      );
      CREATE UNIQUE INDEX uq_channel_agent_active
        ON chat_channels(agent_session)
        WHERE archived_at IS NULL;
      CREATE TABLE chat_messages (
        id           TEXT PRIMARY KEY,
        channel_id   TEXT NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        sender_type  TEXT NOT NULL CHECK(sender_type IN ('user','agent','system')),
        sender_id    TEXT NOT NULL,
        content      TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'markdown',
        created_at   INTEGER NOT NULL,
        metadata     TEXT
      );
    `;

    function openLegacyDb() {
      // Bypass openChatDatabase so the Phase A upgrade hasn't run yet.
      // better-sqlite3 is exported as the constructor itself (CJS), not as
      // `default` — `require('better-sqlite3')` is what we want.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(PRE_PHASE_A_DDL);
      return db;
    }

    it('adds the Phase A columns to a pre-Phase-A database without dropping data', () => {
      const db = openLegacyDb();
      try {
        const now = Date.now();
        // Insert a row using the OLD schema (no `type` column on the wire).
        db.prepare(
          `INSERT INTO chat_channels
             (id, agent_session, owner_user_id, name, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run('legacy-1', 'sess-a', 'user-a', 'Legacy DM', now);

        const report = applyPhaseAColumnUpgrades(db);
        expect(report.channelsAdded.sort()).toEqual(
          ['type', 'team_id', 'project_id', 'target_member_id'].sort(),
        );
        expect(report.messagesAdded.sort()).toEqual(['mentions', 'thread_id'].sort());
        expect(report.legacyIndexDropped).toBe(true);

        // Existing row preserved AND backfilled to type='dm' via the
        // NOT NULL DEFAULT clause on ADD COLUMN.
        const row = db
          .prepare('SELECT id, agent_session, type, team_id FROM chat_channels WHERE id = ?')
          .get('legacy-1') as { id: string; agent_session: string; type: string; team_id: string | null };
        expect(row.id).toBe('legacy-1');
        expect(row.agent_session).toBe('sess-a');
        expect(row.type).toBe('dm');
        expect(row.team_id).toBeNull();
      } finally {
        db.close();
      }
    });

    it('is no-op idempotent: running the upgrade twice produces no changes the second time', () => {
      const db = openLegacyDb();
      try {
        const first = applyPhaseAColumnUpgrades(db);
        expect(first.channelsAdded.length + first.messagesAdded.length).toBeGreaterThan(0);

        const second = applyPhaseAColumnUpgrades(db);
        expect(second.channelsAdded).toEqual([]);
        expect(second.messagesAdded).toEqual([]);
        expect(second.legacyIndexDropped).toBe(false);
      } finally {
        db.close();
      }
    });

    it('drops the legacy uq_channel_agent_active index in favor of the new dm-scoped index', () => {
      const db = openLegacyDb();
      try {
        // Sanity: legacy index is present in the pre-upgrade state.
        const legacyBefore = db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'uq_channel_agent_active'`,
          )
          .get();
        expect(legacyBefore).toBeTruthy();

        applyPhaseAColumnUpgrades(db);

        const legacyAfter = db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'uq_channel_agent_active'`,
          )
          .get();
        expect(legacyAfter).toBeUndefined();
      } finally {
        db.close();
      }
    });
  });

  /**
   * F-CYCLE7-1 — fail-fast at boot when better-sqlite3 cannot dlopen.
   *
   * Before this fix, an arch-mismatched `better_sqlite3.node` raised a
   * generic Error here that the chat-v2 WS-gateway init try/catch in
   * `index.ts` logged as "non-critical" and continued — silently
   * downgrading chat persistence to the JSON-file fallback in
   * `~/.crewly/chat/`. The audit on 2026-05-07 §2.1 caught this:
   * `chat.db` stopped getting writes at 11:17Z and nobody noticed.
   *
   * The fix promotes dlopen / arch / ABI errors to
   * {@link NativeBindingFatalError} so the boot wiring rethrows
   * (crashing the process) instead of swallowing.
   */
  describe('fail-fast on native-arch mismatch (F-CYCLE7-1)', () => {
    afterEach(() => {
      // CRITICAL: clear the test-only loader override so the real
      // better-sqlite3 is used by every other test in this file.
      setBetterSqlite3LoaderForTesting(null);
    });

    it('throws NativeBindingFatalError when better-sqlite3 fails with a Mach-O arch error', () => {
      const dlopenError = new Error(
        "dlopen .../node_modules/better-sqlite3/build/Release/better_sqlite3.node, 0x0001\n" +
          "mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e' or 'arm64')",
      );
      setBetterSqlite3LoaderForTesting(() => {
        throw dlopenError;
      });

      let caught: unknown = null;
      try {
        openChatDatabase({ dbPath: ':memory:', inMemory: true });
      } catch (e) {
        caught = e;
      }
      expect(isNativeBindingFatalError(caught)).toBe(true);
      const fatal = caught as NativeBindingFatalError;
      expect(fatal.fatal).toBe(true);
      expect(fatal.moduleName).toBe('better-sqlite3');
      expect(fatal.message).toContain('npm rebuild better-sqlite3');
      // The original dlopen line is preserved in the cause chain so
      // ops can see exactly which arch combo bit them.
      expect(fatal.message).toContain('incompatible architecture');
      expect(fatal.cause).toBe(dlopenError);
    });

    it('throws NativeBindingFatalError on an ABI / NODE_MODULE_VERSION mismatch', () => {
      // Captures the post-Node-upgrade case: the binary is for the right
      // arch but compiled against a different Node ABI. Same fail-fast
      // contract applies.
      setBetterSqlite3LoaderForTesting(() => {
        throw new Error(
          'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 108',
        );
      });

      expect(() =>
        openChatDatabase({ dbPath: ':memory:', inMemory: true }),
      ).toThrow(NativeBindingFatalError);
    });

    it('does NOT escalate "Cannot find module" to NativeBindingFatalError', () => {
      // Sanity guard: the soft-error path for "package literally not
      // installed" must keep its existing semantics — we only escalate
      // recognised dlopen / arch / ABI patterns.
      const cause = new Error("Cannot find module 'better-sqlite3'");
      setBetterSqlite3LoaderForTesting(() => {
        throw cause;
      });

      let caught: unknown = null;
      try {
        openChatDatabase({ dbPath: ':memory:', inMemory: true });
      } catch (e) {
        caught = e;
      }
      expect(isNativeBindingFatalError(caught)).toBe(false);
      expect(caught).toBe(cause);
    });
  });

  it('clientMessageId idempotency index prevents duplicates per channel', () => {
    const db = openInMemory();
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('ch1', 'agent-a', 'user-a', 'Ch', now);

      const insertMsg = db.prepare(
        `INSERT INTO chat_messages
         (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      insertMsg.run(
        'msg1',
        'ch1',
        1,
        'user',
        'user-a',
        'hello',
        'markdown',
        now,
        JSON.stringify({ clientMessageId: 'cmid-1' }),
      );

      expect(() =>
        insertMsg.run(
          'msg2',
          'ch1',
          2,
          'user',
          'user-a',
          'dup',
          'markdown',
          now,
          JSON.stringify({ clientMessageId: 'cmid-1' }),
        ),
      ).toThrow(/UNIQUE/i);

      // Messages without clientMessageId are NOT affected by the partial index.
      expect(() =>
        insertMsg.run('msg3', 'ch1', 2, 'user', 'user-a', 'no-cmid', 'markdown', now, null),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
