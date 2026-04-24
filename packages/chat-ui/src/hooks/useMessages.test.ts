import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { useMessages } from './useMessages';

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
  });
});
