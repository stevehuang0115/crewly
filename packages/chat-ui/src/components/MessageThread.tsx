/**
 * MessageThread — scrolling timeline for the active channel.
 *
 * Shared package component: lives once here, imported by OSS frontend
 * and Portal. Renders messages in chronological order, auto-scrolls to
 * the latest on new arrivals, and supports "Load older" pagination.
 *
 * Markdown rendering: Phase 1 uses a minimal, safe-by-default renderer
 * (no raw HTML). This keeps the package's bundle small and avoids
 * shipping a heavy markdown lib until we need one. Consumers that want
 * richer rendering can swap via a future `renderMarkdown` prop (Phase 2).
 *
 * Week-2 additions:
 *  - `pending`/`failed` delivery states get a distinct visual treatment
 *    (faded bubble + status footer text).
 *  - "Agent is thinking…" indicator renders below the latest user
 *    message while we wait for the agent's reply, driven by the
 *    `agentThinking` flag from `useMessages`.
 *
 * Phase B Slack-like additions (additive only — existing callers do not
 * break):
 *  - `unreadAfterSeq` optional prop renders an "Unread" divider in the
 *    timeline after the message whose `seq` matches the value (design
 *    §6.2 thread rule). Designed for the team-chat surfaces where the
 *    BE supplies the last-read marker per channel; legacy single-channel
 *    consumers omit the prop and see no divider.
 *
 * @module components/MessageThread
 */

import { useEffect, useRef } from 'react';
import type { Message } from '../types/chat.types';
import { useMessages } from '../hooks/useMessages';
import { renderMinimalMarkdown } from './internal/minimal-markdown';

export interface MessageThreadProps {
  channelId: string | null;
  /** Display name for the agent — used by the thinking indicator. */
  agentName?: string;
  /** Height of the scroll area — caller decides layout. */
  className?: string;
  /** Optional empty state override. */
  emptyState?: React.ReactNode;
  /**
   * Phase B Slack-like extension (design §6.2 thread rule).
   *
   * When set, renders an "Unread" divider in the timeline AFTER the
   * message whose `seq` equals `unreadAfterSeq`. The divider appears
   * once per render even when the matching message is not currently
   * loaded — in that case it appears at the top of the visible window
   * so the user still sees the boundary. Omit (or set to `null`) on
   * legacy single-channel consumers — additive guarantee.
   */
  unreadAfterSeq?: number | null;
  /** Override label for the unread divider. Defaults to `New`. */
  unreadDividerLabel?: string;
  /**
   * Visual layout (additive — existing callers keep the chat-bubble look).
   *
   * - `'bubble'` (default): iMessage-style bubbles, user-right / agent-left.
   * - `'flat'`: Slack-style flat list — left-aligned avatar + bold name +
   *   inline timestamp, plain text, consecutive same-author messages
   *   grouped under one header. Used by the consolidated team-chat surface.
   */
  layout?: 'bubble' | 'flat';
}

export function MessageThread({
  channelId,
  agentName,
  className = '',
  emptyState,
  unreadAfterSeq = null,
  unreadDividerLabel = 'New',
  layout = 'bubble',
}: MessageThreadProps): JSX.Element {
  const { messages, loading, error, hasMore, agentThinking, loadMore } = useMessages(channelId);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to newest on every mutation — Phase 1 keeps it simple.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, channelId, agentThinking]);

  if (!channelId) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm text-text-secondary-dark ${className}`}
        role="status"
      >
        {emptyState ?? 'Select a channel to start chatting.'}
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col overflow-y-auto bg-background-dark ${className}`}
      aria-label="Message thread"
      data-testid="message-thread"
    >
      {hasMore && (
        <div className="sticky top-0 z-10 flex justify-center bg-background-dark/80 py-2 backdrop-blur">
          <button
            type="button"
            onClick={() => void loadMore()}
            className="rounded-full border border-border-dark px-3 py-1 text-xs text-text-secondary-dark hover:bg-surface-dark"
          >
            Load older
          </button>
        </div>
      )}

      <ul
        role="list"
        className={`flex flex-1 flex-col ${
          layout === 'flat' ? 'gap-0.5 px-2 py-3' : 'gap-3 px-4 py-4'
        }`}
      >
        {renderTimeline({ messages, unreadAfterSeq, unreadDividerLabel, layout })}
        {agentThinking && <AgentThinkingRow agentName={agentName} />}
        {loading && (
          <li className="text-xs text-text-secondary-dark" role="status">
            Loading messages…
          </li>
        )}
        {error && (
          <li className="text-xs text-red-500" role="alert">
            Failed to load messages: {error.message}
          </li>
        )}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * Render the message list with an optional unread divider inserted
 * after the matching seq. Pure helper so it stays out of the component
 * body and is straightforward to unit-test.
 */
