import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockChatApiClient } from './mock-client';
import type { ChatWebsocketEvent } from '../types/chat.types';

describe('MockChatApiClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeds at least one channel by default', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    expect(channels.length).toBeGreaterThan(0);
  });

  it('createChannel appends to the in-memory list', async () => {
    const client = new MockChatApiClient({ initialChannels: [] });
    const ch = await client.createChannel({ agentSession: 'a1', name: 'A1' });
    const all = await client.listChannels();
    expect(all).toContainEqual(ch);
  });

  it('sendMessage emits optimistic + confirmed user events, then a delayed agent reply', async () => {
    const client = new MockChatApiClient({ agentReplyDelayMs: 500 });
    const [channel] = await client.listChannels();

    const events: ChatWebsocketEvent[] = [];
    client.subscribeToChannel(channel.id, (e) => events.push(e));

    await client.sendMessage(channel.id, { content: 'hi' });
    const userMessageEvents = events.filter((e) => e.type === 'message');
    expect(userMessageEvents).toHaveLength(2);
    if (userMessageEvents[0].type === 'message' && userMessageEvents[1].type === 'message') {
      expect(userMessageEvents[0].message.deliveryStatus).toBe('pending');
      expect(userMessageEvents[1].message.deliveryStatus).toBe('sent');
      expect(userMessageEvents[0].message.clientMessageId).toBe(
        userMessageEvents[1].message.clientMessageId,
      );
    }

    vi.advanceTimersByTime(500);
    const allMessageEvents = events.filter((e) => e.type === 'message');
    expect(allMessageEvents).toHaveLength(3);
    const reply = allMessageEvents[2];
    if (reply.type !== 'message') throw new Error('expected message');
    expect(reply.message.author.role).toBe('agent');
  });

  it('listMessages returns the seeded welcome message', async () => {
    const client = new MockChatApiClient();
    const [channel] = await client.listChannels();
    const page = await client.listMessages(channel.id);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.nextCursor).toBeNull();
  });

  it('subscribe/unsubscribe removes the callback', async () => {
    const client = new MockChatApiClient();
    const [channel] = await client.listChannels();
    const cb = vi.fn();
    const sub = client.subscribeToChannel(channel.id, cb);
    sub.unsubscribe();
    await client.sendMessage(channel.id, { content: 'after unsubscribe' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('getAgentPresence reports offline for unknown agents', async () => {
    const client = new MockChatApiClient();
    const presence = await client.getAgentPresence('unknown');
    expect(presence.status).toBe('offline');
  });
});
