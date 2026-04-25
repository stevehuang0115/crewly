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
 * Phase B: parent supplies a `groups` array. Phase A backend wires real
 * data via Sam's chat conversation API. Mention chip routing to the
 * suggestion popover stays out of this panel — that's MentionComposer.
 *
 * @module components/ConversationListPanel
 */

import { useMemo } from 'react';
import type { ConversationGroup, ConversationRow } from '../types/team-chat.types';
import { AgentStatusBadge } from './AgentStatusBadge';

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
  className?: string;
}

export function ConversationListPanel({
  workspaceName,
  groups,
  activeConversationId = null,
  onSelectConversation,
  emptyState,
  className = '',
}: ConversationListPanelProps): JSX.Element {
  const totalRows = useMemo(
    () => groups.reduce((acc, g) => acc + g.rows.length, 0),
    [groups],
  );

  return (
    <aside
      className={`flex h-full w-72 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900 ${className}`}
      aria-label={workspaceName ? `${workspaceName} conversations` : 'Conversations'}
      data-testid="conversation-list-panel"
    >
      {workspaceName && (
        <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
            {workspaceName}
          </h2>
        </header>
      )}

      <div className="flex-1 overflow-y-auto">
        {totalRows === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500" role="status">
            {emptyState ?? 'No conversations in this workspace yet.'}
          </div>
        ) : (
          groups.map((group) =>
            group.rows.length > 0 ? (
              <ConversationGroupSection
                key={group.id}
                group={group}
                activeConversationId={activeConversationId}
                onSelectConversation={onSelectConversation}
              />
            ) : null,
          )
        )}
      </div>
    </aside>
  );
}

function ConversationGroupSection({
  group,
  activeConversationId,
  onSelectConversation,
}: {
  group: ConversationGroup;
  activeConversationId: string | null;
  onSelectConversation?: (row: ConversationRow) => void;
}): JSX.Element {
  return (
    <section
      className="border-b border-slate-200 py-2 last:border-b-0 dark:border-slate-800"
      aria-labelledby={`conv-group-${group.id}`}
      data-testid={`conv-group-${group.id}`}
    >
      <h3
        id={`conv-group-${group.id}`}
        className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400"
      >
        {group.label}
      </h3>
      <ul role="list" className="flex flex-col">
        {group.rows.map((row) => (
          <li key={row.id}>
            <ConversationRowItem
              row={row}
              isActive={activeConversationId === row.id}
              onSelect={onSelectConversation}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationRowItem({
  row,
  isActive,
  onSelect,
}: {
  row: ConversationRow;
  isActive: boolean;
  onSelect?: (row: ConversationRow) => void;
}): JSX.Element {
  const hasUnread = (row.unreadCount ?? 0) > 0;
  const hasMentions = (row.mentionCount ?? 0) > 0;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(row)}
      data-testid={`conv-row-${row.id}`}
      data-active={isActive ? 'true' : 'false'}
      data-kind={row.kind}
      data-unread={hasUnread ? 'true' : 'false'}
      className={[
        // Full-width active state per §6.1 — left border + tinted bg, not just text color.
        'flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition',
        isActive
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800',
      ].join(' ')}
      aria-current={isActive ? 'page' : undefined}
    >
      <ConversationKindIcon row={row} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={[
              'truncate text-sm',
              hasUnread
                ? 'font-semibold text-slate-900 dark:text-slate-50'
                : 'text-slate-700 dark:text-slate-300',
            ].join(' ')}
          >
            {row.title}
          </span>
          {row.lastMessageAt && (
            <time
              className="ml-auto shrink-0 text-[10px] text-slate-400 dark:text-slate-500"
              dateTime={row.lastMessageAt}
            >
              {formatRelativeTime(row.lastMessageAt)}
            </time>
          )}
        </div>
        {row.lastMessagePreview && (
          <div
            className={[
              'truncate text-xs',
              hasUnread
                ? 'text-slate-600 dark:text-slate-300'
                : 'text-slate-500 dark:text-slate-400',
            ].join(' ')}
          >
            {row.lastMessagePreview}
          </div>
        )}
        {row.subtitle && !row.lastMessagePreview && (
          <div className="truncate text-xs text-slate-400 dark:text-slate-500">
            {row.subtitle}
          </div>
        )}
      </div>

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
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-700 px-1 text-[10px] font-semibold text-white dark:bg-slate-300 dark:text-slate-900"
          data-testid={`conv-unread-pill-${row.id}`}
          aria-label={`${row.unreadCount} unread`}
        >
          {row.unreadCount}
        </span>
      ) : null}
    </button>
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
        className="flex h-6 w-6 shrink-0 items-center justify-center text-base font-medium text-slate-500 dark:text-slate-400"
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
        className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-[10px] font-semibold uppercase text-white"
        data-testid={`conv-icon-${row.id}`}
      >
        {deriveDmInitials(row.title)}
        {row.presence && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white p-[1px] dark:bg-slate-900">
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
      className="flex h-6 w-6 shrink-0 items-center justify-center text-xs text-slate-400"
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
