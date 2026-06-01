/**
 * ConversationListPanel — center surface of the Slack-like 3-panel layout.
 *
 * Replaces the flat ChannelList with a grouped view of `Channels`,
 * `Direct Messages`, and `Activity` for the currently-selected workspace
 * (design §6.1, §11.2).
 *
 * Behavior per design §6:
 *  - Lower contrast than the workspace rail; this is the scan-heavy panel.
 *  - Each row shows: title, last-message preview, last-message time,
 *    unread count, mention count pill, and (for DMs) presence dot.
 *  - Selected row gets a full-width active state — not just a text
 *    highlight — so the current context is always obvious (§6.1).
 *  - Channel rows render with `#` prefix; DM rows render with the agent
 *    avatar + presence dot. Iconography differentiates kind, not color
 *    alone (§6.2).
 *  - Unread uses the bold-row + count-pill convention (§6.2 center
 *    list rule).
 *
 * Visuals follow the approved Material-3 prototype: a header with the
 * team name + a New-group affordance and a Find… search box, then grouped
 * channel / member rows.
 *
 * @module components/ConversationListPanel
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { ConversationGroup, ConversationRow } from '../types/team-chat.types';
import { AgentStatusBadge } from './AgentStatusBadge';

/** localStorage key for collapsed conversation-group ids. */
const COLLAPSED_GROUPS_KEY = 'crewly-chat-collapsed-groups';

/**
 * Per-agent avatar tints for DM rows (prototype palette). Deterministically
 * chosen per name so the same agent keeps the same color across renders.
 */
const DM_AVATAR_TINTS = [
  'bg-blue-500/20 text-blue-400',
  'bg-purple-500/20 text-purple-400',
  'bg-cyan-500/20 text-cyan-400',
  'bg-indigo-500/20 text-indigo-400',
] as const;

/** Deterministically map a name to one of the DM avatar tints. */
function dmAvatarTint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return DM_AVATAR_TINTS[h % DM_AVATAR_TINTS.length];
}

/** Stored collapsed-group ids, or null when the user has no saved preference. */
function loadCollapsedGroups(): Set<string> | null {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
    }
  } catch {
    // ignore — no saved preference
  }
  return null;
}

export interface ConversationListPanelProps {
  /** Workspace title rendered as the panel header. */
  workspaceName?: string;
  /** Grouped conversation rows. Render order is preserved. */
  groups: ConversationGroup[];
  /** Currently-selected conversation id. */
  activeConversationId?: string | null;
  /** Selection callback. Receives the row, not just the id. */
  onSelectConversation?(row: ConversationRow): void;
  /**
   * Optional empty-state override for when every group is empty. Default
   * is a one-liner; the parent can pass a richer node (the design §9.2
   * "Channels in Selected Team" empty state).
   */
  emptyState?: React.ReactNode;
  /**
   * Optional action rendered at the right of the panel header (additive).
   * Used by the OSS app for the "New group" (拉群) button. When provided,
   * the header renders even if `workspaceName` is omitted.
   */
  headerAction?: React.ReactNode;
  /** When provided, renders a pin toggle per row; returns true if pinned. */
  isPinned?: (row: ConversationRow) => boolean;
  /** Pin/unpin a conversation. Enables the per-row pin affordance. */
  onTogglePin?: (row: ConversationRow) => void;
  /**
   * Group ids collapsed by default when the user has no saved preference yet
   * (e.g. a noisy "Slack" section). Once the user toggles anything, their
   * persisted state wins.
   */
  defaultCollapsedGroupIds?: string[];
  className?: string;
}

export function ConversationListPanel({
  workspaceName,
  groups,
  activeConversationId = null,
  onSelectConversation,
  emptyState,
  headerAction,
  isPinned,
  onTogglePin,
  defaultCollapsedGroupIds,
  className = '',
}: ConversationListPanelProps): JSX.Element {
  // Local search filter — narrows visible rows by title (case-insensitive).
  const [query, setQuery] = useState('');

  const filteredGroups = useMemo(() => filterGroups(groups, query), [groups, query]);

  const totalRows = useMemo(
    () => filteredGroups.reduce((acc, g) => acc + countRows(g), 0),
    [filteredGroups],
  );

  // Collapsed/expanded state per group id, persisted to localStorage. With no
  // saved preference, fall back to the host's default-collapsed ids.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => loadCollapsedGroups() ?? new Set(defaultCollapsedGroupIds ?? []),
  );
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // ignore — collapse state is best-effort
      }
      return next;
    });
  }, []);

  return (
    <aside
      className={`flex h-full w-[240px] flex-col border-r border-border-dark bg-[#232d3b] ${className}`}
      aria-label={workspaceName ? `${workspaceName} conversations` : 'Conversations'}
      data-testid="conversation-list-panel"
    >
      {(workspaceName || headerAction) && (
        <header className="border-b border-border-dark p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-base font-bold text-text-primary-dark">
              {workspaceName ?? ''}
            </h2>
            {headerAction}
          </div>
          <div className="relative mt-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find..."
              aria-label="Find a conversation"
              data-testid="conv-search"
              className="w-full rounded-lg border border-border-dark bg-background-dark px-3 py-1.5 text-[13px] text-text-primary-dark outline-none placeholder:text-text-secondary-dark focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
        </header>
      )}

      <div className="chat-scrollbar flex-1 overflow-y-auto p-2">
        {totalRows === 0 ? (
          <div className="px-2 py-6 text-[13px] text-text-secondary-dark" role="status">
            {query
              ? 'No conversations match your search.'
              : (emptyState ?? 'No conversations in this workspace yet.')}
          </div>
        ) : (
          filteredGroups.map((group) =>
            groupHasContent(group) ? (
              <ConversationGroupSection
                key={group.id}
                group={group}
                activeConversationId={activeConversationId}
                onSelectConversation={onSelectConversation}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                isPinned={isPinned}
                onTogglePin={onTogglePin}
              />
            ) : null,
          )
        )}
      </div>
    </aside>
  );
}

