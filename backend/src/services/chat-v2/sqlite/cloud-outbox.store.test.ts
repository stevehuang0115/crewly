/**
 * Tests for CloudOutboxStore — outbox paging/ack/trim, sync state, backfill
 * pages and upload rows.
 */

import { openChatDatabase, type ChatDatabase } from './chat-db.js';
import { ChannelStore } from './channel.store.js';
import { MessageStore } from './message.store.js';
import { CloudOutboxStore } from './cloud-outbox.store.js';

describe('CloudOutboxStore', () => {
  let db: ChatDatabase;
  let messages: MessageStore;
  let outbox: CloudOutboxStore;

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const channels = new ChannelStore(db);
    channels.create({ id: 'dm-ella', agentSession: 'ella', ownerUserId: 'u', name: 'Ella', nowMs: 1 });
    channels.create({ id: 'huddle-1', agentSession: '', ownerUserId: 'u', name: 'daily', nowMs: 1, type: 'huddle' });
    db.prepare(`INSERT INTO chat_channel_members (channel_id, member_session, joined_at) VALUES ('huddle-1', 'sam', 2), ('huddle-1', 'ella', 1)`).run();
    messages = new MessageStore(db);
    outbox = new CloudOutboxStore(db);
  });

  afterEach(() => db.close());

  /** Insert a message at a time. */
  const add = (id: string, at: number, channelId = 'dm-ella') =>
    messages.insert({ id, channelId, senderType: 'user', senderId: 'u', content: id, nowMs: at });

  it('peeks in seq order and acks through a seq', () => {
    add('a', 10);
    add('b', 11);
    add('c', 12);
    const entries = outbox.peek(2);
    expect(entries.map((e) => [e.messageId, e.op, e.enqueuedAt])).toEqual([
      ['a', 'upsert', 10],
      ['b', 'upsert', 11],
    ]);
    expect(outbox.ackThrough(entries[1]!.seq)).toBe(2);
    expect(outbox.peek(10).map((e) => e.messageId)).toEqual(['c']);
    expect(outbox.count()).toBe(1);
    outbox.clear();
    expect(outbox.count()).toBe(0);
  });

  it('trims rows past the age limit, then the oldest past the row cap', () => {
    add('old', 1);
    add('a', 100);
    add('b', 101);
    add('c', 102);
    expect(outbox.trim({ maxRows: 2, olderThanMs: 50 })).toBe(2);
    expect(outbox.peek(10).map((e) => e.messageId)).toEqual(['b', 'c']);
  });

  it('loads upload rows with channel, lead member and attachment metadata', () => {
    add('m', 5, 'huddle-1');
    db.prepare(
      `INSERT INTO chat_attachments (id, message_id, kind, mime_type, size_bytes, local_path, original_name, created_at)
       VALUES ('att', 'm', 'image', 'image/png', 42, '/tmp/x.png', 'x.png', 5)`,
    ).run();
    const row = outbox.getMessages(['m', 'missing']).get('m')!;
    expect(row).toMatchObject({
      id: 'm',
      channelId: 'huddle-1',
      channelName: 'daily',
      channelType: 'huddle',
      leadMember: 'ella',
      source: 'crewly-chat',
      attachments: [{ kind: 'image', mimeType: 'image/png', sizeBytes: 42, originalName: 'x.png' }],
    });
    expect(outbox.getMessages(['missing']).size).toBe(0);
  });

  it('pages syncable history oldest first from a window and a cursor', () => {
    add('before', 5);
    add('a', 10);
    add('b', 10);
    add('c', 20);
    db.prepare(`UPDATE chat_messages SET cloud_sync = 0 WHERE id = 'b'`).run();
    const first = outbox.backfillPage(10, null, 1);
    expect(first.map((r) => r.id)).toEqual(['a']);
    const rest = outbox.backfillPage(10, { createdAt: first[0]!.createdAt, rowid: first[0]!.rowid }, 10);
    expect(rest.map((r) => r.id)).toEqual(['c']);
  });

  it('keeps sync state, and clears it except the keys asked to keep', () => {
    outbox.setState('a', '1');
    outbox.setState('a', '2');
    outbox.setState('b', '3');
    expect(outbox.getState('a')).toBe('2');
    outbox.setState('b', null);
    expect(outbox.getState('b')).toBeNull();
    outbox.setState('keep', 'x');
    outbox.clearState(['keep']);
    expect(outbox.getState('a')).toBeNull();
    expect(outbox.getState('keep')).toBe('x');
    outbox.clearState();
    expect(outbox.getState('keep')).toBeNull();
  });
});
