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
 * The `caption` layout (the chat host's, `showLabels`) follows the
 * approved Material-3 prototype: a narrow centred rail of circular
 * avatars with a small caption beneath. A PARENT team (one with child
 * sub-teams) renders its children below it as indented horizontal rows.
 *
 * Phase B does NOT wire to a live BE — the parent passes mock data.
 *
 * @module components/WorkspaceRail
 */

import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Workspace } from '../types/team-chat.types';
import type { ChatPresenceStatus } from './AgentStatusBadge';

/** Legacy presence dot palette for the icon/beside layouts. */
const PRESENCE_DOT: Record<ChatPresenceStatus, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-amber-400',
  idle: 'bg-amber-400',
  offline: 'bg-gray-500',
  inactive: 'bg-gray-500',
};

/** Caption (prototype) presence dot palette — green online, muted otherwise. */
const CAPTION_PRESENCE_DOT: Record<ChatPresenceStatus, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-amber-400',
  idle: 'bg-amber-400',
  offline: 'bg-gray-500',
  inactive: 'bg-gray-500',
};

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

  // Children grouped by parent id, in render order — used by the caption
  // layout to nest sub-teams beneath their parent as indented rows.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Workspace[]>();
    for (const w of ordered) {
      if (!w.parentId) continue;
      const list = m.get(w.parentId) ?? [];
      list.push(w);
      m.set(w.parentId, list);
    }
    return m;
  }, [ordered]);

  // Hide children whose parent is collapsed. Parents and roots always show.
  const visible = useMemo(
    () => ordered.filter((w) => !(w.parentId && collapsed.has(w.parentId))),
    [ordered, collapsed],
  );

  // Three layouts: `beside` (tablet `expanded`, label to the right, wide),
  // `caption` (host `showLabels` — prototype Material-3 centred rail), or
  // `icon` (default icon-only). `caption` is the chat default.
  const layout: RailLayout = expanded ? 'beside' : showLabels ? 'caption' : 'icon';

  if (layout === 'caption') {
    return (
      <CaptionRail
        ordered={ordered}
        childrenByParent={childrenByParent}
        parentIds={parentIds}
        collapsed={collapsed}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        onToggleCollapse={onToggleCollapse}
        className={className}
      />
    );
  }

  const width = layout === 'beside' ? 'w-48' : 'w-16';

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

// =============================================================================
// Caption layout — the approved Material-3 prototype (chat host's rail).
// =============================================================================

function CaptionRail({
  ordered,
  childrenByParent,
  parentIds,
  collapsed,
  activeWorkspaceId,
  onSelectWorkspace,
  onToggleCollapse,
  className,
}: {
  ordered: Workspace[];
  childrenByParent: Map<string, Workspace[]>;
  parentIds: Set<string>;
  collapsed: Set<string>;
  activeWorkspaceId: string | null;
  onSelectWorkspace?: (w: Workspace) => void;
  onToggleCollapse?: (parentId: string) => void;
  className: string;
}): JSX.Element {
  // Only top-level (root) workspaces render as caption tiles; children render
  // as indented horizontal rows beneath their parent.
  const roots = ordered.filter((w) => !w.parentId);

  return (
    <nav
      className={`chat-scrollbar flex h-full w-[84px] flex-col items-center gap-3 overflow-y-auto border-r border-border-dark bg-background-dark pt-4 ${className}`}
      aria-label="Workspace rail"
      data-testid="workspace-rail"
      data-expanded="false"
      data-labelled="true"
      data-layout="caption"
    >
      {roots.map((ws, idx) => {
        const isHome = ws.kind === 'home';
        const isParent = parentIds.has(ws.id);
        const kids = childrenByParent.get(ws.id) ?? [];
        const isCollapsed = collapsed.has(ws.id);
        return (
          <div key={ws.id} className="flex w-full flex-col items-center gap-3">
            {/* A divider after Home separates the personal landing from teams. */}
            {isHome && (
              <CaptionTile
                workspace={ws}
                isActive={activeWorkspaceId === ws.id}
                isParent={false}
                isCollapsed={false}
                onSelect={onSelectWorkspace}
                onToggleCollapse={onToggleCollapse}
              />
            )}
            {isHome ? (
              <span aria-hidden="true" className="h-[1px] w-8 bg-border-dark/30" />
            ) : (
              <CaptionTile
                workspace={ws}
                isActive={activeWorkspaceId === ws.id}
                isParent={isParent}
                isCollapsed={isCollapsed}
                onSelect={onSelectWorkspace}
                onToggleCollapse={onToggleCollapse}
              />
            )}
            {/* Parent's sub-teams, when expanded, as indented horizontal rows. */}
            {isParent && !isCollapsed && kids.length > 0 && (
              <div className="mt-2 flex w-full flex-col gap-3 pl-4">
                {kids.map((child) => (
                  <CaptionChildRow
                    key={child.id}
                    workspace={child}
                    isActive={activeWorkspaceId === child.id}
                    onSelect={onSelectWorkspace}
                  />
                ))}
              </div>
            )}
            {idx === roots.length - 1 && roots.length === 0 && <RailEmpty />}
          </div>
        );
      })}
      {roots.length === 0 && <RailEmpty />}
    </nav>
  );
}

