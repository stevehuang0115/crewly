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
  /**
   * ADDITIVE. Parent workspace ids the user has collapsed — their child
   * workspaces are hidden until expanded. When omitted, nothing is collapsed
   * (every child visible), preserving today's behavior for callers (incl.
   * Portal) that don't manage collapse state.
   */
  collapsedParentIds?: string[];
  /**
   * ADDITIVE. Called when the user clicks a parent's collapse chevron. Only
   * when provided (and in caption layout) does a parent render the chevron —
   * so callers that don't pass it get the flat, always-expanded rail.
   */
  onToggleCollapse?(parentId: string): void;
  className?: string;
}

const PRESENCE_DOT: Record<ChatPresenceStatus, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-amber-400',
  idle: 'bg-amber-400',
  offline: 'bg-gray-500',
  inactive: 'bg-gray-500',
};

export function WorkspaceRail({
  workspaces,
  activeWorkspaceId = null,
  onSelectWorkspace,
  expanded = false,
  showLabels = false,
  collapsedParentIds,
  onToggleCollapse,
  className = '',
}: WorkspaceRailProps): JSX.Element {
  // Deterministic order: roots in their original order, each followed by
  // its children. Preserves caller intent while keeping the visual
  // grouping in §6.1 ("Crewly" parent contains Product, Marketing).
  const ordered = useMemo(() => orderByParent(workspaces), [workspaces]);

  // Workspaces that are a parent of at least one child — they get the
  // collapse chevron + act as a group header for their nested tiles.
  const parentIds = useMemo(() => {
    const set = new Set<string>();
    for (const w of workspaces) if (w.parentId) set.add(w.parentId);
    return set;
  }, [workspaces]);

  const collapsed = useMemo(
    () => new Set(collapsedParentIds ?? []),
    [collapsedParentIds],
  );

  // Hide children whose parent is collapsed. Parents and roots always show.
  const visible = useMemo(
    () => ordered.filter((w) => !(w.parentId && collapsed.has(w.parentId))),
    [ordered, collapsed],
  );

  // Three layouts: `beside` (tablet `expanded`, label to the right, wide),
  // `caption` (host `showLabels` — Slack-style icon with a small label beneath,
  // narrow), or `icon` (default icon-only). `caption` is the chat default.
  const layout: RailLayout = expanded ? 'beside' : showLabels ? 'caption' : 'icon';
  const width = layout === 'beside' ? 'w-48' : layout === 'caption' ? 'w-24' : 'w-16';

  return (
    <nav
      className={`flex h-full flex-col items-stretch gap-1 overflow-y-auto border-r border-border-dark bg-background-dark py-3 ${width} ${className}`}
      aria-label="Workspace rail"
      data-testid="workspace-rail"
      data-expanded={expanded ? 'true' : 'false'}
      data-labelled={layout !== 'icon' ? 'true' : 'false'}
      data-layout={layout}
    >
      {visible.map((ws) => (
        <WorkspaceRow
          key={ws.id}
          workspace={ws}
          isActive={activeWorkspaceId === ws.id}
          isNested={!!ws.parentId}
          isParent={parentIds.has(ws.id)}
          isCollapsed={collapsed.has(ws.id)}
          layout={layout}
          onSelect={onSelectWorkspace}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
      {visible.length === 0 && <RailEmpty />}
    </nav>
  );
}

/** Visual layout of a rail row. */
type RailLayout = 'icon' | 'beside' | 'caption';

function WorkspaceRow({
  workspace,
  isActive,
  isNested,
  isParent = false,
  isCollapsed = false,
  layout,
  onSelect,
  onToggleCollapse,
}: {
  workspace: Workspace;
  isActive: boolean;
  isNested: boolean;
  /** True when this workspace has child workspaces nested under it. */
  isParent?: boolean;
  /** True when this parent is collapsed (children hidden). */
  isCollapsed?: boolean;
  layout: RailLayout;
  onSelect?: (w: Workspace) => void;
  onToggleCollapse?: (parentId: string) => void;
}): JSX.Element {
  const initials = workspace.initials ?? deriveInitials(workspace.name);
  const isActivity = workspace.kind === 'activity';
  const isHome = workspace.kind === 'home';
  const hasUnread = (workspace.unreadCount ?? 0) > 0;
  // Glyph precedence: host-injected vector icon → emoji avatar → derived initials.
  const hasGlyph = workspace.icon != null || workspace.avatar != null;
  const caption = layout === 'caption';
  const beside = layout === 'beside';
  // A nested child in the caption rail gets a connector spine + slight inset +
  // a smaller glyph, so the parent → sub-team relationship reads at a glance
  // without aggressive indentation at the narrow w-24 width.
  const childInset = caption && isNested;
  // Parents render a collapse chevron only when the host wires collapse and
  // we're in the labelled caption rail (the OSS chat host's layout).
  const showChevron = caption && isParent && !!onToggleCollapse;

  // Indicator dot — mention > unread > presence (§8.2). Positioned on the glyph.
  const dot = workspace.hasMentions ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 inline-block h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-background-dark"
      data-testid={`workspace-mention-${workspace.id}`}
    />
  ) : hasUnread ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 inline-block h-2 w-2 rounded-full bg-primary ring-2 ring-background-dark"
      data-testid={`workspace-unread-${workspace.id}`}
    />
  ) : workspace.presence ? (
    <span
      aria-hidden="true"
      className={`absolute -right-0.5 -top-0.5 inline-block h-1.5 w-1.5 rounded-full ring-2 ring-background-dark ${
        PRESENCE_DOT[workspace.presence]
      }`}
      data-testid={`workspace-presence-${workspace.id}`}
    />
  ) : null;

  const rowButton = (
    <button
      type="button"
      onClick={() => onSelect?.(workspace)}
      data-testid={`workspace-row-${workspace.id}`}
      data-active={isActive ? 'true' : 'false'}
      data-nested={isNested ? 'true' : 'false'}
      data-kind={workspace.kind ?? 'team'}
      // Hover tooltip — reveals the full name (esp. for icon-only mode + when a
      // caption truncates), or a richer tooltip override when provided.
      title={workspace.tooltip ?? workspace.name}
      className={[
        'group relative rounded-lg transition',
        caption
          ? 'mx-1.5 flex flex-col items-center gap-1 px-1 py-1.5 text-center'
          : 'mx-2 flex items-center gap-3 px-2 py-2 pr-4 text-left',
        isActive
          ? 'bg-primary/15 text-text-primary-dark ring-1 ring-primary/50'
          : 'text-text-secondary-dark hover:bg-surface-dark hover:text-text-primary-dark',
        // Indent nested children one notch (beside layout only).
        isNested && !caption ? 'ml-4' : '',
        // Caption child: inset the tile so the connector spine sits at its left.
        childInset ? 'ml-3' : '',
      ].join(' ')}
      aria-current={isActive ? 'page' : undefined}
      aria-label={
        hasUnread ? `${workspace.name}, ${workspace.unreadCount} unread` : workspace.name
      }
    >
      <span className="relative shrink-0">
        <span
          aria-hidden="true"
          className={[
            'flex items-center justify-center rounded-lg font-semibold',
            // Child tiles are a notch smaller than parents/roots.
            childInset ? 'h-7 w-7' : 'h-9 w-9',
            // A vector icon / emoji glyph is not uppercased; initials are.
            hasGlyph ? (childInset ? 'text-base' : 'text-lg') : childInset ? 'text-[10px] uppercase' : 'text-sm uppercase',
            isHome
              ? 'bg-surface-dark text-text-primary-dark ring-1 ring-border-dark'
              : isActivity
                ? 'bg-surface-dark text-text-primary-dark'
                : 'bg-gradient-to-br from-primary to-[#1e5fc7] text-white',
          ].join(' ')}
        >
          {workspace.icon ?? workspace.avatar ?? initials}
        </span>
        {dot}
      </span>

      {caption && (
        <span className="w-full truncate text-[11px] font-medium leading-tight">
          {workspace.name}
        </span>
      )}
      {beside && (
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-9">
          {workspace.name}
        </span>
      )}
    </button>
  );

  // Bare button is the common case. In the caption rail, a child tile gets a
  // connector spine up to its parent, and a parent tile gets a collapse
  // chevron — both need a positioned wrapper around the button.
  if (!childInset && !showChevron) return rowButton;
  return (
    <div className="relative">
      {childInset && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-3 top-0 w-px bg-border-dark"
          data-testid={`workspace-spine-${workspace.id}`}
        />
      )}
      {rowButton}
      {showChevron && (
        <button
          type="button"
          onClick={() => onToggleCollapse?.(workspace.id)}
          data-testid={`workspace-collapse-${workspace.id}`}
          aria-label={isCollapsed ? `Expand ${workspace.name}` : `Collapse ${workspace.name}`}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand sub-teams' : 'Collapse sub-teams'}
          className="absolute right-1 top-1 rounded p-0.5 text-text-secondary-dark transition hover:bg-surface-dark hover:text-text-primary-dark"
        >
          <RailChevron collapsed={isCollapsed} />
        </button>
      )}
    </div>
  );
}

/** Collapse chevron for a parent rail tile — points right (collapsed) / down. */
function RailChevron({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={`h-3 w-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
    >
      <path
        d="M4 2l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RailEmpty(): JSX.Element {
  return (
    <div className="px-2 py-4 text-center text-xs text-text-secondary-dark" role="status">
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
