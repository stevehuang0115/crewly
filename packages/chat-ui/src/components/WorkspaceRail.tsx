/**
 * WorkspaceRail — narrow icon-first team switcher.
 *
 * Left rail of the Slack-like 3-panel layout (design §6.1, §11.2).
 * Stable across workspace switches; the highest-contrast nav surface in
 * the app so users always know which workspace context they are in.
 *
 * Behavior:
 *  - Renders a vertical list of `Workspace` icons.
 *  - Selected workspace gets a full-width active state, not just a text
 *    highlight (design §6.1).
 *  - Unread shows as a small dot per design §6.2 (rail = dot).
 *  - Mention-priority dot uses a distinct red tint to separate "you
 *    were @-mentioned" from "there is unread activity".
 *  - Presence summary appears as a small dot on the workspace icon if
 *    any member is active. Unread supersedes presence per §8.2 — when
 *    unread exists we drop the presence dot to keep the iconography
 *    legible.
 *  - Nested grouping: workspaces with `parentId` indent under their
 *    parent; the rail renders parents first then their children, indented.
 *  - Collapsed mode (default): width-fixed icon-only column. Expanded
 *    mode shows the workspace label next to the icon — useful for the
 *    Tablet breakpoint per §10.1.
 *
 * Phase B does NOT wire to a live BE — the parent passes mock data.
 * Phase A backend (Sam, target 2026-04-27 EOD) will populate
 * `workspaces` from the team directory and the unread counts from the
 * cross-team unread index.
 *
 * @module components/WorkspaceRail
 */

import { useMemo } from 'react';
import type { Workspace } from '../types/team-chat.types';
import type { ChatPresenceStatus } from './AgentStatusBadge';

export interface WorkspaceRailProps {
  /** All workspaces visible to the current user. Order is preserved. */
  workspaces: Workspace[];
  /** Currently-selected workspace id. */
  activeWorkspaceId?: string | null;
  /** Selection callback. Receives the full workspace, not just the id. */
  onSelectWorkspace?(workspace: Workspace): void;
  /**
   * When true, render labels next to icons (Tablet breakpoint). Default
   * false keeps the icon-only Slack rail.
   */
  expanded?: boolean;
  /**
   * ADDITIVE. When true, always render the workspace name beside every icon at
   * a wider, label-first width (chat host's long-list mode). Independent of
   * `expanded`. Default false preserves the icon-only rail for existing callers.
   */
  showLabels?: boolean;
  className?: string;
}

const PRESENCE_DOT: Record<ChatPresenceStatus, string> = {
  online: 'bg-emerald-500',
  busy: 'bg-amber-400',
  idle: 'bg-amber-300',
  offline: 'bg-slate-400',
  inactive: 'bg-slate-300',
};

export function WorkspaceRail({
  workspaces,
  activeWorkspaceId = null,
  onSelectWorkspace,
  expanded = false,
  showLabels = false,
  className = '',
}: WorkspaceRailProps): JSX.Element {
  // Deterministic order: roots in their original order, each followed by
  // its children. Preserves caller intent while keeping the visual
  // grouping in §6.1 ("Crewly" parent contains Product, Marketing).
  const ordered = useMemo(() => orderByParent(workspaces), [workspaces]);

  // Labels show in either the tablet `expanded` mode or the host `showLabels`
  // long-list mode; the latter uses a wider column for full names.
  const labelled = expanded || showLabels;
  const width = expanded ? 'w-48' : showLabels ? 'w-56' : 'w-16';

  return (
    <nav
      className={`flex h-full flex-col items-stretch gap-1 overflow-y-auto border-r border-slate-200 bg-slate-900 py-3 ${width} ${className}`}
      aria-label="Workspace rail"
      data-testid="workspace-rail"
      data-expanded={expanded ? 'true' : 'false'}
      data-labelled={labelled ? 'true' : 'false'}
    >
      {ordered.map((ws) => (
        <WorkspaceRow
          key={ws.id}
          workspace={ws}
          isActive={activeWorkspaceId === ws.id}
          isNested={!!ws.parentId}
          showLabel={labelled}
          onSelect={onSelectWorkspace}
        />
      ))}
      {ordered.length === 0 && <RailEmpty />}
    </nav>
  );
}

