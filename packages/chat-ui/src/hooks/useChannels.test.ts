import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { useChannels } from './useChannels';

describe('useChannels', () => {
  it('loads seeded channels on mount', async () => {
    const client = new MockChatApiClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useChannels(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.channels.length).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  it('refresh() re-fetches the list', async () => {
    const client = new MockChatApiClient({ initialChannels: [] });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useChannels(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels).toHaveLength(0);

    await client.createChannel({ agentSession: 'a1', name: 'A1' });
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.channels).toHaveLength(1);
    });
  });
});
