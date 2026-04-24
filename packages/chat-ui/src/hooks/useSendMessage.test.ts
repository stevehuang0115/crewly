import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { useSendMessage } from './useSendMessage';

describe('useSendMessage', () => {
  it('resolves with the server message on success', async () => {
    const client = new MockChatApiClient();
    const [ch] = await client.listChannels();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useSendMessage(), { wrapper });

    let out: { content: string } | undefined;
    await act(async () => {
      out = await result.current.send(ch.id, { content: 'yo' });
    });

    expect(out?.content).toBe('yo');
    expect(result.current.error).toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it('captures errors onto state and still rethrows', async () => {
    const client = new MockChatApiClient({ initialChannels: [] });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useSendMessage(), { wrapper });

    await act(async () => {
      await expect(
        result.current.send('missing', { content: 'x' }),
      ).rejects.toThrow();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
  });

  it('reset() clears the error and sending state', async () => {
    const client = new MockChatApiClient({ initialChannels: [] });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ChatAPIProvider, { client, mode: 'mock' }, children);

    const { result } = renderHook(() => useSendMessage(), { wrapper });

    await act(async () => {
      await result.current.send('missing', { content: 'x' }).catch(() => undefined);
    });
    expect(result.current.error).not.toBeNull();

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });
});