/** A top-level caption tile: circular avatar + small caption beneath. */
function CaptionTile({
  workspace,
  isActive,
  isParent,
  isCollapsed,
  onSelect,
  onToggleCollapse,
}: {
  workspace: Workspace;
  isActive: boolean;
  isParent: boolean;
  isCollapsed: boolean;
  onSelect?: (w: Workspace) => void;
  onToggleCollapse?: (parentId: string) => void;
}): JSX.Element {
  const initials = workspace.initials ?? deriveInitials(workspace.name);
  const isHome = workspace.kind === 'home';
  const hasGlyph = workspace.icon != null || workspace.avatar != null;
  const hasUnread = (workspace.unreadCount ?? 0) > 0;
  const showChevron = isParent && !!onToggleCollapse;

  // Circle treatment: Home + active/parent use the brand accent; plain
  // teams use the neutral surface chip.
  const circleClass = isHome
    ? 'bg-white/5 border border-border-dark text-text-secondary-dark'
    : isParent || isActive
      ? 'bg-primary/10 text-primary border border-primary/30'
      : 'bg-white/5 text-text-secondary-dark border border-border-dark hover:border-primary';

  const captionClass = isParent
    ? 'text-[10px] font-medium text-primary'
    : isActive
      ? 'text-[10px] text-center leading-tight max-w-[60px] text-text-primary-dark'
      : 'text-[10px] text-center leading-tight max-w-[60px] text-text-secondary-dark group-hover:text-text-primary-dark';

  // Indicator dot — mention > unread > presence (§8.2).
  const dot = workspace.hasMentions ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-dark bg-rose-500"
      data-testid={`workspace-mention-${workspace.id}`}
    />
  ) : hasUnread ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface-dark bg-primary"
      data-testid={`workspace-unread-${workspace.id}`}
    />
  ) : workspace.presence ? (
    <span
      aria-hidden="true"
      className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-surface-dark ${CAPTION_PRESENCE_DOT[workspace.presence]}`}
      data-testid={`workspace-presence-${workspace.id}`}
    />
  ) : null;

  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        onClick={() => onSelect?.(workspace)}
        data-testid={`workspace-row-${workspace.id}`}
        data-active={isActive ? 'true' : 'false'}
        data-nested="false"
        data-kind={workspace.kind ?? 'team'}
        title={workspace.tooltip ?? workspace.name}
        aria-current={isActive ? 'page' : undefined}
        aria-label={
          hasUnread ? `${workspace.name}, ${workspace.unreadCount} unread` : workspace.name
        }
        className="group flex flex-col items-center gap-1"
      >
        <span className="relative">
          <span
            aria-hidden="true"
            className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
              hasGlyph ? 'text-base' : 'text-[12px] font-bold uppercase'
            } ${circleClass}`}
          >
            {workspace.icon ?? workspace.avatar ?? initials}
          </span>
          {dot}
        </span>
        <span className={captionClass}>{workspace.name}</span>
      </button>
      {showChevron && (
        <button
          type="button"
          onClick={() => onToggleCollapse?.(workspace.id)}
          data-testid={`workspace-collapse-${workspace.id}`}
          aria-label={isCollapsed ? `Expand ${workspace.name}` : `Collapse ${workspace.name}`}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'Expand sub-teams' : 'Collapse sub-teams'}
          className="absolute -right-2 top-0 rounded p-0.5 text-[14px] text-text-secondary-dark transition hover:text-text-primary-dark"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
          />
        </button>
      )}
    </div>
  );
}

