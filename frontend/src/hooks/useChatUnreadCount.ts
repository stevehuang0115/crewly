/**
 * useChatUnreadCount — the number on the Chat nav badge and phone tab:
 * conversations with a message since the owner last looked.
 *
 * The backend keeps no read state, so "seen" is a per-browser record in
 * localStorage: one timestamp for "opened Chat" plus optional per-channel
 * timestamps (`markChatSeen(channelId)`, for the Chat page to call when a
 * conversation is open). A channel is unread when its `lastMessageAt` is
 * newer than both. While the owner is on Chat everything counts as seen.
 *
 * @module hooks/useChatUnreadCount
 */

import { useEffect, useState } from 'react';

/** Channels endpoint (chat-v2). */
export const CHAT_CHANNELS_API = '/api/chat/channels';

/** localStorage key of the seen record. */
export const CHAT_SEEN_STORAGE_KEY = 'crewly.chat.seen';

/** How often the badge refreshes (ms). */
export const CHAT_UNREAD_POLL_MS = 30_000;

/** Seen record: `all` = last time Chat was open; other keys = channel ids. */
export type ChatSeenRecord = Record<string, number>;

/**
 * Read the seen record (best-effort).
 *
 * @returns The record, empty when unavailable
 */
export function readChatSeen(): ChatSeenRecord {
  try {
    const raw = window.localStorage.getItem(CHAT_SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as ChatSeenRecord) : {};
  } catch {
    return {};
  }
}

/**
 * Mark Chat (or one conversation) as seen now.
 *
 * @param channelId - A conversation id; omit to mark everything
 * @param now - Clock
 */
export function markChatSeen(channelId?: string, now: number = Date.now()): void {
  try {
    const record = readChatSeen();
    record[channelId ?? 'all'] = now;
    window.localStorage.setItem(CHAT_SEEN_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable: the badge just stays approximate */
  }
}

/**
 * Count unread conversations.
 *
 * @param channels - Channels with `lastMessageAt` (ms)
 * @param seen - Seen record
 * @returns Number of conversations with newer activity
 */
export function countUnread(
  channels: Array<{ id: string; lastMessageAt?: number | null; archivedAt?: number | null }>,
  seen: ChatSeenRecord,
): number {
  return channels.filter((c) => {
    if (c.archivedAt || !c.lastMessageAt) return false;
    const seenAt = Math.max(seen.all ?? 0, seen[c.id] ?? 0);
    return c.lastMessageAt > seenAt;
  }).length;
}

/**
 * Unread conversation count, or null until the first load.
 *
 * @param onChat - True while the Chat page is open (marks everything seen)
 * @param pollMs - Refresh interval
 * @returns Count for the badge
 */
export function useChatUnreadCount(onChat: boolean, pollMs: number = CHAT_UNREAD_POLL_MS): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (onChat) {
        markChatSeen();
        setCount(0);
        return;
      }
      try {
        const res = await fetch(CHAT_CHANNELS_API);
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { channels?: Array<{ id: string; lastMessageAt?: number | null; archivedAt?: number | null }> } };
        const channels = body?.data?.channels;
        if (!cancelled && Array.isArray(channels)) setCount(countUnread(channels, readChatSeen()));
      } catch {
        /* keep the last known count */
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // Leaving Chat counts as having seen it up to now.
      if (onChat) markChatSeen();
    };
  }, [onChat, pollMs]);

  return count;
}

export default useChatUnreadCount;
