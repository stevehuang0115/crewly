/**
 * useChatReadState — the Chat page's view of the owner's server-side read state
 * (#1400, specs/chat-unread.md).
 *
 * The server owns one read marker per channel. This hook layers the page
 * behaviour on top of it:
 *
 *  - per-conversation unread counts, from the channel list plus live
 *    `read_state` frames (a frame beats the list until the next list refresh);
 *  - opening a conversation marks it read, and keeps marking it read while new
 *    messages arrive in it;
 *  - the "Unread" divider sits at the marker as it was when the conversation
 *    was opened, so the owner can see what was new even though it is now read;
 *  - "Mark unread" on a message moves the marker back to just before it, moves
 *    the divider there, and stops auto-marking until the owner leaves and
 *    reopens the conversation (Slack semantics).
 *
 * @module hooks/useChatReadState
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel, ChannelReadState, ChatApiClient } from '@crewly/chat-ui';
import { notifyChatUnreadChanged } from './useChatUnreadCount';

/** Inputs of {@link useChatReadState}. */
export interface UseChatReadStateOptions {
  /** Chat API client (read-state methods are optional on it). */
  client: ChatApiClient;
  /** The channel list as last fetched (carries `lastReadSeq` / `unreadCount`). */
  channels: Channel[];
  /** False while the list is still loading for the first time. */
  ready: boolean;
  /**
   * The conversation being viewed (its id), or null when none is on screen
   * (nothing open, or a phone showing the list).
   */
  openId: string | null;
  /**
   * Channel ids that make up a conversation: the id itself, except the
   * orchestrator's, which also covers its merged Slack thread channels.
   */
  idsOf(conversationId: string): string[];
}

/** What the page gets back. */
export interface UseChatReadStateResult {
  /** Unread messages in a conversation (all of its channels). */
  unreadCountOf(conversationId: string): number;
  /**
   * Where the "Unread" divider goes in the open conversation: the marker as of
   * opening (or as moved by "Mark unread"). Null when there is nothing to show
   * or the conversation merges several channels (their seqs are not comparable).
   */
  unreadAfterSeq: number | null;
  /** Feed a `read_state` frame from the live stream. */
  applyReadState(state: ChannelReadState): void;
  /** Keep a message for later: marker -> `seq - 1`; no auto-read until reopened. */
  markUnread(channelId: string, seq: number): Promise<void>;
}

/** Read state of a channel from the list DTO (no row = never read). */
function fromChannel(channel: Channel | undefined): { lastReadSeq: number; unreadCount: number } {
  return { lastReadSeq: channel?.lastReadSeq ?? 0, unreadCount: channel?.unreadCount ?? 0 };
}

/**
 * Server-side unread for the Chat page.
 *
 * @param options - {@link UseChatReadStateOptions}
 * @returns Counts, divider position and the two mutations
 */
export function useChatReadState({
  client,
  channels,
  ready,
  openId,
  idsOf,
}: UseChatReadStateOptions): UseChatReadStateResult {
  // Newer-than-the-list state from our own calls and live frames.
  const [overrides, setOverrides] = useState<Record<string, ChannelReadState>>({});
  const [divider, setDivider] = useState<{ channelId: string; seq: number } | null>(null);
  // The conversation the owner marked unread in; no auto-read there until reopened.
  const heldRef = useRef<string | null>(null);
  const inflightRef = useRef(false);
  // Re-evaluates the auto-read once an in-flight call finishes (a message may have arrived meanwhile).
  const [settled, setSettled] = useState(0);
  const idsOfRef = useRef(idsOf);
  idsOfRef.current = idsOf;

  // A fresh list is server truth again.
  useEffect(() => {
    setOverrides({});
  }, [channels]);

  const stateOf = useCallback(
    (channelId: string): { lastReadSeq: number; unreadCount: number } =>
      overrides[channelId] ?? fromChannel(channels.find((c) => c.id === channelId)),
    [overrides, channels],
  );

  const unreadCountOf = useCallback(
    (conversationId: string): number =>
      idsOfRef.current(conversationId).reduce((n, id) => n + stateOf(id).unreadCount, 0),
    [stateOf],
  );

  const applyReadState = useCallback((state: ChannelReadState): void => {
    setOverrides((prev) => ({ ...prev, [state.channelId]: state }));
  }, []);

  // Opening (or reopening) a conversation: forget any hold and pin the divider
  // to the marker as it is right now — before the auto-read below moves it.
  const stateOfRef = useRef(stateOf);
  stateOfRef.current = stateOf;
  useEffect(() => {
    heldRef.current = null;
    if (!openId || !ready) {
      setDivider(null);
      return;
    }
    const ids = idsOfRef.current(openId);
    if (ids.length !== 1) {
      setDivider(null);
      return;
    }
    const st = stateOfRef.current(ids[0]);
    setDivider(st.unreadCount > 0 ? { channelId: ids[0], seq: st.lastReadSeq } : null);
  }, [openId, ready]);

  // Auto-read: while a conversation is on screen (and not held), anything
  // unread in it is marked read — on open and as new messages arrive.
  const openUnread = openId ? unreadCountOf(openId) : 0;
  useEffect(() => {
    if (!openId || !ready || openUnread === 0) return;
    if (heldRef.current === openId || inflightRef.current) return;
    const markRead = client.markChannelRead?.bind(client);
    if (!markRead) return;
    inflightRef.current = true;
    const ids = idsOfRef.current(openId).filter((id) => stateOfRef.current(id).unreadCount > 0);
    void Promise.allSettled(ids.map((id) => markRead(id)))
      .then((results) => {
        for (const r of results) if (r.status === 'fulfilled') applyReadState(r.value);
        notifyChatUnreadChanged();
        inflightRef.current = false;
        // Only re-check after a success: retrying a failing call in a tight loop helps no one.
        if (results.some((r) => r.status === 'fulfilled')) setSettled((n) => n + 1);
      });
  }, [client, openId, ready, openUnread, applyReadState, settled]);

  const markUnread = useCallback(
    async (channelId: string, seq: number): Promise<void> => {
      if (!client.markChannelUnread) return;
      // Hold first: the response (and the frame the server emits) raise the
      // count, and the auto-read above must not undo it.
      heldRef.current = openId;
      try {
        const state = await client.markChannelUnread(channelId, seq);
        applyReadState(state);
        if (idsOfRef.current(openId ?? '').length === 1) {
          setDivider({ channelId, seq: state.lastReadSeq });
        }
        notifyChatUnreadChanged();
      } catch {
        // The marker did not move: release the hold so reading resumes.
        heldRef.current = null;
      }
    },
    [client, openId, applyReadState],
  );

  const unreadAfterSeq =
    openId && divider && idsOfRef.current(openId).length === 1 && divider.channelId === openId
      ? divider.seq
      : null;

  return { unreadCountOf, unreadAfterSeq, applyReadState, markUnread };
}

export default useChatReadState;
