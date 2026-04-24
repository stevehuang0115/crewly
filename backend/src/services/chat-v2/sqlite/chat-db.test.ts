/**
 * Tests for openChatDatabase — verifies schema, PRAGMAs, and idempotent migration.
 *
 * @module services/chat-v2/sqlite/chat-db.test
 */

import { openChatDatabase } from './chat-db.js';

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
          'uq_channel_agent_active',
          'ix_channels_owner',
          'uq_messages_channel_seq',
          'ix_messages_channel_created',
          'uq_messages_client_id',
          'ix_attachments_message',
          'ix_queue_pending',
        ]),
      );
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

  it('enforces the uq_channel_agent_active partial index', () => {
    const db = openInMemory();
    try {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('ch1', 'shared-agent', 'user-a', 'First', now);

      // Second active channel for the same agent must fail the unique index.
      expect(() => insert.run('ch2', 'shared-agent', 'user-a', 'Second', now)).toThrow(/UNIQUE/i);

      // But once the first is archived, a second active binding is allowed.
      db.prepare('UPDATE chat_channels SET archived_at = ? WHERE id = ?').run(now, 'ch1');
      expect(() => insert.run('ch2', 'shared-agent', 'user-a', 'Second', now)).not.toThrow();
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
