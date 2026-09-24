/**
 * Tests for owner-inbound utils — messenger owner messages recorded as
 * chat-v2 `user` turns (#730).
 */
import { describe, it, expect, jest } from '@jest/globals';
import { messengerConversationId, recordMessengerOwnerTurn, type OwnerInboundChat } from './owner-inbound.utils.js';

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
