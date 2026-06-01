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
 *    §6.2 thread rule).
 *
 * The `flat` layout follows the approved Material-3 prototype: left-aligned
 * rounded-square avatars, an inline bold-name + timestamp header, and a
 * frosted `glass-panel` message body (agents get a secondary accent rule).
 *
 * @module components/MessageThread
 */

import { useEffect, useRef } from 'react';
import { Bot, MessageSquare, SmilePlus, Link as LinkIcon, MoreHorizontal } from 'lucide-react';
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
  /**
   * Slack-style threading (additive — omit on legacy callers).
   *
   * When provided (flat layout), each message row gets a hover
   * "Reply in thread" action and root messages with `replyCount > 0`
   * render a clickable "💬 N replies · <relative time>" summary chip.
   * Both invoke this callback with the message to open as the thread root.
   */
  onReplyInThread?(message: Message): void;
  /**
   * Slack-style threading — when true, messages that are thread replies
   * (have a `threadId`) are filtered out of this timeline. The main
   * channel passes `true`; the thread panel passes `false` so it shows
   * every message for that thread. Defaults to `false` (no filtering),
   * preserving legacy behavior.
   */
  hideReplies?: boolean;
  /**
   * Controlled-feed mode (additive — omit for the default self-fetching
   * behavior, keeping legacy + Portal callers unchanged).
   *
   * When `messages` is provided, MessageThread renders THESE messages and
   * skips its internal `useMessages(channelId)` fetch/subscription entirely.
   * The host owns the data — used for the merged multi-channel feed (e.g. the
   * Orchestrator timeline with its Slack threads merged in). `agentThinking`,
   * `loading`, `hasMore`, and `onLoadMore` are then read from props too
   * (each optional, defaulting to off / no-op).
   */
  messages?: Message[];
  /** Controlled "agent is thinking" flag (only read when `messages` is set). */
  agentThinking?: boolean;
  /** Controlled loading flag (only read when `messages` is set). */
  loading?: boolean;
  /** Controlled "load older" availability (only read when `messages` is set). */
  hasMore?: boolean;
  /** Controlled "load older" handler (only read when `messages` is set). */
  onLoadMore?: () => void;
}

