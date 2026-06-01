/**
 * useMessages — message timeline for a single channel.
 *
 * Responsibilities:
 *  - Initial load via REST
 *  - Subscribe to the channel's WS feed and append incoming messages
 *  - Pagination via `loadMore()` walking the cursor backwards
 *  - Expose a `sendMessage()` helper that performs the optimistic write
 *    via the injected client and returns the server-assigned row
 *  - Surface an `agentThinking` derived state used to render the typing
 *    indicator while the user waits for the agent's reply
 *
 * Optimistic-send reconciliation rule (Sam's tech spec §6, locked
 * 2026-04-24):
 *   1. The client emits a `pending` message into the same event stream
 *      via `subscribeToChannel`. We add it to the timeline.
 *   2. The HTTP 201 response carries the server record back through the
 *      same stream. We MATCH BY `clientMessageId` and replace.
 *   3. The eventual WS broadcast for the same row arrives — also with
 *      `clientMessageId` in metadata. We dedupe (no duplicate appended).
 *
 * Phase 1 does not implement virtual scrolling — paginated load is
 * sufficient.
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
  /**
   * `true` when the user has just sent a message and the agent has not
   * yet replied. Drives the "agent is thinking…" indicator.
   */
  agentThinking: boolean;
  loadMore(): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<Message>;
}

/**
 * Append-or-reconcile rule: an incoming message either replaces an existing
 * record (matched by `clientMessageId` first, then by `id`) or is appended
 * to the end. Pure helper so the reducer can be unit-tested without React.
 *
 * @param prev - Current ordered timeline
 * @param incoming - New / updated message from the local emitter or WS
 * @returns Next timeline reference; same array instance if no change
 */
export function reconcileMessage(prev: Message[], incoming: Message): Message[] {
  // First: match by clientMessageId (covers optimistic → confirmed/failed +
  // server WS broadcast of the same row).
  if (incoming.clientMessageId) {
    const idxByCmid = prev.findIndex(
      (m) => m.clientMessageId && m.clientMessageId === incoming.clientMessageId,
    );
    if (idxByCmid >= 0) {
      const next = prev.slice();
      next[idxByCmid] = incoming;
      return next;
    }
  }
  // Then: dedupe by server id (replay or duplicate broadcast).
  const idxById = prev.findIndex((m) => m.id === incoming.id);
  if (idxById >= 0) {
    // Prefer the newer record (e.g. seq promoted from -1 to a real seq).
    const next = prev.slice();
    next[idxById] = incoming;
    return next;
  }
  return [...prev, incoming];
}

/**
 * Derive whether the agent is "thinking".
 *
 * True when the most recent message on the timeline is a freshly-sent
 * user message — i.e. it carries a `clientMessageId` (set either by the
 * optimistic emitter or the server echo). Old user messages loaded from
 * history without an idempotency token never trigger the indicator, so
 * scrolling back into a paused conversation does not show a stuck
 * "thinking…" bubble.
 *
 * @param messages - Current ordered timeline
 * @returns Whether to show the "agent is thinking" indicator
 */
/**
 * Normalize a fetched page to ascending-by-seq (oldest → newest).
 *
 * The backend's default ("backward") page is ordered newest → oldest for
 * cursor pagination, but the whole timeline contract here is ASCENDING:
 * new messages append to the end, `deriveAgentThinking` inspects the last
 * element, and the thread renders top → bottom and auto-scrolls to the
 * bottom. Without this normalization the timeline renders inverted (newest
 * at the top, hidden after the scroll-to-bottom) and the "thinking"
 * indicator reads the wrong end. Sorting by `seq` is robust regardless of
 * the order the API happens to return.
 */
export function toAscendingBySeq(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => a.seq - b.seq);
}

/**
 * Select the root (top-level) messages from a timeline — those that are
 * NOT thread replies (`threadId` unset). The main channel timeline renders
 * only these; replies live inside the thread panel.
 *
 * Pure helper so the split is unit-testable without React.
 *
 * @param messages - The full channel timeline
 * @returns Root messages in their original order
 */
export function selectRootMessages(messages: Message[]): Message[] {
  return messages.filter((m) => !m.threadId);
}

/**
 * Select the replies belonging to a given thread root, ascending by `seq`
 * (oldest → newest, matching the timeline contract). A reply belongs to a
 * thread when its `threadId` equals the root message id.
 *
 * Pure helper so the thread panel can derive its view live from `messages`
 * (so a reply arriving via WS shows instantly) and so the split is
 * unit-testable without React.
 *
 * @param messages - The full channel timeline
 * @param rootId - The thread root message id
 * @returns Reply messages for that thread, ascending by seq
 */
export function selectThreadReplies(messages: Message[], rootId: string): Message[] {
  return messages.filter((m) => m.threadId === rootId).sort((a, b) => a.seq - b.seq);
}

export function deriveAgentThinking(messages: Message[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.author.role !== 'user') return false;
  return Boolean(last.clientMessageId);
}

export function useMessages(channelId: string | null): UseMessagesResult {
  const client = useChatApiClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [agentThinking, setAgentThinking] = useState<boolean>(false);

  // Load the initial page whenever the channel changes.
  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      setHasMore(false);
      setAgentThinking(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    cursorRef.current = null;
    setAgentThinking(false);

    client
      .listMessages(channelId)
      .then((page) => {
        if (cancelled) return;
        setMessages(toAscendingBySeq(page.messages));
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

  // Subscribe to the channel's WS + local-optimistic feed.
  useEffect(() => {
    if (!channelId) return;
    const sub = client.subscribeToChannel(channelId, (event) => {
      if (event.type === 'message') {
        setMessages((prev) => {
          const next = reconcileMessage(prev, event.message);
          // Update agentThinking based on the post-reconciliation tail.
          setAgentThinking(deriveAgentThinking(next));
          return next;
        });
      }
      // presence + pong + error are not handled here; useAgentPresence
      // and observability hooks consume those.
    });
    return () => sub.unsubscribe();
  }, [channelId, client]);

  const loadMore = useCallback(async () => {
    if (!channelId || !cursorRef.current) return;
    const cursor = cursorRef.current;
    try {
      const page = await client.listMessages(channelId, { cursor });
      // Older page is also newest → oldest; normalize then prepend so the
      // combined timeline stays ascending.
      setMessages((prev) => [...toAscendingBySeq(page.messages), ...prev]);
      cursorRef.current = page.nextCursor;
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [channelId, client]);

  const sendMessage = useCallback(
    async (input: SendMessageInput) => {
      if (!channelId) throw new Error('sendMessage called without an active channel.');
      // The client emits the optimistic + confirmed events through the
      // subscription stream — our timeline picks them up there. We just
      // await the canonical row to surface errors back to the caller.
      return await client.sendMessage(channelId, input);
    },
    [channelId, client],
  );

  return { messages, loading, error, hasMore, agentThinking, loadMore, sendMessage };
}
