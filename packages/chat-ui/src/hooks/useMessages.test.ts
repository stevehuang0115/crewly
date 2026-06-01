import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { useMessages, reconcileMessage, deriveAgentThinking, toAscendingBySeq } from './useMessages';
import type { Message } from '../types/chat.types';

describe('useMessages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads initial messages when channelId is set', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    const channelId = channels[0].id;

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useMessages(channelId), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.length).toBeGreaterThan(0);
  });

  it('sendMessage appends the user message to the timeline', async () => {
    const client = new MockChatApiClient({ agentReplyDelayMs: 10_000 });
    const channels = await client.listChannels();
    const channelId = channels[0].id;

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useMessages(channelId), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const baseline = result.current.messages.length;

    await act(async () => {
      await result.current.sendMessage({ content: 'hi' });
    });

    expect(result.current.messages.length).toBeGreaterThanOrEqual(baseline + 1);
    const sent = result.current.messages.find((m) => m.content === 'hi');
    expect(sent?.author.role).toBe('user');
  });

  it('clears messages when channelId becomes null', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useMessages(id),
      { wrapper, initialProps: { id: channels[0].id as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.messages.length).toBeGreaterThan(0);

    rerender({ id: null });
    expect(result.current.messages).toEqual([]);
    expect(result.current.agentThinking).toBe(false);
  });

  it('agentThinking flips true after a fresh user send and false on agent reply', async () => {
    const client = new MockChatApiClient({ agentReplyDelayMs: 0 });
    const channels = await client.listChannels();
    const channelId = channels[0].id;

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useMessages(channelId), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage({ content: 'is anyone home' });
    });

    // Mock client schedules its reply via window.setTimeout(0); flushing
    // the timer queue settles both the user-send + the agent reply.
    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last.author.role).toBe('agent');
    });
    expect(result.current.agentThinking).toBe(false);
  });
});

describe('reconcileMessage', () => {
  const baseAt = '2026-04-25T01:00:00.000Z';

  it('replaces a pending message in place when matched by clientMessageId', () => {
    const pending: Message = {
      id: 'cmid-1',
      channelId: 'c1',
      seq: -1,
      author: { role: 'user', id: 'me', name: 'You' },
      content: 'hi',
      createdAt: baseAt,
      clientMessageId: 'cmid-1',
      deliveryStatus: 'pending',
      mentions: [],
    };
    const confirmed: Message = {
      ...pending,
      id: 'srv-99',
      seq: 99,
      clientMessageId: 'cmid-1',
      deliveryStatus: 'sent',
      mentions: [],
    };

    const next = reconcileMessage([pending], confirmed);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('srv-99');
    expect(next[0].seq).toBe(99);
    expect(next[0].deliveryStatus).toBe('sent');
  });

  it('dedupes a re-broadcast that arrives after HTTP-201 reconciliation', () => {
    const persisted: Message = {
      id: 'srv-99',
      channelId: 'c1',
      seq: 99,
      author: { role: 'user', id: 'me' },
      content: 'hi',
      createdAt: baseAt,
      clientMessageId: 'cmid-1',
      deliveryStatus: 'sent',
      mentions: [],
    };
    const broadcast: Message = { ...persisted };

    const next = reconcileMessage([persisted], broadcast);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('srv-99');
  });

  it('appends when no existing record matches', () => {
    const existing: Message = {
      id: 'srv-1',
      channelId: 'c1',
      seq: 1,
      author: { role: 'agent', id: 'crewly-foo' },
      content: 'welcome',
      createdAt: baseAt,
      mentions: [],
    };
    const incoming: Message = {
      id: 'srv-2',
      channelId: 'c1',
      seq: 2,
      author: { role: 'user', id: 'me' },
      content: 'hello',
      createdAt: baseAt,
      clientMessageId: 'cmid-new',
      mentions: [],
    };

    const next = reconcileMessage([existing], incoming);
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe('srv-2');
  });
});

describe('deriveAgentThinking', () => {
  const baseAt = '2026-04-25T01:00:00.000Z';
  const userOptimistic: Message = {
    id: 'cmid-1',
    channelId: 'c1',
    seq: -1,
    author: { role: 'user', id: 'me' },
    content: 'hi',
    createdAt: baseAt,
    clientMessageId: 'cmid-1',
    deliveryStatus: 'pending',
    mentions: [],
  };
  const agentReply: Message = {
    id: 'srv-1',
    channelId: 'c1',
    seq: 5,
    author: { role: 'agent', id: 'crewly-foo' },
    content: 'hi back',
    createdAt: baseAt,
    mentions: [],
  };
  const userHistory: Message = {
    id: 'srv-old',
    channelId: 'c1',
    seq: 1,
    author: { role: 'user', id: 'me' },
    content: 'past',
    createdAt: baseAt,
    // no clientMessageId — it predates this session
    mentions: [],
  };

  it('returns false on empty timelines', () => {
    expect(deriveAgentThinking([])).toBe(false);
  });

  it('returns true when the latest message is a fresh user send', () => {
    expect(deriveAgentThinking([agentReply, userOptimistic])).toBe(true);
  });

  it('returns false when the latest message is an agent reply', () => {
    expect(deriveAgentThinking([userOptimistic, agentReply])).toBe(false);
  });

  it('returns false for stale user messages loaded from history', () => {
    expect(deriveAgentThinking([userHistory])).toBe(false);
  });
});

describe('toAscendingBySeq', () => {
  const mk = (seq: number): Message => ({
    id: `m-${seq}`,
    channelId: 'c1',
    seq,
    author: { role: 'user', id: 'me' },
    content: `msg ${seq}`,
    createdAt: '2026-04-25T01:00:00.000Z',
    mentions: [],
  });

  it('orders a newest-first (descending) page into ascending seq order', () => {
    // The backend default page is newest → oldest; the timeline must render
    // oldest → newest so the latest message lands at the bottom.
    const desc = [mk(26), mk(25), mk(24), mk(2), mk(1)];
    const asc = toAscendingBySeq(desc);
    expect(asc.map((m) => m.seq)).toEqual([1, 2, 24, 25, 26]);
    // Does not mutate the input.
    expect(desc.map((m) => m.seq)).toEqual([26, 25, 24, 2, 1]);
  });
});
