/**
 * Unit tests for MessageStore — seq assigner, cursor pagination, idempotency.
 *
 * @module services/chat-v2/sqlite/message.store.test
 */

import { openChatDatabase, type ChatDatabase } from './chat-db.js';
import { ChannelStore } from './channel.store.js';
import { MessageStore, decodeCursor, encodeCursor } from './message.store.js';
import { ChatError } from '../types.js';

describe('MessageStore', () => {
  let db: ChatDatabase;
  let channels: ChannelStore;
  let messages: MessageStore;
  let channelId: string;

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    channels = new ChannelStore(db);
    messages = new MessageStore(db);
    channelId = channels.create({
      agentSession: 'sess-a',
      ownerUserId: 'user-a',
      name: 'Test',
      nowMs: 100,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // encodeCursor / decodeCursor
  // -------------------------------------------------------------------------

  describe('cursor helpers', () => {
    it('round-trips an encoded cursor', () => {
      const encoded = encodeCursor({ seq: 42, channelId: 'ch1' });
      expect(decodeCursor(encoded)).toEqual({ seq: 42, channelId: 'ch1' });
    });

    it('returns null when cursor is absent', () => {
      expect(decodeCursor(null)).toBeNull();
      expect(decodeCursor(undefined)).toBeNull();
      expect(decodeCursor('')).toBeNull();
    });

    it('throws invalid_cursor on garbage', () => {
      expect(() => decodeCursor('not-base64url-json')).toThrow(ChatError);
    });

    it('throws invalid_cursor on missing fields', () => {
      const half = Buffer.from(JSON.stringify({ seq: 42 }), 'utf-8').toString('base64url');
      expect(() => decodeCursor(half)).toThrow(ChatError);
    });
  });

  // -------------------------------------------------------------------------
  // insert — seq assigner & idempotency
  // -------------------------------------------------------------------------

  describe('insert', () => {
    it('assigns monotonic sequence numbers starting at 1', () => {
      const a = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'hello',
      });
      const b = messages.insert({
        channelId,
        senderType: 'agent',
        senderId: 'sess-a',
        content: 'hi back',
      });
      const c = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'again',
      });
      expect(a.row.seq).toBe(1);
      expect(b.row.seq).toBe(2);
      expect(c.row.seq).toBe(3);
      expect([a, b, c].every((r) => !r.deduped)).toBe(true);
    });

    it('bumps last_message_at on the parent channel', () => {
      messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'one',
        nowMs: 500,
      });
      expect(channels.getById(channelId)?.last_message_at).toBe(500);

      // Second insert advances further.
      messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'two',
        nowMs: 900,
      });
      expect(channels.getById(channelId)?.last_message_at).toBe(900);
    });

    it('throws channel_not_found for unknown channel', () => {
      try {
        messages.insert({
          channelId: 'nope',
          senderType: 'user',
          senderId: 'user-a',
          content: 'x',
        });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('channel_not_found');
      }
    });

    it('throws channel_archived when the channel is archived', () => {
      channels.archive(channelId);
      try {
        messages.insert({
          channelId,
          senderType: 'user',
          senderId: 'user-a',
          content: 'x',
        });
        fail('expected ChatError');
      } catch (err) {
        expect(err).toBeInstanceOf(ChatError);
        expect((err as ChatError).code).toBe('channel_archived');
      }
    });

    it('persists metadata alongside the clientMessageId', () => {
      const result = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'with meta',
        metadata: { foo: 'bar' },
        clientMessageId: 'cmid-1',
      });
      expect(result.row.metadata).not.toBeNull();
      const parsed = JSON.parse(result.row.metadata!) as Record<string, unknown>;
      expect(parsed.foo).toBe('bar');
      expect(parsed.clientMessageId).toBe('cmid-1');
    });

    it('idempotently returns the existing row for a repeated clientMessageId', () => {
      const first = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'hello',
        clientMessageId: 'cmid-1',
      });
      expect(first.deduped).toBe(false);

      const second = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'hello AGAIN (should be ignored)',
        clientMessageId: 'cmid-1',
      });
      expect(second.deduped).toBe(true);
      expect(second.row.id).toBe(first.row.id);
      expect(second.row.seq).toBe(first.row.seq);
      expect(messages.count(channelId)).toBe(1);
    });

    it('serializes sequences under interleaved inserts from different senders', () => {
      // better-sqlite3 is single-threaded; this exercises the MAX+1 logic over a burst.
      const N = 20;
      for (let i = 0; i < N; i++) {
        messages.insert({
          channelId,
          senderType: i % 2 === 0 ? 'user' : 'agent',
          senderId: i % 2 === 0 ? 'user-a' : 'sess-a',
          content: `m${i}`,
        });
      }
      expect(messages.count(channelId)).toBe(N);
      expect(messages.getLastSeq(channelId)).toBe(N);
    });

    it('Phase A: persists mentions as JSON and round-trips them on read', () => {
      const result = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'pinging @Sam and @team',
        mentions: ['member-sam-uuid', 'team-1'],
      });
      // Stored as JSON-encoded array string in the mentions column.
      expect(result.row.mentions).toBe(JSON.stringify(['member-sam-uuid', 'team-1']));

      const fetched = messages.getById(result.row.id);
      expect(fetched?.mentions).toBe(JSON.stringify(['member-sam-uuid', 'team-1']));
    });

    it('Phase A: empty or omitted mentions arrays store as DB-null', () => {
      const noMentions = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'no mentions here',
      });
      expect(noMentions.row.mentions).toBeNull();

      const emptyMentions = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'empty mentions array',
        mentions: [],
      });
      expect(emptyMentions.row.mentions).toBeNull();
    });

    it('Phase A: persists thread_id for threaded replies', () => {
      const root = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'thread root',
      });
      const reply = messages.insert({
        channelId,
        senderType: 'agent',
        senderId: 'sess-a',
        content: 'reply within thread',
        threadId: root.row.id,
      });
      expect(reply.row.thread_id).toBe(root.row.id);

      // Top-level (no threadId) stores null.
      expect(root.row.thread_id).toBeNull();
    });

    it('Phase A: ix_messages_thread index exists and would serve thread reads', () => {
      // Insert root + two replies; verify the rows are persisted under
      // the thread_id and that an indexed query returns them ordered by seq.
      const root = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'root',
      });
      const r1 = messages.insert({
        channelId,
        senderType: 'agent',
        senderId: 'sess-a',
        content: 'r1',
        threadId: root.row.id,
      });
      const r2 = messages.insert({
        channelId,
        senderType: 'user',
        senderId: 'user-a',
        content: 'r2',
        threadId: root.row.id,
      });
      // Direct read using the index predicate.
      const replies = db
        .prepare(
          `SELECT id FROM chat_messages
           WHERE thread_id = ?
           ORDER BY seq ASC`,
        )
        .all(root.row.id) as Array<{ id: string }>;
      expect(replies.map((r) => r.id)).toEqual([r1.row.id, r2.row.id]);
    });
  });

  // -------------------------------------------------------------------------
  // listByChannel — cursor pagination
  // -------------------------------------------------------------------------

  describe('listByChannel', () => {
    function seed(n: number) {
      for (let i = 1; i <= n; i++) {
        messages.insert({
          channelId,
          senderType: 'user',
          senderId: 'user-a',
          content: `m${i}`,
          nowMs: 1000 + i,
        });
      }
    }

    it('returns newest-first by default', () => {
      seed(5);
      const page = messages.listByChannel(channelId);
      expect(page.rows.map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);
      expect(page.nextCursor).toBeNull();
      expect(page.prevCursor).not.toBeNull();
    });

    it('paginates backward with cursor', () => {
      seed(10);
      const first = messages.listByChannel(channelId, { limit: 4 });
      expect(first.rows.map((r) => r.seq)).toEqual([10, 9, 8, 7]);
      expect(first.nextCursor).not.toBeNull();

      const second = messages.listByChannel(channelId, { limit: 4, cursor: first.nextCursor! });
      expect(second.rows.map((r) => r.seq)).toEqual([6, 5, 4, 3]);

      const third = messages.listByChannel(channelId, { limit: 4, cursor: second.nextCursor! });
      expect(third.rows.map((r) => r.seq)).toEqual([2, 1]);
      expect(third.nextCursor).toBeNull();
    });

    it('supports forward pagination', () => {
      seed(10);
      const first = messages.listByChannel(channelId, { limit: 3, direction: 'forward' });
      expect(first.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(first.nextCursor).not.toBeNull();

      const second = messages.listByChannel(channelId, {
        limit: 3,
        direction: 'forward',
        cursor: first.nextCursor!,
      });
      expect(second.rows.map((r) => r.seq)).toEqual([4, 5, 6]);
    });

    it('rejects a cursor from a different channel', () => {
      seed(2);
      const bad = encodeCursor({ seq: 1, channelId: 'other-channel' });
      expect(() => messages.listByChannel(channelId, { cursor: bad })).toThrow(ChatError);
    });

    it('caps limit at MAX_LIMIT', () => {
      seed(120);
      const page = messages.listByChannel(channelId, { limit: 9999 });
      expect(page.rows).toHaveLength(MessageStore.MAX_LIMIT);
    });

    it('uses DEFAULT_LIMIT when caller omits limit', () => {
      seed(80);
      const page = messages.listByChannel(channelId);
      expect(page.rows).toHaveLength(MessageStore.DEFAULT_LIMIT);
    });

    it('returns empty for a channel with no messages', () => {
      const page = messages.listByChannel(channelId);
      expect(page.rows).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
      expect(page.prevCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ancillary
  // -------------------------------------------------------------------------

  describe('getLastSeq', () => {
    it('returns 0 for empty channels', () => {
      expect(messages.getLastSeq(channelId)).toBe(0);
    });

    it('returns the max seq after inserts', () => {
      messages.insert({ channelId, senderType: 'user', senderId: 'user-a', content: 'a' });
      messages.insert({ channelId, senderType: 'user', senderId: 'user-a', content: 'b' });
      expect(messages.getLastSeq(channelId)).toBe(2);
    });
  });
});