/** A nested sub-team rendered as an indented horizontal row in the rail. */
function CaptionChildRow({
  workspace,
  isActive,
  onSelect,
}: {
  workspace: Workspace;
  isActive: boolean;
  onSelect?: (w: Workspace) => void;
}): JSX.Element {
  const initials = workspace.initials ?? deriveInitials(workspace.name);
  const hasGlyph = workspace.icon != null || workspace.avatar != null;
  const hasUnread = (workspace.unreadCount ?? 0) > 0;

  const avatarClass = isActive
    ? 'bg-primary/20 border-2 border-primary active-glow text-primary'
    : 'bg-white/5 text-text-secondary-dark border border-border-dark group-hover/item:border-primary';

  const dot = workspace.hasMentions ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-surface-dark bg-rose-500"
      data-testid={`workspace-mention-${workspace.id}`}
    />
  ) : hasUnread ? (
    <span
      aria-hidden="true"
      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2 border-surface-dark bg-primary"
      data-testid={`workspace-unread-${workspace.id}`}
    />
  ) : workspace.presence ? (
    <span
      aria-hidden="true"
      className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-surface-dark ${CAPTION_PRESENCE_DOT[workspace.presence]}`}
      data-testid={`workspace-presence-${workspace.id}`}
    />
  ) : null;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(workspace)}
      data-testid={`workspace-row-${workspace.id}`}
      data-active={isActive ? 'true' : 'false'}
      data-nested="true"
      data-kind={workspace.kind ?? 'team'}
      title={workspace.tooltip ?? workspace.name}
      aria-current={isActive ? 'page' : undefined}
      aria-label={
        hasUnread ? `${workspace.name}, ${workspace.unreadCount} unread` : workspace.name
      }
      className="group/item ml-4 flex w-full cursor-pointer items-center gap-3 rounded-lg p-1 hover:bg-white/5"
    >
      <span className="relative shrink-0">
        <span
          aria-hidden="true"
          className={`flex h-8 w-8 items-center justify-center rounded-full ${
            hasGlyph ? 'text-sm' : 'text-[9px] font-bold uppercase'
          } ${avatarClass}`}
        >
          {workspace.icon ?? workspace.avatar ?? initials}
        </span>
        {dot}
      </span>
      <span
        className={`truncate text-[10px] ${
          isActive
            ? 'font-medium text-text-primary-dark'
            : 'text-text-secondary-dark group-hover/item:text-text-primary-dark'
        }`}
      >
        {workspace.name}
      </span>
    </button>
  );
}

// =============================================================================
// Icon / beside layouts (other callers) — preserved Crewly-token styling.
// =============================================================================

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
  const beside = layout === 'beside';
  // Parents render a collapse chevron only when the host wires collapse.
  const showChevron = isParent && !!onToggleCollapse;

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
      title={workspace.tooltip ?? workspace.name}
      className={[
        'group relative mx-2 flex items-center gap-3 rounded-lg px-2 py-2 pr-4 text-left transition',
        isActive
          ? 'bg-primary/15 text-text-primary-dark ring-1 ring-primary/50'
          : 'text-text-secondary-dark hover:bg-surface-dark hover:text-text-primary-dark',
        isNested ? 'ml-4' : '',
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
            'flex h-9 w-9 items-center justify-center rounded-lg font-semibold',
            hasGlyph ? 'text-lg' : 'text-sm uppercase',
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

      {beside && (
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-9">
          {workspace.name}
        </span>
      )}
    </button>
  );

  if (!showChevron) return rowButton;
  return (
    <div className="relative">
      {rowButton}
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