export function MessageThread({
  channelId,
  agentName,
  className = '',
  emptyState,
  unreadAfterSeq = null,
  unreadDividerLabel = 'New',
  layout = 'bubble',
  onReplyInThread,
  hideReplies = false,
  messages: controlledMessages,
  agentThinking: controlledAgentThinking,
  loading: controlledLoading,
  hasMore: controlledHasMore,
  onLoadMore: controlledOnLoadMore,
}: MessageThreadProps): JSX.Element {
  // Controlled mode: the host supplies `messages` (e.g. a merged multi-channel
  // feed). We then disable the internal fetch by passing a null channelId so
  // the hook no-ops, and read every timeline value from props instead.
  const controlled = controlledMessages !== undefined;
  const feed = useMessages(controlled ? null : channelId);
  const allMessages = controlled ? controlledMessages! : feed.messages;
  const loading = controlled ? controlledLoading ?? false : feed.loading;
  const error = controlled ? null : feed.error;
  const hasMore = controlled ? controlledHasMore ?? false : feed.hasMore;
  const agentThinking = controlled ? controlledAgentThinking ?? false : feed.agentThinking;
  const loadMore = controlled ? controlledOnLoadMore ?? (() => {}) : feed.loadMore;
  // Slack-style: the main timeline hides thread replies (they live in the
  // thread panel). `hideReplies=false` (default) keeps the full timeline,
  // preserving legacy single-channel behavior.
  const messages = hideReplies ? allMessages.filter((m) => !m.threadId) : allMessages;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the newest message — but key the effect on the LAST
  // message's id, not the list length. Otherwise "Load older" (which prepends
  // older messages, growing the length) would yank the view back to the
  // bottom. Prepending leaves the last id unchanged → no scroll; a genuinely
  // new message at the bottom changes it → scroll. Channel switch + the
  // thinking indicator still scroll to the latest.
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lastMessageId, channelId, agentThinking]);

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

  const flat = layout === 'flat';

  return (
    <div
      className={`chat-scrollbar flex h-full flex-col overflow-y-auto ${flat ? 'bg-background-dark' : 'bg-background-dark'} ${className}`}
      aria-label="Message thread"
      data-testid="message-thread"
    >
      {hasMore && (
        <div
          className={`sticky top-0 z-10 flex justify-center py-2 backdrop-blur ${flat ? 'bg-background-dark/80' : 'bg-background-dark/80'}`}
        >
          <button
            type="button"
            onClick={() => void loadMore()}
            className={
              flat
                ? 'rounded-full border border-border-dark px-3 py-1 text-xs text-text-secondary-dark hover:bg-white/5'
                : 'rounded-full border border-border-dark px-3 py-1 text-xs text-text-secondary-dark hover:bg-surface-dark'
            }
          >
            Load older
          </button>
        </div>
      )}

      <ul
        role="list"
        className={`flex flex-1 flex-col ${flat ? 'gap-0 px-4 py-4' : 'gap-3 px-4 py-4'}`}
      >
        {renderTimeline({ messages, unreadAfterSeq, unreadDividerLabel, layout, onReplyInThread })}
        {agentThinking && <AgentThinkingRow agentName={agentName} layout={layout} />}
        {loading && (
          <li
            className={`text-xs ${flat ? 'text-text-secondary-dark' : 'text-text-secondary-dark'}`}
            role="status"
          >
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
  onReplyInThread?(message: Message): void;
}): React.ReactNode[] {
  const { messages, unreadAfterSeq, unreadDividerLabel, layout, onReplyInThread } = args;
  const out: React.ReactNode[] = [];

  // In flat (Slack) mode, consecutive messages from the same author group
  // under one avatar/name header. `groupStart` is always true in bubble
  // mode (each message keeps its own header), preserving prior behavior.
  let prevAuthor: string | null = null;
  let prevDayIso: string | null = null;
  const hasMatchingSeq =
    unreadAfterSeq != null && messages.some((m) => m.seq === unreadAfterSeq);

  // Edge case: matching seq paged off-screen — surface the divider at the top.
  if (unreadAfterSeq != null && !hasMatchingSeq && messages.length > 0) {
    out.push(<UnreadDividerRow key="unread-divider" label={unreadDividerLabel} layout={layout} />);
  }

  let dividerInserted = false;
  for (const m of messages) {
    // Slack-style day separators — a divider also breaks the author group so
    // the first message of a new day always gets a fresh header.
    if (layout === 'flat' && isNewDay(prevDayIso, m.createdAt)) {
      out.push(<DayDividerRow key={`day-${m.id}`} label={formatDayLabel(m.createdAt)} />);
      prevAuthor = null;
    }
    prevDayIso = m.createdAt;
    const groupStart = layout !== 'flat' || prevAuthor !== m.author.id;
    out.push(
      <MessageRow
        key={m.id}
        message={m}
        layout={layout}
        groupStart={groupStart}
        onReplyInThread={onReplyInThread}
      />,
    );
    prevAuthor = m.author.id;
    if (!dividerInserted && hasMatchingSeq && m.seq === unreadAfterSeq) {
      out.push(<UnreadDividerRow key="unread-divider" label={unreadDividerLabel} layout={layout} />);
      dividerInserted = true;
      // A divider visually breaks the group — next message starts fresh.
      prevAuthor = null;
    }
  }
  return out;
}

/**
 * Slack-style unread / day separator. Pure visual element; no interactivity.
 * In flat (prototype) mode it reads as a subtle centered label between hairlines.
 */
function UnreadDividerRow({
  label,
  layout,
}: {
  label: string;
  layout: 'bubble' | 'flat';
}): JSX.Element {
  if (layout === 'flat') {
    return (
      <li
        className="flex items-center gap-4 py-1"
        data-testid="unread-divider"
        role="separator"
        aria-label={`${label} messages below`}
      >
        <span className="h-[1px] flex-1 bg-border-dark/20" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary-dark">
          {label}
        </span>
        <span className="h-[1px] flex-1 bg-border-dark/20" aria-hidden="true" />
      </li>
    );
  }
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
  onReplyInThread,
}: {
  message: Message;
  layout?: 'bubble' | 'flat';
  groupStart?: boolean;
  onReplyInThread?(message: Message): void;
}): JSX.Element {
  if (layout === 'flat') {
    return (
      <FlatMessageRow
        message={message}
        groupStart={groupStart}
        onReplyInThread={onReplyInThread}
      />
    );
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
 * Slack-style flat message row (prototype). A rounded-square avatar gutter,
 * then a bold name + inline timestamp header (on the first message of an
 * author group) followed by the message body in a frosted glass panel.
 * Agent messages carry a secondary accent rule + an `AGENT` tag.
 */
function FlatMessageRow({
  message,
  groupStart,
  onReplyInThread,
}: {
  message: Message;
  groupStart: boolean;
  onReplyInThread?(message: Message): void;
}): JSX.Element {
  const status = message.deliveryStatus;
  const name = message.author.name ?? message.author.id;
  const isAgent = message.author.role !== 'user';
  // Inactive/sleep deliveries read dimmed so they recede from view.
  const inactive = status === 'pending';
  const faded = inactive ? 'opacity-50' : '';
  // Slack threading: the hover toolbar + the "N replies" summary chip only
  // render when the host opts in via `onReplyInThread`. The chip is for roots
  // with replies; the toolbar is for any non-pending/non-failed message.
  const threadingOn = typeof onReplyInThread === 'function';
  const replyCount = message.replyCount ?? 0;
  const showSummary = threadingOn && replyCount > 0;
  const showReplyAction = threadingOn && status !== 'pending' && status !== 'failed';
  // Strip orchestrator plumbing (e.g. "[Thread context file: …]") at display.
  const displayContent = stripInternalHints(message.content);

  return (
    <li
      className={`group relative flex gap-3 rounded-md py-0.5 pl-2 pr-2 transition-colors hover:bg-white/[0.03] ${groupStart ? 'mt-3' : 'mt-px'}`}
      data-author-role={message.author.role}
      data-delivery-status={status ?? 'sent'}
    >
      {/* Subtle agent accent rail on group-start rows — no box. */}
      {isAgent && groupStart && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 h-[calc(100%-0.5rem)] w-[2px] rounded-full bg-primary/40"
        />
      )}

      <div className="w-9 shrink-0 select-none">
        {groupStart ? (
          <Avatar name={name} isAgent={isAgent} />
        ) : (
          <time className="block w-9 pt-[3px] text-right text-[10px] leading-5 tabular-nums text-transparent group-hover:text-text-secondary-dark">
            {formatTimestamp(message.createdAt)}
          </time>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {groupStart && (
          <div className="flex items-baseline gap-2">
            <span
              className={`text-[13px] font-bold leading-5 ${isAgent ? 'text-primary' : 'text-text-primary-dark'}`}
            >
              {name}
            </span>
            {isAgent && (
              <span className="rounded border border-border-dark bg-white/5 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-text-secondary-dark">
                Agent
              </span>
            )}
            <time className="text-[10px] tabular-nums text-text-secondary-dark">
              {formatTimestamp(message.createdAt)}
            </time>
          </div>
        )}

        <div
          className={`mt-0.5 max-w-[760px] text-[13px] leading-[1.45] text-text-primary-dark [&_a]:text-primary [&_a]:underline ${faded}`}
        >
          {renderMinimalMarkdown(displayContent)}
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
          <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] italic text-text-secondary-dark">
            Sending…
          </span>
        )}
        {status === 'failed' && (
          <span
            className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-amber-300"
            role="alert"
          >
            Send failed — tap to retry
          </span>
        )}

        {showSummary && (
          <ThreadSummaryChip message={message} onOpen={() => onReplyInThread?.(message)} />
        )}
      </div>

      {showReplyAction && <RowToolbar message={message} onReplyInThread={onReplyInThread!} />}
    </li>
  );
}