/** Total rows in a group, including nested sub-groups. */
function countRows(group: ConversationGroup): number {
  return (
    group.rows.length + (group.subGroups?.reduce((acc, g) => acc + countRows(g), 0) ?? 0)
  );
}

/** Whether a group has any conversation to render (own rows or nested). */
function groupHasContent(group: ConversationGroup): boolean {
  return countRows(group) > 0;
}

/**
 * Filter every group's rows (recursively through sub-groups) by a
 * case-insensitive title match. An empty query returns the input untouched.
 */
function filterGroups(groups: ConversationGroup[], query: string): ConversationGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const filterOne = (g: ConversationGroup): ConversationGroup => ({
    ...g,
    rows: g.rows.filter((r) => r.title.toLowerCase().includes(q)),
    subGroups: g.subGroups?.map(filterOne),
  });
  return groups.map(filterOne);
}

function ConversationGroupSection({
  group,
  activeConversationId,
  onSelectConversation,
  collapsed,
  onToggleCollapse,
  isPinned,
  onTogglePin,
  depth = 0,
}: {
  group: ConversationGroup;
  activeConversationId: string | null;
  onSelectConversation?: (row: ConversationRow) => void;
  /** The set of collapsed group ids, so nested sections manage themselves. */
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  isPinned?: (row: ConversationRow) => boolean;
  onTogglePin?: (row: ConversationRow) => void;
  /** Nesting depth — drives header indentation for sub-groups. */
  depth?: number;
}): JSX.Element {
  const isCollapsed = collapsed.has(group.id);
  const subGroups = (group.subGroups ?? []).filter(groupHasContent);

  return (
    <section
      className={depth === 0 ? 'mb-4' : 'mt-2'}
      aria-labelledby={`conv-group-${group.id}`}
      data-testid={`conv-group-${group.id}`}
    >
      {/* Collapsible header — click to expand/collapse the section. */}
      <button
        type="button"
        id={`conv-group-${group.id}`}
        onClick={() => onToggleCollapse(group.id)}
        aria-expanded={!isCollapsed}
        data-testid={`conv-group-toggle-${group.id}`}
        className="mb-2 flex w-full items-center justify-between px-2"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <span className="flex items-center gap-1">
          <ChevronDown
            size={16}
            className={`text-text-secondary-dark transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
          />
          <span className="truncate text-[11px] font-bold uppercase tracking-wider text-text-secondary-dark">
            {group.label}
          </span>
        </span>
        <span className="text-[10px] text-text-secondary-dark">{countRows(group)}</span>
      </button>
      {!isCollapsed && (
        <>
          {group.rows.length > 0 && (
            <ul role="list" className="flex flex-col gap-0.5">
              {group.rows.map((row) => (
                <li key={row.id}>
                  <ConversationRowItem
                    row={row}
                    isActive={activeConversationId === row.id}
                    onSelect={onSelectConversation}
                    pinned={isPinned?.(row) ?? false}
                    onTogglePin={onTogglePin}
                  />
                </li>
              ))}
            </ul>
          )}
          {subGroups.map((sub) => (
            <ConversationGroupSection
              key={sub.id}
              group={sub}
              activeConversationId={activeConversationId}
              onSelectConversation={onSelectConversation}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              depth={depth + 1}
            />
          ))}
        </>
      )}
    </section>
  );
}

function ConversationRowItem({
  row,
  isActive,
  onSelect,
  pinned,
  onTogglePin,
}: {
  row: ConversationRow;
  isActive: boolean;
  onSelect?: (row: ConversationRow) => void;
  pinned?: boolean;
  onTogglePin?: (row: ConversationRow) => void;
}): JSX.Element {
  const hasUnread = (row.unreadCount ?? 0) > 0;
  const hasMentions = (row.mentionCount ?? 0) > 0;
  const isChannel = row.kind === 'channel';

  // Channel rows are a compact `# name` pill; DM/activity rows are a richer
  // avatar + name + preview layout per the prototype.
  const rowClass = isChannel
    ? isActive
      ? 'flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-3 py-1.5 text-primary'
      : 'flex items-center gap-2 rounded-lg px-3 py-1.5 text-text-secondary-dark hover:bg-white/5'
    : isActive
      ? 'group flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-primary'
      : 'group flex items-center gap-3 rounded-lg px-3 py-2 text-text-secondary-dark hover:bg-white/5';

  return (
    <div className="group/row relative flex w-full items-center">
      <button
        type="button"
        onClick={() => onSelect?.(row)}
        data-testid={`conv-row-${row.id}`}
        data-active={isActive ? 'true' : 'false'}
        data-kind={row.kind}
        data-unread={hasUnread ? 'true' : 'false'}
        className={`min-w-0 flex-1 text-left ${rowClass}`}
        aria-current={isActive ? 'page' : undefined}
      >
        <ConversationKindIcon row={row} />

        {isChannel ? (
          <span
            className={[
              'min-w-0 flex-1 truncate text-[13px]',
              hasUnread ? 'font-semibold text-text-primary-dark' : '',
            ].join(' ')}
          >
            {/* The leading `#` glyph is rendered separately, so strip any `#`
                the channel name itself carries to avoid a doubled `##`. */}
            {row.title.replace(/^#+\s*/, '')}
          </span>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={[
                  'truncate text-[13px] font-medium',
                  hasUnread
                    ? 'font-semibold text-text-primary-dark'
                    : 'text-text-primary-dark group-hover:text-primary',
                ].join(' ')}
              >
                {row.title}
              </span>
              {row.badge && (
                <span
                  className="shrink-0 rounded bg-primary/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary"
                  data-testid={`conv-badge-${row.id}`}
                >
                  {row.badge}
                </span>
              )}
              {row.lastMessageAt && (
                <time
                  className="ml-auto shrink-0 text-[10px] text-text-secondary-dark"
                  dateTime={row.lastMessageAt}
                >
                  {formatRelativeTime(row.lastMessageAt)}
                </time>
              )}
            </div>
            {row.lastMessagePreview && (
              <div className="truncate text-[10px] opacity-70">
                {row.lastMessagePreview}
              </div>
            )}
            {row.subtitle && !row.lastMessagePreview && (
              <div className="truncate text-[10px] opacity-70">{row.subtitle}</div>
            )}
          </div>
        )}

        {/* Mention count is the strongest pill — overrides unread pill when both apply. */}
        {hasMentions ? (
          <span
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white"
            data-testid={`conv-mention-pill-${row.id}`}
            aria-label={`${row.mentionCount} mentions`}
          >
            @{row.mentionCount}
          </span>
        ) : hasUnread ? (
          <span
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white"
            data-testid={`conv-unread-pill-${row.id}`}
            aria-label={`${row.unreadCount} unread`}
          >
            {row.unreadCount}
          </span>
        ) : null}
      </button>

      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(row);
          }}
          data-testid={`conv-pin-${row.id}`}
          aria-label={pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
          aria-pressed={pinned}
          title={pinned ? 'Unpin' : 'Pin'}
          className={[
            'ml-1 shrink-0 rounded p-1 text-text-secondary-dark hover:text-amber-400',
            // Pinned: always visible. Unpinned: reveal on row hover.
            pinned ? 'text-amber-400' : 'opacity-0 group-hover/row:opacity-100',
          ].join(' ')}
        >
          <PinIcon filled={pinned ?? false} />
        </button>
      )}
    </div>
  );
}

/** Pin glyph — filled when pinned. */
function PinIcon({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <path
        d="M9.5 1.5l5 5-2 .5-2.5 2.5L9 13 7 11 3.5 14.5 3 14l3.5-3.5L4.5 8.5 7 6l.5-2.5 2-2z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Render the per-row leading icon. Channels get `#`, DMs get an avatar
 * + AgentStatusBadge dot, activity rows get a generic system glyph.
 */
function ConversationKindIcon({ row }: { row: ConversationRow }): JSX.Element {
  if (row.kind === 'channel') {
    return (
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center text-base font-medium"
        data-testid={`conv-icon-${row.id}`}
      >
        #
      </span>
    );
  }
  if (row.kind === 'dm') {
    return (
      <span
        aria-hidden="true"
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold uppercase ${dmAvatarTint(row.title)}`}
        data-testid={`conv-icon-${row.id}`}
      >
        {deriveDmInitials(row.title)}
        {row.presence && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface-dark p-[1px]">
            <AgentStatusBadge status={row.presence} compact />
          </span>
        )}
      </span>
    );
  }
  // activity
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center text-xs text-text-secondary-dark"
      data-testid={`conv-icon-${row.id}`}
    >
      ⟳
    </span>
  );
}

function deriveDmInitials(title: string): string {
  const tokens = title.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

/**
 * Compact relative time for the row trailing label. Best-effort and
 * locale-agnostic; renders the absolute time once we cross 24h so the
 * label stays narrow.
 */
function formatRelativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = now - then;
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
