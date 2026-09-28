/**
 * Tests for owner-inbound utils — messenger owner messages recorded as
 * chat-v2 `user` turns (#730).
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  messengerConversationId,
  recordCloudTalkTurn,
  recordMessengerAgentReply,
  recordMessengerOwnerTurn,
  type OwnerInboundChat,
} from './owner-inbound.utils.js';
import { ChatV2Service } from './chat-v2.service.js';
import { openChatDatabase } from './sqlite/chat-db.js';
import { loadChatV2Config } from './config.js';

/** A chat double that records what it was asked to write. */
function makeChat(opts: { failRecord?: boolean } = {}) {
  const ensure = jest.fn((args: { conversationId: string }) => ({ id: args.conversationId }) as never);
  const record = jest.fn((_input: unknown) => {
    if (opts.failRecord) throw new Error('db locked');
    return { message: { id: 'm1' }, deduped: false } as never;
  });
  const chat: OwnerInboundChat = {
    ensureChannelForLegacyConversation: ensure as unknown as OwnerInboundChat['ensureChannelForLegacyConversation'],
    recordTurn: record as unknown as OwnerInboundChat['recordTurn'],
  };
  return { chat, ensure, record };
}

describe('messengerConversationId', () => {
  it('makes a URL-safe id from a Google Chat space name', () => {
    expect(messengerConversationId('gchat', 'spaces/AAQA1')).toBe('gchat-spaces-AAQA1');
  });

  it('keeps a negative Telegram group id distinct from a user id', () => {
    expect(messengerConversationId('telegram', '-100123')).not.toBe(messengerConversationId('telegram', '100123'));
  });

  it('falls back when the platform id is empty', () => {
    expect(messengerConversationId('telegram', '')).toBe('telegram-unknown');
  });
});

describe('recordMessengerOwnerTurn', () => {
  it('records a user turn on the orchestrator channel with the surface as source', () => {
    const { chat, ensure, record } = makeChat();
    const id = recordMessengerOwnerTurn(chat, {
      conversationId: 'telegram-42',
      content: 'go ahead',
      senderId: 'steve',
      source: 'telegram',
      metadata: { telegramChatId: '42' },
    });

    expect(id).toBe('telegram-42');
    expect(ensure).toHaveBeenCalledWith({ conversationId: 'telegram-42', agentSession: 'crewly-orc' });
    expect(record).toHaveBeenCalledWith({
      channelId: 'telegram-42',
      senderType: 'user',
      senderId: 'steve',
      content: 'go ahead',
      metadata: { telegramChatId: '42', source: 'telegram' },
    });
  });

  it('cannot be told to write a different source through metadata', () => {
    const { chat, record } = makeChat();
    recordMessengerOwnerTurn(chat, {
      conversationId: 'gchat-x',
      content: 'approved',
      senderId: 'u',
      source: 'google-chat',
      metadata: { source: 'web' },
    });
    expect((record.mock.calls[0][0] as { metadata: { source: string } }).metadata.source).toBe('google-chat');
  });

  it('skips empty messages', () => {
    const { chat, record } = makeChat();
    expect(recordMessengerOwnerTurn(chat, { conversationId: 'c', content: '  ', senderId: 'u', source: 'telegram' })).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the store fails', () => {
    const { chat } = makeChat({ failRecord: true });
    expect(
      recordMessengerOwnerTurn(chat, { conversationId: 'c', content: 'do it', senderId: 'u', source: 'telegram' }),
    ).toBeNull();
  });
});

describe('recordMessengerAgentReply (G1)', () => {
  it('records an agent turn on the conversation, idempotent on the platform message id', () => {
    const { chat, ensure, record } = makeChat();
    const id = recordMessengerAgentReply(chat, {
      conversationId: 'telegram-42',
      content: 'done',
      source: 'telegram',
      platformMessageId: 77,
      metadata: { telegramChatId: '42', source: 'web' },
    });
    expect(id).toBe('m1');
    expect(ensure).toHaveBeenCalledWith({ conversationId: 'telegram-42', agentSession: 'crewly-orc' });
    expect(record).toHaveBeenCalledWith({
      channelId: 'telegram-42',
      senderType: 'agent',
      senderId: 'crewly-orc',
      content: 'done',
      clientMessageId: 'telegram-out-77',
      metadata: { telegramChatId: '42', source: 'telegram' },
    });
  });

  it('omits the idempotency key when the platform gave no id, and credits the given agent', () => {
    const { chat, record } = makeChat();
    recordMessengerAgentReply(chat, { conversationId: 'gchat-x', content: 'hi', source: 'google-chat', agentSession: 'sam' });
    const input = record.mock.calls[0][0] as Record<string, unknown>;
    expect(input.clientMessageId).toBeUndefined();
    expect(input.senderId).toBe('sam');
  });

  it('skips empty text and swallows store failures', () => {
    const { chat, record } = makeChat();
    expect(recordMessengerAgentReply(chat, { conversationId: 'c', content: ' ', source: 'whatsapp' })).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(recordMessengerAgentReply(makeChat({ failRecord: true }).chat, { conversationId: 'c', content: 'x', source: 'whatsapp' })).toBeNull();
  });

  it('on the real store: one in-row and one out-row with the right source, direction and ids', () => {
    const service = new ChatV2Service({
      config: loadChatV2Config({}),
      db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
    });
    recordMessengerOwnerTurn(service, {
      conversationId: 'telegram-42',
      content: 'status?',
      senderId: 'steve',
      source: 'telegram',
      metadata: { telegramChatId: '42', telegramMessageId: 5 },
    });
    recordMessengerAgentReply(service, {
      conversationId: 'telegram-42',
      content: 'all green',
      source: 'telegram',
      platformMessageId: 6,
      metadata: { telegramChatId: '42', telegramMessageId: 6 },
    });
    // A retry of the same platform message does not add a row.
    recordMessengerAgentReply(service, { conversationId: 'telegram-42', content: 'all green', source: 'telegram', platformMessageId: 6 });
    const items = service.getAgentTimeline({ agentSession: 'crewly-orc', principal: { userId: 'u', source: 'oss' } }).items;
    expect(items.map((i) => [i.content, i.source, i.direction, i.senderKind, i.extRef])).toEqual([
      ['all green', 'telegram', 'out', 'agent', { telegramChatId: '42', telegramMessageId: '6' }],
      ['status?', 'telegram', 'in', 'owner', { telegramChatId: '42', telegramMessageId: '5' }],
    ]);
    service.close();
  });
});

describe('recordCloudTalkTurn (G3 hook for the Talk send path)', () => {
  it('records a cloud-talk owner turn in the agent\'s DM, once per Talk message id', () => {
    const service = new ChatV2Service({
      config: loadChatV2Config({}),
      db: openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true }),
    });
    const args = { agentSession: 'ella', text: 'how is it going?', clientMessageId: 'talk-1', ownerUserId: 'dev-user-001' };
    const first = recordCloudTalkTurn(service, args);
    const again = recordCloudTalkTurn(service, args);
    expect(first.deduped).toBe(false);
    expect(again.deduped).toBe(true);
    expect(again.channelId).toBe(first.channelId);
    expect(first.message.metadata).toMatchObject({ source: 'cloud-talk', clientMessageId: 'talk-1' });
    const dm = service.ensureDmChannel({ agentSession: 'ella', principal: { userId: 'dev-user-001', source: 'oss' } }).channel;
    expect(dm.id).toBe(first.channelId);
    expect(service.getLatestOwnerTurnSource(dm.id)).toBe('cloud-talk');
    service.close();
  });
});