function renderTimeline(args: {
  messages: Message[];
  unreadAfterSeq: number | null;
  unreadDividerLabel: string;
  layout: 'bubble' | 'flat';
}): React.ReactNode[] {
  const { messages, unreadAfterSeq, unreadDividerLabel, layout } = args;
  const out: React.ReactNode[] = [];

  // In flat (Slack) mode, consecutive messages from the same author group
  // under one avatar/name header. `groupStart` is always true in bubble
  // mode (each message keeps its own header), preserving prior behavior.
  let prevAuthor: string | null = null;
  const hasMatchingSeq =
    unreadAfterSeq != null && messages.some((m) => m.seq === unreadAfterSeq);

  // Edge case: matching seq paged off-screen — surface the divider at the top.
  if (unreadAfterSeq != null && !hasMatchingSeq && messages.length > 0) {
    out.push(<UnreadDividerRow key="unread-divider" label={unreadDividerLabel} />);
  }

  let dividerInserted = false;
  for (const m of messages) {
    const groupStart = layout !== 'flat' || prevAuthor !== m.author.id;
    out.push(<MessageRow key={m.id} message={m} layout={layout} groupStart={groupStart} />);
    prevAuthor = m.author.id;
    if (!dividerInserted && hasMatchingSeq && m.seq === unreadAfterSeq) {
      out.push(<UnreadDividerRow key="unread-divider" label={unreadDividerLabel} />);
      dividerInserted = true;
      // A divider visually breaks the group — next message starts fresh.
      prevAuthor = null;
    }
  }
  return out;
}

/**
 * Slack-style unread separator. Pure visual element; no interactivity.
 */
function UnreadDividerRow({ label }: { label: string }): JSX.Element {
  return (
    <li
      className="flex items-center gap-2 py-1"
      data-testid="unread-divider"
      role="separator"
      aria-label={`${label} messages below`}
    >
      <span className="h-px flex-1 bg-rose-400/70" aria-hidden="true" />
      <span className="rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        {label}
      </span>
      <span className="h-px flex-1 bg-rose-400/70" aria-hidden="true" />
    </li>
  );
}

function MessageRow({
  message,
  layout = 'bubble',
  groupStart = true,
}: {
  message: Message;
  layout?: 'bubble' | 'flat';
  groupStart?: boolean;
}): JSX.Element {
  if (layout === 'flat') {
    return <FlatMessageRow message={message} groupStart={groupStart} />;
  }
  const isUser = message.author.role === 'user';
  const alignment = isUser ? 'items-end' : 'items-start';
  const status = message.deliveryStatus;
  const baseBubble = isUser
    ? 'bg-primary text-white'
    : 'bg-surface-dark text-text-primary-dark';
  const bubble =
    status === 'pending'
      ? `${baseBubble} opacity-60`
      : status === 'failed'
        ? `${baseBubble} ring-2 ring-red-400`
        : baseBubble;

  return (
    <li
      className={`flex flex-col ${alignment}`}
      data-author-role={message.author.role}
      data-delivery-status={status ?? 'sent'}
    >
      <div className="mb-0.5 text-xs text-text-secondary-dark">
        {message.author.name ?? message.author.id}
      </div>
      <div className={`max-w-prose rounded-2xl px-3 py-2 text-sm shadow-sm ${bubble}`}>
        {renderMinimalMarkdown(message.content)}
        {message.attachments?.map((a) =>
          a.kind === 'image' ? (
            <img
              key={a.id}
              src={a.url}
              alt={a.filename ?? 'attachment'}
              className="mt-2 max-h-64 max-w-full rounded-lg"
            />
          ) : null,
        )}
      </div>
      <DeliveryFooter message={message} />
    </li>
  );
}