/** A single 28×28 icon button inside the hover toolbar. */
function ToolbarButton({
  label,
  children,
  onClick,
  ...rest
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
} & Record<string, unknown>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary-dark transition-colors hover:bg-white/5 hover:text-text-primary-dark"
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Slack-style floating action toolbar pinned to the top-right of a hovered
 * message row. Only "Reply in thread" is wired; reaction / copy-link / more
 * are styled-but-inert placeholders for a future pass.
 */
function RowToolbar({
  message,
  onReplyInThread,
}: {
  message: Message;
  onReplyInThread(message: Message): void;
}): JSX.Element {
  return (
    <div
      data-testid={`msg-toolbar-${message.id}`}
      className="absolute -top-3 right-2 z-10 hidden items-center gap-0.5 rounded-lg border border-border-dark bg-surface-dark p-0.5 shadow-md group-hover:flex"
    >
      <ToolbarButton label="Add reaction">
        <SmilePlus size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Reply in thread"
        data-testid={`msg-reply-action-${message.id}`}
        onClick={() => onReplyInThread(message)}
      >
        <MessageSquare size={15} />
      </ToolbarButton>
      <ToolbarButton label="Copy link">
        <LinkIcon size={15} />
      </ToolbarButton>
      <ToolbarButton label="More actions">
        <MoreHorizontal size={15} />
      </ToolbarButton>
    </div>
  );
}

/**
 * Slack-style thread summary: stacked participant avatars, reply count, and a
 * muted "Last reply <relative>". Clickable — opens the thread panel. The reply
 * roster isn't on the root DTO, so the avatar stack is seeded from the root
 * author (swap for `threadParticipants` if a future DTO adds it).
 */
function ThreadSummaryChip({
  message,
  onOpen,
}: {
  message: Message;
  onOpen: () => void;
}): JSX.Element {
  const replyCount = message.replyCount ?? 0;
  const rootName = message.author.name ?? message.author.id;
  const seeds = [rootName].slice(0, 3);

  return (
    <button
      type="button"
      data-testid={`msg-thread-summary-${message.id}`}
      onClick={onOpen}
      className="group/chip mt-1 flex w-fit items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/5"
    >
      <span className="flex -space-x-1.5">
        {seeds.map((seed) => (
          <span
            key={seed}
            className={`flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-bold text-white ring-2 ring-background-dark ${avatarColor(seed)}`}
            aria-hidden="true"
          >
            {avatarInitials(seed)}
          </span>
        ))}
      </span>
      <span className="text-[12px] font-semibold text-primary group-hover/chip:underline">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
      </span>
      {message.lastReplyAt && (
        <span className="text-[11px] font-normal text-text-secondary-dark">
          Last reply {relativeTime(message.lastReplyAt)}
        </span>
      )}
    </button>
  );
}

/**
 * Centered day separator inserted between messages that cross a calendar-day
 * boundary. Pure visual; the pill masks the hairline behind it.
 */
function DayDividerRow({ label }: { label: string }): JSX.Element {
  return (
    <li
      className="relative my-3 flex items-center justify-center"
      role="separator"
      aria-label={label}
      data-testid="day-divider"
    >
      <span
        className="absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-border-dark/50"
        aria-hidden="true"
      />
      <span className="relative rounded-full border border-border-dark bg-background-dark px-3 py-0.5 text-[11px] font-semibold text-text-secondary-dark">
        {label}
      </span>
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

/**
 * Prototype avatar tile — a rounded-square. Users use the tertiary
 * container tint; agents use the secondary container tint with a Bot glyph.
 */
function Avatar({ name, isAgent }: { name: string; isAgent: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-lg text-[12px] font-bold ${
        isAgent
          ? 'bg-primary/20 text-primary'
          : 'bg-indigo-500/20 text-indigo-300'
      }`}
      aria-hidden="true"
    >
      {isAgent ? <Bot size={16} /> : avatarInitials(name)}
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
function AgentThinkingRow({
  agentName,
  layout = 'bubble',
}: {
  agentName?: string;
  layout?: 'bubble' | 'flat';
}): JSX.Element {
  const label = agentName ? `${agentName} is thinking` : 'Agent is thinking';
  const flat = layout === 'flat';
  if (flat) {
    // Align to the same avatar gutter as message rows so the column reads clean.
    return (
      <li
        className="mt-3 flex items-center gap-3 px-2"
        role="status"
        aria-live="polite"
        data-testid="agent-thinking"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/20 text-primary">
          <Bot size={16} />
        </span>
        <span className="inline-flex items-center gap-2 text-[13px] text-text-secondary-dark">
          <span aria-hidden="true" className="flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-secondary-dark" />
          </span>
          <span>{label}…</span>
        </span>
      </li>
    );
  }
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

/**
 * Compact, locale-agnostic relative time for the thread-summary chip
 * (e.g. "now", "5m", "3h", "2d", then an absolute short date past a week).
 * Exported so the threading UI can be unit-tested without rendering.
 *
 * @param iso - ISO 8601 timestamp of the last reply
 * @returns A short relative-time label; empty string on parse failure
 */
export function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/**
 * Human day label for a timeline divider: "Today", "Yesterday", or a
 * weekday+date like "Fri, May 29". Compares calendar days in local time.
 *
 * @param iso - ISO 8601 timestamp of the message starting the new day
 * @returns The day label; falls back to the raw string on parse failure
 */
export function formatDayLabel(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const today = startOf(new Date());
    const that = startOf(d);
    const dayMs = 86_400_000;
    if (that === today) return 'Today';
    if (that === today - dayMs) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * True when two ISO timestamps fall on different local calendar days. Used to
 * decide whether to insert a day divider before a message. The first message
 * (no previous) always opens a day.
 *
 * @param prevIso - Previous message's timestamp, or null for the first row
 * @param currIso - Current message's timestamp
 * @returns Whether `currIso` starts a new calendar day
 */
export function isNewDay(prevIso: string | null, currIso: string): boolean {
  if (!prevIso) return true;
  const a = new Date(prevIso);
  const b = new Date(currIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
}

/**
 * Strip orchestrator plumbing that leaks into message content before display.
 * Currently removes a "[Thread context file: <path>]" hint the orchestrator
 * appends for its own routing — never meant for the user. Safe on clean
 * content (returns it trimmed, untouched otherwise).
 *
 * @param content - Raw message content from the DTO
 * @returns Content with internal hints removed and trailing whitespace trimmed
 */
export function stripInternalHints(content: string): string {
  return content
    .replace(/\s*\[Thread context file:[^\]]*\]/gi, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
