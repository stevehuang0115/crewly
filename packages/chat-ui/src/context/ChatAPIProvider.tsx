/**
 * ChatAPIProvider — the single injection point for the @crewly/chat-ui
 * package.
 *
 * Consumers (OSS frontend, Portal) wrap their chat surface with this
 * provider and pass a `backendURL` + optional `authToken`. All components
 * and hooks in the package read their client from this context.
 *
 * Two modes:
 *  - `real` (default) — constructs an `HttpChatApiClient` against the
 *    given backend. Production path.
 *  - `mock`            — constructs a `MockChatApiClient` for local demo,
 *    Storybook, and UI iteration while the backend spec is still in flux.
 *
 * NOTE: This component is part of the shared package; it is imported by
 * both OSS and Portal. Keep it backend-agnostic.
 *
 * @module context/ChatAPIProvider
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { HttpChatApiClient, type ChatApiClient } from '../api/client';
import { MockChatApiClient } from '../api/mock-client';

type ChatProviderMode = 'real' | 'mock';

export interface ChatAPIProviderProps {
  children: ReactNode;
  /**
   * Base URL of the Chat backend (OSS instance). Ignored in `mock` mode.
   * Required in `real` mode.
   */
  backendURL?: string;
  /**
   * Bearer token passed through Authorization headers + WS query string.
   * Portal injects a Cloud-scoped token here; OSS passes its local token.
   */
  authToken?: string;
  /**
   * Choose the transport. Defaults to `real` so forgetting to set it in
   * production doesn't silently ship a mock.
   */
  mode?: ChatProviderMode;
  /**
   * Escape hatch for tests and advanced consumers who want to supply a
   * custom `ChatApiClient` implementation directly. When set, `mode` and
   * `backendURL` are ignored.
   */
  client?: ChatApiClient;
}

interface ChatContextValue {
  client: ChatApiClient;
  mode: ChatProviderMode;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * Provide a Chat API client to descendants.
 */
export function ChatAPIProvider({
  children,
  backendURL,
  authToken,
  mode = 'real',
  client,
}: ChatAPIProviderProps): JSX.Element {
  const value = useMemo<ChatContextValue>(() => {
    if (client) return { client, mode };
    if (mode === 'mock') {
      return { client: new MockChatApiClient(), mode };
    }
    if (!backendURL) {
      throw new Error(
        '[@crewly/chat-ui] ChatAPIProvider requires `backendURL` when mode="real".',
      );
    }
    return {
      client: new HttpChatApiClient({ backendURL, authToken }),
      mode,
    };
  }, [backendURL, authToken, mode, client]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * Internal hook used by other hooks in this package to read the injected
 * client. Throws a readable error when used outside a provider so
 * consumers fail fast instead of seeing cryptic `undefined` errors.
 */
export function useChatApiClient(): ChatApiClient {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error(
      '[@crewly/chat-ui] useChatApiClient must be called inside <ChatAPIProvider>.',
    );
  }
  return ctx.client;
}

/** Exposed for debugging / conditional UI (e.g. "mock mode" banner). */
export function useChatProviderMode(): ChatProviderMode {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error(
      '[@crewly/chat-ui] useChatProviderMode must be called inside <ChatAPIProvider>.',
    );
  }
  return ctx.mode;
}
