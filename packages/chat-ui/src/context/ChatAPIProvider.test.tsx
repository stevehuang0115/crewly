import { describe, it, expect } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ChatAPIProvider,
  useChatApiClient,
  useChatProviderMode,
} from './ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';

describe('ChatAPIProvider', () => {
  it('mock mode exposes a mock client to descendants', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatAPIProvider mode="mock">{children}</ChatAPIProvider>
    );
    const { result } = renderHook(() => useChatApiClient(), { wrapper });
    expect(result.current).toBeInstanceOf(MockChatApiClient);
  });

  it('custom `client` prop wins over `mode`', () => {
    const custom = new MockChatApiClient({ initialChannels: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatAPIProvider mode="real" client={custom} backendURL="http://ignored">
        {children}
      </ChatAPIProvider>
    );
    const { result } = renderHook(() => useChatApiClient(), { wrapper });
    expect(result.current).toBe(custom);
  });

  it('real mode without backendURL throws a clear error', () => {
    // Temporarily silence the expected React error console noise.
    const originalError = console.error;
    console.error = () => {
      /* suppressed */
    };
    try {
      expect(() =>
        render(
          <ChatAPIProvider mode="real">
            <span />
          </ChatAPIProvider>,
        ),
      ).toThrow(/backendURL/);
    } finally {
      console.error = originalError;
    }
  });

  it('useChatApiClient outside provider throws', () => {
    const originalError = console.error;
    console.error = () => {
      /* suppressed */
    };
    try {
      expect(() => renderHook(() => useChatApiClient())).toThrow(/ChatAPIProvider/);
    } finally {
      console.error = originalError;
    }
  });

  it('useChatProviderMode reports the active mode', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChatAPIProvider mode="mock">{children}</ChatAPIProvider>
    );
    const { result } = renderHook(() => useChatProviderMode(), { wrapper });
    expect(result.current).toBe('mock');
  });
});
