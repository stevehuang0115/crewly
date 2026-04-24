import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { useAgentPresence } from './useAgentPresence';

describe('useAgentPresence', () => {
  it('returns `offline` for a null agentId without calling the API', async () => {
    const client = new MockChatApiClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useAgentPresence(null), { wrapper });

    expect(result.current.status).toBe('offline');
    expect(result.current.loading).toBe(false);
  });

  it('reports initial presence from the API snapshot', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    const online = channels.find((c) => c.presence === 'online');
    if (!online) throw new Error('fixture regression: no online channel');

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(
      () => useAgentPresence(online.agentSession, online.id),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBe('online');
  });
});
