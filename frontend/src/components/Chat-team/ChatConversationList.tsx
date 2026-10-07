/**
 * ChatConversationList — the simplified conversation list of the OSS chat
 * (specs/2026-10-02-ui-redesign.md, Chat).
 *
 * Sections, top to bottom: Pinned · Direct messages · Channels · Group
 * chats. Each row is a name plus an unread dot; role, Lead and presence
 * are in the row's tooltip and the conversation header. Long sections show
 * only what is active — DMs: the orchestrator, unread, the open one, then
 * the first few; channels and group chats: unread, the open one and those
 * with messages in the last week (the first three when none is) — and the
 * rest behind "N more". The Find
 * button searches every conversation, folded or not.
 *
 * Built on the chat-ui row/group types but rendered here, so the shared
 * `ConversationListPanel` (also used by the Cloud portal) is unchanged.
 *
 * @module components/Chat-team/ChatConversationList
 */

import { useMemo, useState } from 'react';
import { Hash, Pin, PinOff, Plus, Search } from 'lucide-react';
import type { ConversationGroup, ConversationRow } from '@crewly/chat-ui';

/** DMs visible before "N more" (unread and the open one are always shown). */
export const DM_VISIBLE = 6;

/** Channels / group chats visible before "N more". */
export const CHANNEL_VISIBLE = 5;

/** Rows a section shows when none of them is active. */
export const QUIET_SECTION_VISIBLE = 3;

/** A channel counts as active when it had a message this recently (ms). */
export const ACTIVE_CHANNEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Section order of the simplified list. */
const SECTION_ORDER = ['pinned', 'dms', 'crewly-channels', 'channels', 'huddles'];

/** Props of {@link ChatConversationList}. */
export interface ChatConversationListProps {
  /** Groups by id: `pinned`, `dms`, `crewly-channels`, `channels`, `huddles` (others render after) */
  groups: ConversationGroup[];
  activeConversationId: string | null;
  onSelectConversation(row: ConversationRow): void;
  /** Whether a row has messages the owner has not seen */
  isUnread(row: ConversationRow): boolean;
  isPinned(row: ConversationRow): boolean;
  onTogglePin(row: ConversationRow): void;
  /** "New group chat" */
  onNewGroup(): void;
  /** "New channel" (agents from any team, matched to Slack); hidden when absent */
  onNewChannel?(): void;
  /** Shown when there is no conversation at all */
  emptyState?: React.ReactNode;
  /** Agent session that is always visible in DMs (the orchestrator) */
  alwaysShowSession?: string;
  /** Clock (tests) */
  now?: number;
  className?: string;
}

/**
 * Which rows of a section show while it is folded.
 *
 * @param group - Section
 * @param keep - Rows that must stay visible (unread, open, orchestrator)
 * @param now - Clock
 * @returns Visible rows, in the section's order
 */
export function visibleRows(
  group: ConversationGroup,
  keep: (row: ConversationRow) => boolean,
  now: number = Date.now(),
): ConversationRow[] {
  if (group.id === 'pinned') return group.rows;
  if (group.id === 'dms') {
    const must = new Set(group.rows.filter(keep).map((r) => r.id));
    let room = Math.max(0, DM_VISIBLE - must.size);
    return group.rows.filter((r) => {
      if (must.has(r.id)) return true;
      if (room > 0) {
        room -= 1;
        return true;
      }
      return false;
    });
  }
  const recent = (r: ConversationRow): boolean => {
    const at = r.lastMessageAt ? Date.parse(r.lastMessageAt) : NaN;
    return !Number.isNaN(at) && now - at <= ACTIVE_CHANNEL_WINDOW_MS;
  };
  const must = group.rows.filter(keep);
  const mustIds = new Set(must.map((r) => r.id));
  let room = Math.max(0, CHANNEL_VISIBLE - must.length);
  const shown = group.rows.filter((r) => {
    if (mustIds.has(r.id)) return true;
    if (room > 0 && recent(r)) {
      room -= 1;
      return true;
    }
    return false;
  });
  // Nothing active yet (a quiet week, a fresh install): show the first few
  // rather than an empty section.
  return shown.length > 0 ? shown : group.rows.slice(0, QUIET_SECTION_VISIBLE);
}

/**
 * The tooltip of a row: role, Lead, presence.
 *
 * @param row - Row
 * @returns e.g. "team-leader · Lead · online"
 */