/**
 * Slack-style flat message row. Left-aligned for every author: an avatar
 * gutter, then a bold name + inline timestamp header (on the first message
 * of an author group) followed by plain text. Follow-on messages in the
 * same group omit the avatar/name and reveal their timestamp on hover.
 */
function FlatMessageRow({
  message,
  groupStart,
}: {
  message: Message;
  groupStart: boolean;
}): JSX.Element {
  const status = message.deliveryStatus;
  const name = message.author.name ?? message.author.id;
  const faded = status === 'pending' ? 'opacity-60' : '';

  return (
    <li
      className={`group flex gap-2 rounded px-2 hover:bg-surface-dark ${
        groupStart ? 'mt-3 pt-0.5' : ''
      }`}
      data-author-role={message.author.role}
      data-delivery-status={status ?? 'sent'}
    >
      <div className="w-9 shrink-0 select-none">
        {groupStart ? (
          <Avatar name={name} />
        ) : (
          <time className="block w-9 pt-0.5 text-right text-[10px] leading-5 text-transparent group-hover:text-text-secondary-dark">
            {formatTimestamp(message.createdAt)}
          </time>
        )}
      </div>
      <div className="min-w-0 flex-1 pb-0.5">
        {groupStart && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-text-primary-dark">
              {name}
            </span>
            <time className="text-[11px] text-text-secondary-dark">
              {formatTimestamp(message.createdAt)}
            </time>
          </div>
        )}
        <div className={`text-sm leading-relaxed text-text-primary-dark ${faded}`}>
          {renderMinimalMarkdown(message.content)}
          {message.attachments?.map((a) =>
            a.kind === 'image' ? (
              <img
                key={a.id}
                src={a.url}
                alt={a.filename ?? 'attachment'}
                className="mt-2 max-h-64 max-w-full rounded-lg"
              />
            ) : null,
          )}
        </div>
        {status === 'pending' && (
          <span className="text-[10px] italic text-text-secondary-dark">
            Sending…
          </span>
        )}
        {status === 'failed' && (
          <span className="text-[10px] font-medium text-red-500" role="alert">
            Send failed — tap to retry
          </span>
        )}
      </div>
    </li>
  );
}

/** Tailwind background classes for avatar tiles — picked by hashing the name. */
const AVATAR_COLORS = [
  'bg-rose-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-sky-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-fuchsia-500',
] as const;

/**
 * Derive 1–2 uppercase initials from a display name. Splits on spaces and
 * common separators so `crewly-orc` → `CO` and `Sam` → `SA`.
 */
export function avatarInitials(name: string): string {
  const parts = name.split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Deterministically map a name to one of the avatar colors. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Slack-style rounded-square avatar tile with initials. */
function Avatar({ name }: { name: string }): JSX.Element {
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-md text-xs font-semibold text-white ${avatarColor(name)}`}
      aria-hidden="true"
    >
      {avatarInitials(name)}
    </span>
  );
}

/**
 * Tiny status line below the bubble. Shows time on success, "Sending…" on
 * pending, and a retry hint on failure.
 */
function DeliveryFooter({ message }: { message: Message }): JSX.Element {
  if (message.deliveryStatus === 'pending') {
    return (
      <span className="mt-0.5 text-[10px] italic text-text-secondary-dark">
        Sending…
      </span>
    );
  }
  if (message.deliveryStatus === 'failed') {
    return (
      <span
        className="mt-0.5 text-[10px] font-medium text-red-500"
        role="alert"
      >
        Send failed — tap to retry
      </span>
    );
  }
  return (
    <time className="mt-0.5 text-[10px] text-text-secondary-dark">
      {formatTimestamp(message.createdAt)}
    </time>
  );
}

/** "Agent is thinking…" indicator that renders below the user's send. */
function AgentThinkingRow({ agentName }: { agentName?: string }): JSX.Element {
  const label = agentName ? `${agentName} is thinking` : 'Agent is thinking';
  return (
    <li
      className="flex flex-col items-start"
      role="status"
      aria-live="polite"
      data-testid="agent-thinking"
    >
      <div className="rounded-2xl bg-surface-dark px-3 py-2 text-sm text-text-secondary-dark shadow-sm">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark" />
          </span>
          <span>{label}…</span>
        </span>
      </div>
    </li>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
