/**
 * useChatUnreadCount — the number on the Chat nav badge and phone tab: unread
 * Chat messages, as the server counts them.
 *
 * Read state belongs to the owner and lives on the server (chat-v2
 * `chat_read_state`, #1400), so the badge, the Chat page, the Cloud portal and
 * the phone all agree. This hook only asks `GET /api/chat/unread` for the
 * total; it keeps no per-browser record. It refreshes on an interval and
 * immediately when the Chat page changes read state
 * ({@link notifyChatUnreadChanged}).
 *
 * @module hooks/useChatUnreadCount
 */

import { useEffect, useState } from 'react';
import { setVisibleInterval } from '../utils/visible-interval';

/** Unread summary endpoint (chat-v2). */
export const CHAT_UNREAD_API = '/api/chat/unread';

/** How often the badge refreshes (ms). */
export const CHAT_UNREAD_POLL_MS = 30_000;

/** Window event the Chat page fires after it changes read state. */
export const CHAT_UNREAD_CHANGED_EVENT = 'crewly:chat-unread-changed';

/**
 * Tell every mounted badge to refetch now (call after marking read / unread).
 */
export function notifyChatUnreadChanged(): void {
  try {
    window.dispatchEvent(new Event(CHAT_UNREAD_CHANGED_EVENT));
  } catch {
    /* no window (tests / SSR): the interval refresh still covers it */
  }
}

/**
 * Total unread messages, or null until the first load succeeds.
 *
 * @param pollMs - Refresh interval
 * @returns Total for the badge
 */
export function useChatUnreadCount(pollMs: number = CHAT_UNREAD_POLL_MS): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(CHAT_UNREAD_API);
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { total?: unknown } };
        const total = body?.data?.total;
        if (!cancelled && typeof total === 'number') setCount(total);
      } catch {
        /* keep the last known count */
      }
    };
    void load();
    const timer = setVisibleInterval(() => void load(), pollMs);
    const onChanged = (): void => void load();
    window.addEventListener(CHAT_UNREAD_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(CHAT_UNREAD_CHANGED_EVENT, onChanged);
    };
  }, [pollMs]);

  return count;
}

export default useChatUnreadCount;
