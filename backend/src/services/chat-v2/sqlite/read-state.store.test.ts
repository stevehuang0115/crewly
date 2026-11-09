/**
 * Unit tests for ReadStateStore.
 *
 * @module services/chat-v2/sqlite/read-state.store.test
 */

import { openChatDatabase, type ChatDatabase } from './chat-db.js';
import { ChannelStore } from './channel.store.js';
import { MessageStore } from './message.store.js';
import { ReadStateStore } from './read-state.store.js';

describe('ReadStateStore', () => {
  let db: ChatDatabase;
  let channels: ChannelStore;
  let messages: MessageStore;
  let store: ReadStateStore;
  let channelId: string;

  const add = (
    senderType: 'user' | 'agent' | 'system',
    contentType: 'markdown' | 'system_note' = 'markdown',
  ): number =>
    messages.insert({
      channelId,
      senderType,
      senderId: senderType === 'user' ? 'owner' : 'sam',
      content: 'x',
      contentType,
    }).row.seq;

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    channels = new ChannelStore(db);
    messages = new MessageStore(db);
    store = new ReadStateStore(db);
    channelId = channels.create({ agentSession: 'sess-a', ownerUserId: 'u', name: 'c' }).id;
  });

  afterEach(() => db.close());

  it('treats a channel with no row as marker 0', () => {
    add('agent');
    add('agent');
    expect(store.get(channelId)).toEqual({ channelId, lastReadSeq: 0, unreadCount: 2 });
  });

  it('counts only non-owner, non-system-note messages (thread replies included)', () => {
    const root = messages.insert({ channelId, senderType: 'agent', senderId: 'sam', content: 'r' }).row;
    add('user');
    add('agent', 'system_note');
    add('system');
    messages.insert({ channelId, senderType: 'agent', senderId: 'sam', content: 'reply', threadId: root.id });
    expect(store.get(channelId).unreadCount).toBe(3);
  });

  it('markRead without seq reads everything', () => {
    add('agent');
    const last = add('agent');
    expect(store.markRead(channelId)).toEqual({ channelId, lastReadSeq: last, unreadCount: 0 });
  });

  it('markRead is forward-only', () => {
    add('agent');
    add('agent');
    add('agent');
    store.markRead(channelId, 3);
    expect(store.markRead(channelId, 1).lastReadSeq).toBe(3);
  });

  it('markRead clamps a seq past the last message', () => {
    add('agent');
    expect(store.markRead(channelId, 99).lastReadSeq).toBe(1);
    add('agent');
    expect(store.get(channelId).unreadCount).toBe(1);
  });

  it('markUnread moves the marker back to seq - 1', () => {
    add('agent');
    add('agent');
    add('agent');
    store.markRead(channelId);
    expect(store.markUnread(channelId, 2)).toEqual({ channelId, lastReadSeq: 1, unreadCount: 2 });
    expect(store.markUnread(channelId, 1).lastReadSeq).toBe(0);
  });

  it('listUnread returns only channels with unread', () => {
    const other = channels.create({ agentSession: 'sess-b', ownerUserId: 'u', name: 'd' }).id;
    add('agent');
    messages.insert({ channelId: other, senderType: 'agent', senderId: 'b', content: 'y' });
    store.markRead(other);
    expect(store.listUnread([channelId, other])).toEqual([{ channelId, lastReadSeq: 0, unreadCount: 1 }]);
    expect(store.listUnread([])).toEqual([]);
  });

  it('delete and channel hardDelete drop the marker', () => {
    add('agent');
    store.markRead(channelId);
    channels.hardDelete(channelId);
    expect(store.getLastReadSeq(channelId)).toBe(0);
    const other = channels.create({ agentSession: 's', ownerUserId: 'u', name: 'e' }).id;
    store.markUnread(other, 1);
    store.delete(other);
    expect(store.getLastReadSeq(other)).toBe(0);
  });
});
