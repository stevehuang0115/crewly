/**
 * ChatSearchResults — cross-conversation message search of the OSS chat
 * (#1400, item 6: a UI over `GET /api/chat/search`).
 *
 * Takes the conversation column: a query box, the hit count and one row per
 * hit (conversation, sender, time, snippet with the words marked). Every
 * word must appear; the server returns the newest hits first, capped. Opening
 * a hit hands the hit and the query back to the page, which opens that
 * conversation filtered by the same words.
 *
 * @module components/Chat-team/ChatSearchResults
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Search, X } from 'lucide-react';
import type { ChatApiClient, ChatSearchHit } from '@crewly/chat-ui';
import { IconButton } from '@crewly/ui/Button';

/** Hits asked for per search (the server caps at the same number). */
export const SEARCH_LIMIT = 30;

/** Props of {@link ChatSearchResults}. */
export interface ChatSearchResultsProps {
  /** Chat client; `searchMessages` must be present (the page checks before rendering this) */
  client: Pick<ChatApiClient, 'searchMessages'>;
  /** Words to search for on open (and whenever they change) */
  initialQuery: string;
  /** Display name of a hit's conversation (the list title); the stored channel name otherwise */
  conversationNameOf?: (channelId: string) => string | undefined;
  /** Open the hit's conversation */
  onOpen(hit: ChatSearchHit, query: string): void;
  /** Leave the search (back to the open conversation) */
  onClose(): void;
  /** Phones: back to the conversation list */
  onBack?: () => void;
  className?: string;
}

/** Outcome of one search request. */
type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; hits: ChatSearchHit[] }
  | { status: 'error'; message: string };

/**
 * Split a snippet into plain and matched segments so the searched words can be
 * marked. Matching is case-insensitive; words are matched as substrings, like
 * the server does.
 *
 * @param text - Snippet
 * @param query - Whitespace-separated words
 * @returns Segments in order; `match` marks the ones to highlight
 */
export function highlightTerms(text: string, query: string): Array<{ text: string; match: boolean }> {
  const terms = Array.from(new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)));
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const segments: Array<{ text: string; match: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    let best: { at: number; len: number } | null = null;
    for (const term of terms) {
      const at = lower.indexOf(term, i);
      if (at >= 0 && (!best || at < best.at || (at === best.at && term.length > best.len))) best = { at, len: term.length };
    }
    if (!best) break;
    if (best.at > i) segments.push({ text: text.slice(i, best.at), match: false });
    segments.push({ text: text.slice(best.at, best.at + best.len), match: true });
    i = best.at + best.len;
  }
  if (i < text.length) segments.push({ text: text.slice(i), match: false });
  return segments;
}

/**
 * Label of a hit's conversation: `#name` for channels and group chats, the
 * name for DMs.
 *
 * @param hit - Search hit
 * @param nameOf - Display-name lookup by channel id
 * @returns Label
 */
export function hitConversationLabel(hit: ChatSearchHit, nameOf?: (channelId: string) => string | undefined): string {
  const name = nameOf?.(hit.channelId) ?? hit.channel;
  const bare = name.replace(/^#+\s*/, '');
  return hit.channelType && hit.channelType !== 'dm' ? `#${bare}` : bare;
}

/**
 * When a hit was written, short: time for today, otherwise month and day with
 * the time.
 *
 * @param iso - Message time
 * @param now - Clock (tests)
 * @returns e.g. "09:14" or "Oct 9, 09:14"
 */
export function formatHitTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The search column.
 *
 * @param props - {@link ChatSearchResultsProps}
 * @returns Section
 */
export function ChatSearchResults({
  client,
  initialQuery,
  conversationNameOf,
  onOpen,
  onClose,
  onBack,
  className = '',
}: ChatSearchResultsProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery.trim());
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  // A new query from the Find box re-runs the search.
  useEffect(() => {
    setQuery(initialQuery);
    setSubmitted(initialQuery.trim());
  }, [initialQuery]);

  useEffect(() => {
    if (!submitted) {
      setState({ status: 'idle' });
      return;
    }
    const search = client.searchMessages;
    if (!search) {
      setState({ status: 'error', message: 'This chat server cannot search messages; update Crewly.' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    search
      .call(client, submitted, { limit: SEARCH_LIMIT })
      .then((hits) => {
        if (!cancelled) setState({ status: 'done', hits });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : 'Search failed.' });
      });
    return () => {
      cancelled = true;
    };
  }, [client, submitted]);

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitted(query.trim());
    },
    [query],
  );

  const statusLine = (): string | null => {
    switch (state.status) {
      case 'idle':
        return 'Type words to search every conversation.';
      case 'loading':
        return 'Searching…';
      case 'error':
        return state.message;
      case 'done':
        if (state.hits.length === 0) return 'No messages match.';
        return `${state.hits.length} message${state.hits.length === 1 ? '' : 's'} match${
          state.hits.length >= SEARCH_LIMIT ? ` (newest ${SEARCH_LIMIT}; add words to narrow)` : ''
        }.`;
      default:
        return null;
    }
  };

  return (
    <section
      className={`${className || 'flex'} min-w-0 flex-1 flex-col bg-bg`}
      data-testid="chat-search-results"
      aria-label="Message search"
    >
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-border-soft px-2 md:gap-4 md:px-8">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            title="Conversations"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--crewly-radius-sm)] text-text-2 hover:text-text md:hidden"
            data-testid="chat-search-back"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2" role="search">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Search all conversations"
            aria-label="Search all conversations"
            data-testid="chat-search-input"
            className="h-9 min-w-0 flex-1 rounded-[var(--crewly-radius-sm)] border border-border bg-surface px-3 text-sm text-text outline-none placeholder:text-text-3 focus:border-primary"
          />
          <IconButton type="submit" icon={Search} aria-label="Search" title="Search" data-testid="chat-search-submit" />
        </form>
        <IconButton type="button" icon={X} aria-label="Close search" title="Close search" onClick={onClose} data-testid="chat-search-close" />
      </header>

      <p className="mx-auto w-full max-w-[760px] px-4 pt-3 text-[13px] text-text-2 md:px-8" role="status" data-testid="chat-search-status">
        {statusLine()}
      </p>

      {state.status === 'done' && state.hits.length > 0 && (
        <ul role="list" className="chat-scrollbar mx-auto m-0 w-full max-w-[760px] min-h-0 flex-1 list-none overflow-y-auto px-4 pb-6 pt-2 md:px-8" data-testid="chat-search-hits">
          {state.hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => onOpen(hit, submitted)}
                className="flex w-full flex-col items-start gap-0.5 rounded-[var(--crewly-radius-sm)] px-3 py-2 text-left transition-colors hover:bg-surface-2"
                data-testid={`chat-search-hit-${hit.id}`}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2 text-[13px]">
                  <span className="truncate font-semibold text-text">{hitConversationLabel(hit, conversationNameOf)}</span>
                  <span className="truncate text-text-2">{hit.sender}</span>
                  <span className="ml-auto shrink-0 text-xs text-text-3">{formatHitTime(hit.time)}</span>
                </span>
                <span className="line-clamp-2 w-full text-sm text-text-2">
                  {highlightTerms(hit.text, submitted).map((seg, i) =>
                    seg.match ? (
                      <mark key={i} className="rounded-sm bg-primary/20 px-0.5 text-text">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ChatSearchResults;