function WorkspaceRow({
  workspace,
  isActive,
  isNested,
  showLabel,
  onSelect,
}: {
  workspace: Workspace;
  isActive: boolean;
  isNested: boolean;
  showLabel: boolean;
  onSelect?: (w: Workspace) => void;
}): JSX.Element {
  const initials = workspace.initials ?? deriveInitials(workspace.name);
  const isActivity = workspace.kind === 'activity';
  const isHome = workspace.kind === 'home';
  const hasUnread = (workspace.unreadCount ?? 0) > 0;
  // Glyph precedence: host-injected vector icon → emoji avatar → derived initials.
  const hasGlyph = workspace.icon != null || workspace.avatar != null;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(workspace)}
      data-testid={`workspace-row-${workspace.id}`}
      data-active={isActive ? 'true' : 'false'}
      data-nested={isNested ? 'true' : 'false'}
      data-kind={workspace.kind ?? 'team'}
      // Hover tooltip — the rail is icon-only when collapsed, so the 2-letter
      // initials are otherwise opaque. Title reveals the name (or a richer
      // tooltip override when provided).
      title={workspace.tooltip ?? workspace.name}
      className={[
        'group relative mx-2 flex items-center gap-3 rounded-lg px-2 py-2 pr-4 text-left transition',
        // Active state is full-width per §6.1, not just a tint.
        isActive
          ? 'bg-blue-600/20 text-white ring-1 ring-blue-400/40'
          : 'text-slate-200 hover:bg-slate-800',
        // Indent nested children one notch.
        isNested ? 'ml-4' : '',
      ].join(' ')}
      aria-current={isActive ? 'page' : undefined}
      aria-label={
        hasUnread
          ? `${workspace.name}, ${workspace.unreadCount} unread`
          : workspace.name
      }
    >
      <span
        aria-hidden="true"
        className={[
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-semibold',
          // A vector icon / emoji glyph is not uppercased; initials are.
          hasGlyph ? 'text-lg' : 'text-sm uppercase',
          isHome
            ? 'bg-slate-700 text-white ring-1 ring-slate-500'
            : isActivity
              ? 'bg-slate-700 text-slate-100'
              : 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white',
        ].join(' ')}
      >
        {workspace.icon ?? workspace.avatar ?? initials}
      </span>

      {showLabel && (
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-9">
          {workspace.name}
        </span>
      )}

      {/*
        Indicator stack — unread takes priority over presence per §8.2.
        Mention dot is the strongest visual signal and pre-empts both.
      */}
      {workspace.hasMentions ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 inline-block h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-slate-900"
          data-testid={`workspace-mention-${workspace.id}`}
        />
      ) : hasUnread ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 inline-block h-2 w-2 rounded-full bg-blue-400 ring-2 ring-slate-900"
          data-testid={`workspace-unread-${workspace.id}`}
        />
      ) : workspace.presence ? (
        <span
          aria-hidden="true"
          className={`absolute right-1 top-1 inline-block h-1.5 w-1.5 rounded-full ring-2 ring-slate-900 ${
            PRESENCE_DOT[workspace.presence]
          }`}
          data-testid={`workspace-presence-${workspace.id}`}
        />
      ) : null}
    </button>
  );
}

function RailEmpty(): JSX.Element {
  return (
    <div className="px-2 py-4 text-center text-xs text-slate-500" role="status">
      No teams yet.
    </div>
  );
}

/**
 * Two-letter initials derived from the workspace name. Strips spaces
 * and uses the first character of the first two non-empty tokens; falls
 * back to the first 2 characters for single-word names.
 */
function deriveInitials(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

/**
 * Re-order so each parent immediately precedes its children. Stable for
 * equal `parentId` values: input order is preserved within each group.
 */
function orderByParent(input: Workspace[]): Workspace[] {
  const roots = input.filter((w) => !w.parentId);
  const childrenByParent = new Map<string, Workspace[]>();
  for (const w of input) {
    if (!w.parentId) continue;
    const list = childrenByParent.get(w.parentId) ?? [];
    list.push(w);
    childrenByParent.set(w.parentId, list);
  }
  const out: Workspace[] = [];
  for (const r of roots) {
    out.push(r);
    const children = childrenByParent.get(r.id) ?? [];
    out.push(...children);
  }
  // Surface any orphans (parentId that doesn't match a root) at the end
  // so they aren't silently dropped — defensive against stale data.
  const placedIds = new Set(out.map((w) => w.id));
  for (const w of input) {
    if (!placedIds.has(w.id)) out.push(w);
  }
  return out;
}
