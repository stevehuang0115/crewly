import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { useMergedMessages, toChronological } from './useMergedMessages';
import type { ChatApiClient, ChannelSubscription } from '../api/client';
import type {
  Channel,
  Message,
  MessagePage,
  SendMessageInput,
  AgentPresence,
  ChatWebsocketEvent,
  CreateChannelInput,
} from '../types/chat.types';

/** Build a message with sane defaults; override per test. */
function msg(partial: Partial<Message> & Pick<Message, 'id' | 'channelId' | 'createdAt'>): Message {
  return {
    seq: 0,
    author: { role: 'agent', id: 'a', name: 'A' },
    content: partial.id,
    mentions: [],
    ...partial,
  } as Message;
}

/** Stub client driven by a fixed per-channel message map; can emit WS events. */
function makeStub(messages: Record<string, Message[]>): {
  client: ChatApiClient;
  emit: (channelId: string, message: Message) => void;
} {
  const subscribers: Record<string, Array<(e: ChatWebsocketEvent) => void>> = {};
  const client: ChatApiClient = {
    async listChannels(): Promise<Channel[]> {
      return [];
    },
    async createChannel(_i: CreateChannelInput): Promise<Channel> {
      throw new Error('unused');
    },
    async createHuddle(): Promise<Channel> {
      throw new Error('unused');
    },
    async listMessages(channelId: string): Promise<MessagePage> {
      return { messages: messages[channelId] ?? [], nextCursor: null };
    },
    async sendMessage(_c: string, _i: SendMessageInput): Promise<Message> {
      throw new Error('unused');
    },
    async getAgentPresence(agentId: string): Promise<AgentPresence> {
      return { agentId, status: 'online' };
    },
    subscribeToChannel(channelId, onEvent): ChannelSubscription {
      (subscribers[channelId] ||= []).push(onEvent);
      return {
        unsubscribe: () => {
          subscribers[channelId] = (subscribers[channelId] ?? []).filter((cb) => cb !== onEvent);
        },
      };
    },
  };
  return {
    client,
    emit: (channelId, message) => {
      for (const cb of subscribers[channelId] ?? []) cb({ type: 'message', channelId, message });
    },
  };
}

const wrap = (client: ChatApiClient) => ({ children }: { children: ReactNode }) =>
  createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

describe('toChronological', () => {
  it('orders by createdAt ascending across channels', () => {
    const out = toChronological([
      msg({ id: 'c', channelId: 'x', createdAt: '2026-01-01T00:03:00Z' }),
      msg({ id: 'a', channelId: 'y', createdAt: '2026-01-01T00:01:00Z' }),
      msg({ id: 'b', channelId: 'x', createdAt: '2026-01-01T00:02:00Z' }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to seq then id when timestamps tie', () => {
    const t = '2026-01-01T00:00:00Z';
    const out = toChronological([
      msg({ id: 'z', channelId: 'x', createdAt: t, seq: 2 }),
      msg({ id: 'm', channelId: 'x', createdAt: t, seq: 1 }),
      msg({ id: 'a', channelId: 'y', createdAt: t, seq: 1 }),
    ]);
    // seq 1 before seq 2; within seq 1, id 'a' before 'm'.
    expect(out.map((m) => m.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('useMergedMessages', () => {
  it('merges the latest page of every channel into one time-ordered feed', async () => {
    const { client } = makeStub({
      orc: [msg({ id: 'o1', channelId: 'orc', createdAt: '2026-01-01T00:01:00Z' })],
      'slack-1': [msg({ id: 's1', channelId: 'slack-1', createdAt: '2026-01-01T00:02:00Z' })],
    });
    const { result } = renderHook(() => useMergedMessages(['orc', 'slack-1']), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.map((m) => m.id)).toEqual(['o1', 's1']);
  });

  it('interleaves a WS message from a secondary channel by timestamp', async () => {
    const { client, emit } = makeStub({
      orc: [
        msg({ id: 'o1', channelId: 'orc', createdAt: '2026-01-01T00:01:00Z' }),
        msg({ id: 'o3', channelId: 'orc', createdAt: '2026-01-01T00:03:00Z' }),
      ],
      'slack-1': [],
    });
    const { result } = renderHook(() => useMergedMessages(['orc', 'slack-1']), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    act(() => {
      emit('slack-1', msg({ id: 's2', channelId: 'slack-1', createdAt: '2026-01-01T00:02:00Z' }));
    });
    // The Slack message slots BETWEEN the two orchestrator messages by time.
    expect(result.current.messages.map((m) => m.id)).toEqual(['o1', 's2', 'o3']);
  });

  it('renders nothing for an empty channel set', async () => {
    const { client } = makeStub({});
    const { result } = renderHook(() => useMergedMessages([]), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages).toEqual([]);
  });

  it('derives agentThinking from a fresh user send at the tail', async () => {
    const { client, emit } = makeStub({ orc: [] });
    const { result } = renderHook(() => useMergedMessages(['orc']), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      emit(
        'orc',
        msg({
          id: 'u1',
          channelId: 'orc',
          createdAt: '2026-01-01T00:05:00Z',
          author: { role: 'user', id: 'me', name: 'Me' },
          clientMessageId: 'cmid-1',
        }),
      );
    });
    expect(result.current.agentThinking).toBe(true);
  });
});
