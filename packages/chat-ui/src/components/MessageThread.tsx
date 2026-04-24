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
 * @module components/MessageThread
 */

import { useEffect, useRef } from 'react';
import type { Message } from '../types/chat.types';
import { useMessages } from '../hooks/useMessages';
import { renderMinimalMarkdown } from './internal/minimal-markdown';

export interface MessageThreadProps {
  channelId: string | null;
  /** Height of the scroll area — caller decides layout. */
  className?: string;
  /** Optional empty state override. */
  emptyState?: React.ReactNode;
}

export function MessageThread({
  channelId,
  className = '',
  emptyState,
}: MessageThreadProps): JSX.Element {
  const { messages, loading, error, hasMore, loadMore } = useMessages(channelId);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to newest on every mutation — Phase 1 keeps it simple.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, channelId]);

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
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
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

function MessageRow({ message }: { message: Message }): JSX.Element {
  const isUser = message.author.role === 'user';
  const alignment = isUser ? 'items-end' : 'items-start';
  const bubble = isUser
    ? 'bg-blue-500 text-white'
    : 'bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100';

  return (
    <li className={`flex flex-col ${alignment}`} data-author-role={message.author.role}>
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
      <time className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {formatTimestamp(message.createdAt)}
      </time>
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