export function rowDetails(row: ConversationRow): string | undefined {
  const parts = [row.subtitle, row.badge, row.kind === 'dm' ? row.presence : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * The conversation list.
 *
 * @param props - {@link ChatConversationListProps}
 * @returns Aside
 */
export function ChatConversationList({
  groups,
  activeConversationId,
  onSelectConversation,
  isUnread,
  isPinned,
  onTogglePin,
  onNewGroup,
  onNewChannel,
  emptyState,
  alwaysShowSession,
  now,
  className = '',
}: ChatConversationListProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ordered = useMemo(() => {
    const rank = (id: string): number => {
      const i = SECTION_ORDER.indexOf(id);
      return i < 0 ? SECTION_ORDER.length : i;
    };
    return [...groups].filter((g) => g.rows.length > 0).sort((a, b) => rank(a.id) - rank(b.id));
  }, [groups]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    const seen = new Set<string>();
    return ordered
      .flatMap((g) => g.rows)
      .filter((r) => {
        if (seen.has(r.id) || !r.title.toLowerCase().includes(q)) return false;
        seen.add(r.id);
        return true;
      });
  }, [ordered, q]);

  const keep = (row: ConversationRow): boolean =>
    row.id === activeConversationId || isUnread(row) || (!!alwaysShowSession && row.agentSession === alwaysShowSession);

  const rowProps = (row: ConversationRow) => ({
    row,
    active: row.id === activeConversationId,
    unread: isUnread(row),
    pinned: isPinned(row),
    onSelect: onSelectConversation,
    onTogglePin,
  });

  return (
    <aside
      className={`flex h-full w-full flex-col bg-surface md:w-[240px] md:shrink-0 md:border-r md:border-border ${className}`}
      aria-label="Conversations"
      data-testid="conversation-list-panel"
    >
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 pl-5 pr-2.5">
        <h2 className="text-lg font-extrabold text-text">Chat</h2>
        <div className="flex gap-0.5">
          <IconButton
            label="Find a person or channel"
            onClick={() => {
              setSearchOpen((v) => !v);
              setQuery('');
            }}
            pressed={searchOpen}
            testId="conv-search-toggle"
          >
            <Search size={18} />
          </IconButton>
          {onNewChannel && (
            <IconButton label="Create a channel (agents from any team)" onClick={onNewChannel} testId="new-channel-button">
              <Hash size={18} />
            </IconButton>
          )}
          <IconButton label="Create a multi-agent group chat" onClick={onNewGroup} testId="new-group-button">
            <Plus size={18} />
          </IconButton>
        </div>
      </header>

      {searchOpen && (
        <div className="relative px-2.5 pb-2">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false);
                setQuery('');
              }
            }}
            placeholder="Find a person or channel"
            aria-label="Find a conversation"
            data-testid="conv-search"
            className="h-9 w-full rounded-[var(--crewly-radius-sm)] border border-border bg-bg px-3 text-sm text-text outline-none placeholder:text-text-3 focus:border-primary"
          />
        </div>
      )}

      <div className="chat-scrollbar flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2.5 pb-4 pt-1">
        {q ? (
          results.length === 0 ? (
            <p className="px-2.5 text-[13px] text-text-2" role="status">No conversations match your search.</p>
          ) : (
            <ul role="list" className="m-0 list-none p-0" data-testid="conv-search-results">
              {results.map((r) => (
                <li key={r.id}>
                  <Row {...rowProps(r)} />
                </li>
              ))}
            </ul>
          )
        ) : ordered.length === 0 ? (
          <div className="px-2.5 py-6 text-[13px] text-text-2" role="status">
            {emptyState ?? 'No conversations yet.'}
          </div>
        ) : (
          ordered.map((group) => {
            const isOpen = expanded.has(group.id);
            const shown = isOpen ? group.rows : visibleRows(group, keep, now);
            const hidden = group.rows.length - shown.length;
            return (
              <section key={group.id} aria-labelledby={`conv-group-${group.id}`} data-testid={`conv-group-${group.id}`}>
                <h3 id={`conv-group-${group.id}`} className="mb-1 px-2.5 text-xs font-bold text-text-3">
                  {group.label}
                </h3>
                <ul role="list" className="m-0 list-none p-0">
                  {shown.map((r) => (
                    <li key={r.id}>
                      <Row {...rowProps(r)} />
                    </li>
                  ))}
                </ul>
                {(hidden > 0 || isOpen) && group.id !== 'pinned' && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                    aria-expanded={isOpen}
                    className="h-8 px-2.5 text-[13px] font-semibold text-text-2 hover:text-text"
                    data-testid={`conv-more-${group.id}`}
                  >
                    {isOpen ? 'Show fewer' : `${hidden} more`}
                  </button>
                )}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}

/** One conversation: name (+ `#` for channels), unread dot, hover pin. */
function Row({
  row,
  active,
  unread,
  pinned,
  onSelect,
  onTogglePin,
}: {
  row: ConversationRow;
  active: boolean;
  unread: boolean;
  pinned: boolean;
  onSelect(row: ConversationRow): void;
  onTogglePin(row: ConversationRow): void;
}): JSX.Element {
  const isChannel = row.kind === 'channel';
  const tone = active
    ? 'bg-primary-soft text-primary-text font-bold'
    : unread
      ? 'text-text font-bold hover:bg-surface-hover'
      : 'text-text-2 font-medium hover:bg-surface-hover';
  return (
    <div className="group/row relative flex items-center">
      <button
        type="button"
        onClick={() => onSelect(row)}
        title={rowDetails(row)}
        aria-current={active ? 'page' : undefined}
        data-testid={`conv-row-${row.id}`}
        data-active={active ? 'true' : 'false'}
        data-kind={row.kind}
        data-unread={unread ? 'true' : 'false'}
        className={`flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[var(--crewly-radius-sm)] px-2.5 text-left text-sm ${tone}`}
      >
        {isChannel && (
          <span aria-hidden="true" className="w-3 font-semibold text-text-3">
            #
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{isChannel ? row.title.replace(/^#+\s*/, '') : row.title}</span>
        {unread && <span aria-label="unread" className="h-2 w-2 shrink-0 rounded-full bg-primary" data-testid={`conv-unread-${row.id}`} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(row);
        }}
        aria-label={pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
        aria-pressed={pinned}
        title={pinned ? 'Unpin' : 'Pin'}
        data-testid={`conv-pin-${row.id}`}
        className="absolute right-1 hidden h-7 w-7 items-center justify-center rounded-md bg-surface text-text-2 hover:text-text focus:flex group-hover/row:flex"
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  );
}

/** Small square icon button for the list header. */
function IconButton({
  label,
  onClick,
  pressed,
  testId,
  children,
}: {
  label: string;
  onClick(): void;
  pressed?: boolean;
  testId?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--crewly-radius-sm)] text-text-2 transition-colors hover:bg-surface-hover hover:text-text"
    >
      {children}
    </button>
  );
}

export default ChatConversationList;
