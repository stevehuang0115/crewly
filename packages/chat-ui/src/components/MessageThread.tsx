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
}

export function MessageThread({
  channelId,
  agentName,
  className = '',
  emptyState,
  unreadAfterSeq = null,
  unreadDividerLabel = 'New',
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
        className={`flex h-full items-center justify-center text-sm text-slate-500 ${className}`}
        role="status"
      >
        {emptyState ?? 'Select a channel to start chatting.'}
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col overflow-y-auto bg-slate-50 dark:bg-slate-950 ${className}`}
      aria-label="Message thread"
      data-testid="message-thread"
    >
      {hasMore && (
        <div className="sticky top-0 z-10 flex justify-center bg-slate-50/80 py-2 backdrop-blur dark:bg-slate-950/80">
          <button
            type="button"
            onClick={() => void loadMore()}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Load older
          </button>
        </div>
      )}

      <ul role="list" className="flex flex-1 flex-col gap-3 px-4 py-4">
        {renderTimeline({ messages, unreadAfterSeq, unreadDividerLabel })}
        {agentThinking && <AgentThinkingRow agentName={agentName} />}
        {loading && (
          <li className="text-xs text-slate-400" role="status">
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
}): React.ReactNode[] {
  const { messages, unreadAfterSeq, unreadDividerLabel } = args;
  if (unreadAfterSeq === null || unreadAfterSeq === undefined) {
    return messages.map((m) => <MessageRow key={m.id} message={m} />);
  }
  const out: React.ReactNode[] = [];
  let dividerInserted = false;
  // Find whether the matching seq is in the loaded window.
  const hasMatchingSeq = messages.some((m) => m.seq === unreadAfterSeq);
  for (const m of messages) {
    out.push(<MessageRow key={m.id} message={m} />);
    if (!dividerInserted && hasMatchingSeq && m.seq === unreadAfterSeq) {
      out.push(
        <UnreadDividerRow key="unread-divider" label={unreadDividerLabel} />,
      );
      dividerInserted = true;
    }
  }
  // Edge case: the matching seq is not in the loaded window. Surface
  // the divider at the top so the boundary stays legible — this is the
  // case when older messages have been paged off-screen.
  if (!dividerInserted && messages.length > 0) {
    out.unshift(<UnreadDividerRow key="unread-divider" label={unreadDividerLabel} />);
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

function MessageRow({ message }: { message: Message }): JSX.Element {
  const isUser = message.author.role === 'user';
  const alignment = isUser ? 'items-end' : 'items-start';
  const status = message.deliveryStatus;
  const baseBubble = isUser
    ? 'bg-blue-500 text-white'
    : 'bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100';
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
      <div className="mb-0.5 text-xs text-slate-500 dark:text-slate-400">
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
 * Tiny status line below the bubble. Shows time on success, "Sending…" on
 * pending, and a retry hint on failure.
 */
function DeliveryFooter({ message }: { message: Message }): JSX.Element {
  if (message.deliveryStatus === 'pending') {
    return (
      <span className="mt-0.5 text-[10px] italic text-slate-400 dark:text-slate-500">
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
    <time className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
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
      <div className="rounded-2xl bg-white px-3 py-2 text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
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
