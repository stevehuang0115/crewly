/**
 * useMessages — message timeline for a single channel.
 *
 * Responsibilities:
 *  - Initial load via REST
 *  - Subscribe to the channel's WS feed and append incoming messages
 *  - Pagination via `loadMore()` walking the cursor backwards
 *  - Expose a `sendMessage()` helper that performs the optimistic write
 *    and returns the server-assigned row
 *
 * Phase 1 does not implement virtual scrolling — paginated load is
 * sufficient per Decisions doc #5.
 *
 * @module hooks/useMessages
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, SendMessageInput } from '../types/chat.types';
import { useChatApiClient } from '../context/ChatAPIProvider';

export interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore(): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<Message>;
}

export function useMessages(channelId: string | null): UseMessagesResult {
  const client = useChatApiClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);

  // Load the initial page whenever the channel changes.
  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      setHasMore(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    cursorRef.current = null;

    client
      .listMessages(channelId)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, client]);

  // Subscribe to WS for the active channel.
  useEffect(() => {
    if (!channelId) return;
    const sub = client.subscribeToChannel(channelId, (event) => {
      if (event.type === 'message') {
        setMessages((prev) =>
          prev.some((m) => m.id === event.payload.id) ? prev : [...prev, event.payload],
        );
      } else if (event.type === 'ack') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.payload.clientMessageId ? event.payload.serverMessage : m,
          ),
        );
      }
    });
    return () => sub.unsubscribe();
  }, [channelId, client]);

  const loadMore = useCallback(async () => {
    if (!channelId || !cursorRef.current) return;
    const cursor = cursorRef.current;
    try {
      const page = await client.listMessages(channelId, { cursor });
      setMessages((prev) => [...page.messages, ...prev]);
      cursorRef.current = page.nextCursor;
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [channelId, client]);

  const sendMessage = useCallback(
    async (input: SendMessageInput) => {
      if (!channelId) throw new Error('sendMessage called without an active channel.');
      const result = await client.sendMessage(channelId, input);
      setMessages((prev) => (prev.some((m) => m.id === result.id) ? prev : [...prev, result]));
      return result;
    },
    [channelId, client],
  );

  return { messages, loading, error, hasMore, loadMore, sendMessage };
}
