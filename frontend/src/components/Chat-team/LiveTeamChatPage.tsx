/**
 * LiveTeamChatPage — Phase C live wire of the Slack-like 3-panel shell.
 *
 * This is the production-path companion to the mock-only `TeamChatPage`.
 * It composes the same Phase B primitives from `@crewly/chat-ui` but
 * drives them off real BE data via the Phase C derivation hooks:
 *
 *   useChannels()          — full channel list from /api/chat/channels
 *   useObservedWorkspaces  — derive WorkspaceRail entries (one per teamId)
 *   useGroupedChannels     — partition into Channels vs Direct Messages
 *   useMessages            — timeline + WS subscription per active channel
 *   useSendMessage         — POST /api/chat/channels/:id/messages with
 *                            mentions[] + threadId per SEALED §3.2
 *
 * Acceptance criteria (Phase C):
 *  - MentionComposer emits a string[] of mention IDs on send
 *    (member-id or team-id), never null.
 *  - Thread pane reads `threadId` from incoming message DTOs; replies
 *    POST with `threadId: <root msg id>`. 400 errors surface as a
 *    UI toast.
 *  - ConversationListPanel groups by Channels vs Direct Messages,
 *    partitioned on the wire `type` field.
 *  - Channel rows render `#`, DM rows render avatar + presence dot
 *    (delegated to ConversationListPanel — already correct).
 *  - WorkspaceRail renders one entry per observed teamId.
 *
 * Visuals follow the approved Material-3 prototype: a frosted header with
 * action icons, error-tinted inactive banner, and the chat surface tokens.
 *
 * @module components/Chat-team/LiveTeamChatPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Home,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Search,
  Info,
  Plus,
  X,
} from 'lucide-react';
import {
  ChatAPIProvider,
  ConversationListPanel,
  MentionComposer,
  MessageThread,
  WorkspaceRail,
  useChannels,
  useGroupedChannels,
  useMessages,
  useSendMessage,
  useChatApiClient,
  selectThreadReplies,
  type ChatApiClient,
  type ChatApiError,
  type Channel,
  type ChatPresenceStatus,
  type ConversationGroup,
  type ConversationRow,
  type MentionComposerSendPayload,
  type MentionTarget,
  type Message,
  type Workspace,
} from '@crewly/chat-ui';
import {
  NoChannelsEmptyState,
  NoMessagesEmptyState,
  NoTeamsEmptyState,
} from './EmptyStates';
import { ChatErrorToast } from './ChatErrorToast';
import { CreateGroupModal } from './CreateGroupModal';
import { usePinnedChats } from '../../hooks/usePinnedChats';
import { ORCHESTRATOR_SESSION, ORCHESTRATOR_LABEL } from '../../utils/team-chat.utils';

/** Rail identifier for the Home (default) entry. */
export const HOME_ID = 'home';

/** localStorage key for the rail's collapsed parent-team ids. */
const RAIL_COLLAPSE_KEY = 'crewly-chat-rail-collapsed';

/** Build the rail workspace id for a team (so deep-links can target it). */
export function teamRailId(teamId: string): string {
  return `team:${teamId}`;
}

/**
 * A team as the chat rail needs it: identity + the sessions of its lead(s)
 * and all members (for the per-team huddle + lead-first roster). Host-derived.
 */
export interface ChatTeam {
  id: string;
  name: string;
  /** Session names of the team lead(s) — sorted first in the roster. */
  leaderSessions: string[];
  /** Session names of every member of the team. */
  memberSessions: string[];
  /**
   * Parent team id, when this team is a sub-team. Drives the rail's nested
   * parent → sub-team grouping. Undefined for a top-level (standalone) team.
   */
  parentTeamId?: string;
}

export interface LiveTeamChatPageProps {
  /** OSS backend base URL. Required when no `client` is injected. */
  backendURL?: string;
  /** Optional bearer token (Portal injects Cloud-scoped, OSS uses local). */
  authToken?: string;
  /**
   * Escape hatch for tests / Storybook — supply a `MockChatApiClient`
   * to drive the page without hitting a real backend. When set,
   * `backendURL` is ignored.
   */
  client?: ChatApiClient;
  /**
   * Optional team-id → display-name map. Phase C lacks a team directory
   * endpoint, so we let the host inject names; missing entries fall
   * back to the raw teamId so the rail is never blank.
   */
  teamLabels?: Record<string, string>;
  /**
   * Pool of mention targets for the composer popover. The host (Portal
   * or OSS) computes this from the team directory. Phase C doesn't
   * derive it from `useChannels` — keeps the wire test orthogonal.
   */
  mentionables?: MentionTarget[];
  /** Initial workspace selection. Defaults to the first observed teamId. */
  initialWorkspaceId?: string | null;
  /** Initial conversation selection. Defaults to the first row. */
  initialConversationId?: string | null;
  /**
   * Full agent directory (host-supplied). Every agent is shown in the DM
   * list — online or offline — even before a DM channel exists, so the user
   * can reach any agent. Agents that already have a real DM channel are
   * de-duplicated against it.
   */
  directoryAgents?: DirectoryAgentEntry[];
  /**
   * Teams for the workspace rail. Each rail icon = one team; selecting it
   * scopes the list to that team's huddle + lead + members. Host-derived
   * (lead detection from team config). When empty the rail shows just
   * Home + the orchestrator.
   */
  teams?: ChatTeam[];
  /**
   * Ensure (find-or-create) a DM channel for an agent session, returning the
   * resolved channel id. Called when the user opens a directory agent that
   * doesn't have a channel yet. Host-supplied to keep this component
   * transport-agnostic.
   */
  onEnsureDm?: (agentSession: string) => Promise<string>;
}

/** One agent in the host-supplied directory shown in the DM list. */
export interface DirectoryAgentEntry {
  agentSession: string;
  name: string;
  presence?: ChatPresenceStatus;
  /** Team this agent belongs to — used to group the DM list by team. */
  teamName?: string;
  /** Agent's role (e.g. `content-strategist`) — shown under the name. */
  role?: string;
}

export function LiveTeamChatPage({
  backendURL,
  authToken,
  client,
  mentionables = [],
  initialWorkspaceId,
  initialConversationId,
  directoryAgents = [],
  teams = [],
  onEnsureDm,
}: LiveTeamChatPageProps): JSX.Element {
  return (
    <ChatAPIProvider
      mode="real"
      backendURL={backendURL}
      authToken={authToken}
      client={client}
    >
      <LiveTeamChatPageBody
        mentionables={mentionables}
        initialWorkspaceId={initialWorkspaceId}
        initialConversationId={initialConversationId}
        directoryAgents={directoryAgents}
        teams={teams}
        onEnsureDm={onEnsureDm}
      />
    </ChatAPIProvider>
  );
}

// ---------------------------------------------------------------------------
// Body — separated from the Provider wrapper so hooks can read the client.
// ---------------------------------------------------------------------------

interface BodyProps {
  mentionables: MentionTarget[];
  initialWorkspaceId?: string | null;
  initialConversationId?: string | null;
  directoryAgents: DirectoryAgentEntry[];
  teams: ChatTeam[];
  onEnsureDm?: (agentSession: string) => Promise<string>;
}

/** Prefix marking a synthetic DM row for a directory agent without a channel. */
const VIRTUAL_DM_PREFIX = 'agent:';

/** Prefix marking a Slack-bridged channel id (`slack-<chan>-<ts>`). */
const SLACK_ID_PREFIX = 'slack-';

/**
 * Stable pin key for a row: channel id for Slack threads / groups (each is its
 * own conversation), agent session for plain agent DMs. Slack threads must NOT
 * key by session — they all share the orchestrator session and would collapse.
 */
function pinKeyOf(row: ConversationRow): string {
  if (row.id.startsWith(SLACK_ID_PREFIX)) return row.id;
  return row.agentSession || row.id;
}

/**
 * Friendlier label for a Slack thread. New threads are named after their first
 * message (backend), so a non-`slack-…` title is used as-is. Legacy threads are
 * titled by the synthesized `slack-<channelId>-<tsSeconds>-<tsMicros>` id — all
 * threads in one channel share the channelId, so we surface the thread's
 * start time to make them distinguishable (was: identical "Slack · <channel>").
 */
function prettySlackTitle(raw: string): string {
  const m = raw.match(/^slack-([^-]+)-(\d{6,})/);
  if (!m) return raw; // backend-named (first-message snippet) — already readable
  const tsSeconds = Number(m[2]);
  if (Number.isFinite(tsSeconds) && tsSeconds > 0) {
    const d = new Date(tsSeconds * 1000);
    if (!Number.isNaN(d.getTime())) {
      const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `Slack thread · ${date} ${time}`;
    }
  }
  return `Slack · ${m[1]}`;
}

/** Flatten all rows across groups + nested sub-groups, in render order. */
function flattenRows(groups: ConversationGroup[]): ConversationRow[] {
  return groups.flatMap((g) => [...g.rows, ...flattenRows(g.subGroups ?? [])]);
}

function LiveTeamChatPageBody({
  mentionables,
  initialWorkspaceId,
  initialConversationId,
  directoryAgents,
  teams,
  onEnsureDm,
}: BodyProps): JSX.Element {
  const { channels, loading: channelsLoading, error: channelsError, refresh } = useChannels();
  const client = useChatApiClient();
  const pinnedChats = usePinnedChats();
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  // Merge the agent directory into the channel list so EVERY agent appears in
  // the DM list — even offline ones with no channel yet. Agents that already
  // have a real DM channel win; the rest get a synthetic row whose DM is
  // created on first open (see handleSelectConversation).
  const mergedChannels = useMemo<Channel[]>(() => {
    const dmSessions = new Set(
      channels
        .filter((c) => (c.type ?? 'dm') === 'dm' && c.agentSession)
        .map((c) => c.agentSession),
    );
    const synthetic: Channel[] = directoryAgents
      .filter((a) => a.agentSession && !dmSessions.has(a.agentSession))
      .map((a) => ({
        id: `${VIRTUAL_DM_PREFIX}${a.agentSession}`,
        agentSession: a.agentSession,
        name: a.name,
        // Surface the agent's role under their name in the roster.
        purpose: a.role,
        createdAt: '',
        type: 'dm' as const,
        // Channel presence is the narrower online|busy|offline vocabulary.
        presence:
          a.presence === 'online' ? 'online' : a.presence === 'busy' ? 'busy' : 'offline',
      }));
    return synthetic.length > 0 ? [...channels, ...synthetic] : channels;
  }, [channels, directoryAgents]);

  // Workspace rail: Home → one icon per team. Home is the personal/cross-cutting
  // landing (orchestrator + pinned + huddles + Slack); each team icon scopes the
  // center column to that team's huddle + lead + members. The orchestrator has
  // no dedicated icon — it's reachable from Home (default) and via its own
  // "Orchestrator Team" team, so a separate icon was redundant.
  const workspaces = useMemo<Workspace[]>(() => {
    const home: Workspace = {
      id: HOME_ID,
      name: 'Home',
      kind: 'home',
      icon: <Home className="h-5 w-5" />,
      tooltip: 'Home — orchestrator, pinned chats & huddles',
    };
    // Only nest under a parent that is itself a present team in the rail —
    // a parentTeamId pointing at a missing/hidden team renders as a clean root
    // (defensive against stale config), and self-references are ignored.
    const presentIds = new Set(teams.map((t) => t.id));
    const teamItems: Workspace[] = teams.map((t) => {
      const hasParent =
        !!t.parentTeamId && t.parentTeamId !== t.id && presentIds.has(t.parentTeamId);
      return {
        id: teamRailId(t.id),
        name: t.name,
        kind: 'team' as const,
        ...(hasParent ? { parentId: teamRailId(t.parentTeamId!) } : {}),
      };
    });
    return [home, ...teamItems];
  }, [teams]);

  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? null,
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  // Home is the default landing.
  const resolvedWorkspaceId = activeWorkspaceId ?? HOME_ID;

  // Collapsed parent-team rail tiles (their sub-teams are hidden). Persisted so
  // the user's collapse choices survive reloads; default is everything expanded.
  const [collapsedParentIds, setCollapsedParentIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RAIL_COLLAPSE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
      }
    } catch {
      // ignore — collapse state is best-effort
    }
    return [];
  });

  const toggleRailCollapse = useCallback((parentId: string) => {
    setCollapsedParentIds((prev) => {
      const next = prev.includes(parentId)
        ? prev.filter((id) => id !== parentId)
        : [...prev, parentId];
      try {
        localStorage.setItem(RAIL_COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // ignore — best-effort persistence
      }
      return next;
    });
  }, []);

  // Deep-link safety: if the selected workspace is a sub-team whose parent is
  // collapsed (e.g. via `?team=`), auto-expand the parent so the active tile is
  // visible in the rail rather than hidden.
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === resolvedWorkspaceId);
    const parentId = ws?.parentId;
    if (!parentId) return;
    setCollapsedParentIds((prev) => {
      if (!prev.includes(parentId)) return prev;
      const next = prev.filter((id) => id !== parentId);
      try {
        localStorage.setItem(RAIL_COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // ignore — best-effort persistence
      }
      return next;
    });
  }, [resolvedWorkspaceId, workspaces]);

  // All conversations, unscoped — re-bucketed per rail selection below.
  const allGroups = useGroupedChannels(mergedChannels, { workspaceId: undefined });
  const allChannelRows = useMemo(
    () => allGroups.find((g) => g.id === 'channels')?.rows ?? [],
    [allGroups],
  );
  const allHuddleRows = useMemo(
    () => allGroups.find((g) => g.id === 'huddles')?.rows ?? [],
    [allGroups],
  );
  const allDmRows = useMemo(
    () => allGroups.find((g) => g.id === 'dms')?.rows ?? [],
    [allGroups],
  );

  // The orchestrator DM row — Home's default top conversation + the orc rail
  // item. Exclude Slack-bridged threads (they share the orc session but are
  // their own conversations).
  const orcRow = useMemo(
    () =>
      allDmRows.find(
        (r) => r.agentSession === ORCHESTRATOR_SESSION && !r.id.startsWith(SLACK_ID_PREFIX),
      ),
    [allDmRows],
  );

  // Slack-bridged threads (all owned by orc) — surfaced inside the Orchestrator
  // conversation as a thread list rather than 32 separate sidebar rows.
  const slackThreads = useMemo(
    () =>
      allDmRows
        .filter((r) => r.id.startsWith(SLACK_ID_PREFIX))
        .map((r) => ({ ...r, title: prettySlackTitle(r.title) })),
    [allDmRows],
  );

  // channel-id → teamId, so a team's huddle (its all-members channel) is findable
  // from the (teamId-less) conversation rows.
  const channelTeamId = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of mergedChannels) {
      if ((c.type ?? 'dm') === 'channel' && c.teamId) m.set(c.id, c.teamId);
    }
    return m;
  }, [mergedChannels]);

  // Conversation groups for the SELECTED rail item.
  const groups = useMemo<ConversationGroup[]>(() => {
    const sel = resolvedWorkspaceId;

    // Home: the personal landing — Pinned (if any) → Direct messages (the full
    // agent roster, orc first, presence-sorted) → Group chats. Surfacing the
    // whole DM directory keeps the panel populated and every agent one click
    // away (it used to show only orc + a big empty void). Slack threads are NOT
    // listed here — they belong to the orchestrator (see slackThreads below).
    if (sel === HOME_ID) {
      const roleBySession = new Map(
        directoryAgents.map((a) => [a.agentSession, a.role] as const),
      );
      const withRole = (r: ConversationRow): ConversationRow => {
        const role = r.agentSession ? roleBySession.get(r.agentSession) : undefined;
        return role ? { ...r, subtitle: role } : r;
      };
      // Real DMs + synthetic directory rows; exclude Slack-thread channels.
      const agentDmRows = allDmRows.filter((r) => r.agentSession && !r.id.startsWith(SLACK_ID_PREFIX));

      const pinnedRows = agentDmRows
        .filter((r) => r.agentSession !== ORCHESTRATOR_SESSION && pinnedChats.isPinned(pinKeyOf(r)))
        .map(withRole);
      const pinnedKeys = new Set(pinnedRows.map((r) => pinKeyOf(r)));

      // Direct messages excludes pinned agents (shown above) to avoid dupes;
      // the orchestrator always appears here, first.
      // Orchestrator first; then online → busy → offline; then most-recent; then name.
      const presenceRank = (p?: ChatPresenceStatus): number =>
        p === 'online' ? 0 : p === 'busy' ? 1 : p === 'offline' ? 2 : 3;
      const dmRows = [...agentDmRows]
        .filter((r) => r.agentSession === ORCHESTRATOR_SESSION || !pinnedKeys.has(pinKeyOf(r)))
        .sort((a, b) => {
          if (a.agentSession === ORCHESTRATOR_SESSION) return -1;
          if (b.agentSession === ORCHESTRATOR_SESSION) return 1;
          const pr = presenceRank(a.presence) - presenceRank(b.presence);
          if (pr !== 0) return pr;
          const at = a.lastMessageAt ?? '';
          const bt = b.lastMessageAt ?? '';
          if (at !== bt) return bt.localeCompare(at);
          return a.title.localeCompare(b.title);
        })
        .map(withRole);

      const out: ConversationGroup[] = [];
      if (pinnedRows.length > 0) out.push({ id: 'pinned', label: 'Pinned', rows: pinnedRows });
      if (dmRows.length > 0) out.push({ id: 'dms', label: 'Direct messages', rows: dmRows });
      if (allHuddleRows.length > 0) out.push({ id: 'huddles', label: 'Group chats', rows: allHuddleRows });
      return out;
    }

    // A team is selected: team huddle (all-members channel) → lead(s) → members.
    const team = teams.find((t) => `team:${t.id}` === sel);
    if (!team) return orcRow ? [{ id: 'pinned', label: ORCHESTRATOR_LABEL, rows: [orcRow] }] : [];
    const leadSet = new Set(team.leaderSessions);
    const memberSet = new Set(team.memberSessions);
    // session → role, so every member row shows the agent's role under their
    // name (uniform whether or not they already have a real DM channel).
    const roleBySession = new Map(
      directoryAgents.map((a) => [a.agentSession, a.role] as const),
    );
    const huddleRows = allChannelRows.filter((r) => channelTeamId.get(r.id) === team.id);
    const memberRows = allDmRows
      .filter(
        (r) =>
          r.agentSession &&
          r.agentSession !== ORCHESTRATOR_SESSION &&
          memberSet.has(r.agentSession),
      )
      .map((r) => {
        const role = r.agentSession ? roleBySession.get(r.agentSession) : undefined;
        return role ? { ...r, subtitle: role } : r;
      });
    // Single Members list, leads first, each lead tagged with a "Lead" badge
    // so the roster reads as one Slack-style list rather than split sections.
    const leads = memberRows
      .filter((r) => r.agentSession && leadSet.has(r.agentSession))
      .map((r) => ({ ...r, badge: 'Lead' }));
    const rest = memberRows.filter((r) => !(r.agentSession && leadSet.has(r.agentSession)));
    const out: ConversationGroup[] = [];
    if (huddleRows.length > 0) out.push({ id: 'team-huddle', label: 'Team huddle', rows: huddleRows });
    const members = [...leads, ...rest];
    if (members.length > 0) out.push({ id: 'team-members', label: 'Members', rows: members });
    return out;
  }, [
    resolvedWorkspaceId,
    teams,
    orcRow,
    allDmRows,
    allHuddleRows,
    allChannelRows,
    channelTeamId,
    pinnedChats,
    directoryAgents,
  ]);

  const totalRows = useMemo(
    () => groups.reduce((acc, g) => acc + g.rows.length, 0),
    [groups],
  );

  // Auto-select the first available conversation when none is set. Skip
  // virtual directory rows (no real channel yet) so the thread/composer
  // never operate on a synthetic id — those are only entered via an explicit
  // click, which creates the DM first.
  const resolvedConversationId =
    activeConversationId ??
    flattenRows(groups).find((r) => !r.id.startsWith(VIRTUAL_DM_PREFIX))?.id ??
    null;

  const handleSelectWorkspace = useCallback((ws: Workspace) => {
    setActiveWorkspaceId(ws.id);
    // Drop the prior conversation so the auto-select picks a fresh one
    // from the new workspace's groups on next render.
    setActiveConversationId(null);
  }, []);

  const handleSelectConversation = useCallback(
    async (row: ConversationRow) => {
      // Virtual directory row (no channel yet): create the DM on first open,
      // refresh, then select the resolved real channel.
      if (row.id.startsWith(VIRTUAL_DM_PREFIX) && row.agentSession && onEnsureDm) {
        const channelId = await onEnsureDm(row.agentSession);
        await refresh();
        setActiveConversationId(channelId);
        return;
      }
      setActiveConversationId(row.id);
    },
    [onEnsureDm, refresh],
  );

  // "拉群" — create a multi-agent group chat, then refresh the channel list
  // and jump into it. Huddles are workspace-agnostic so they surface in the
  // current workspace's "Group Chats" section immediately.
  const handleCreateGroup = useCallback(
    async (name: string, memberSessions: string[]) => {
      const huddle = await client.createHuddle({ name, memberSessions });
      await refresh();
      setActiveConversationId(huddle.id);
      setShowCreateGroup(false);
    },
    [client, refresh],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === resolvedWorkspaceId) ?? null,
    [workspaces, resolvedWorkspaceId],
  );
  const activeConversation = useMemo(
    () =>
      flattenRows(groups).find((r) => r.id === resolvedConversationId) ??
      // A Slack thread can be the active conversation (opened from the orc
      // panel) even though it's not in the sidebar groups.
      slackThreads.find((r) => r.id === resolvedConversationId),
    [groups, slackThreads, resolvedConversationId],
  );

  // §9.1 — no workspaces visible at all (e.g. brand-new account).
  if (workspaces.length === 0 && !channelsLoading) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-background-dark"
        data-testid="team-chat-page"
      >
        <NoTeamsEmptyState />
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full bg-background-dark"
      data-testid="team-chat-page"
      data-loading={channelsLoading ? 'true' : 'false'}
      data-error={channelsError ? 'true' : 'false'}
    >
      {/* The rail always carries Home (the primary nav), so it always renders. */}
      {workspaces.length > 0 && (
        <WorkspaceRail
          workspaces={workspaces}
          activeWorkspaceId={resolvedWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
          showLabels
          collapsedParentIds={collapsedParentIds}
          onToggleCollapse={toggleRailCollapse}
        />
      )}

      <ConversationListPanel
        workspaceName={activeWorkspace?.name}
        groups={groups}
        activeConversationId={resolvedConversationId}
        onSelectConversation={handleSelectConversation}
        isPinned={(row) => pinnedChats.isPinned(pinKeyOf(row))}
        onTogglePin={(row) => pinnedChats.toggle(pinKeyOf(row))}
        // The Slack section can hold many threads from one channel — start it
        // collapsed so it doesn't flood the list (user can expand + it persists).
        defaultCollapsedGroupIds={['slack']}
        headerAction={
          <button
            type="button"
            onClick={() => setShowCreateGroup(true)}
            className="flex h-6 w-6 items-center justify-center rounded bg-surface-dark text-text-secondary-dark transition hover:text-primary"
            data-testid="new-group-button"
            title="Create a multi-agent group chat"
            aria-label="Create a multi-agent group chat"
          >
            <Plus size={16} />
          </button>
        }
        emptyState={
          activeWorkspace && totalRows === 0 ? (
            <NoChannelsEmptyState teamName={activeWorkspace.name} />
          ) : undefined
        }
      />

      <LiveTeamChatRightPanel
        conversation={activeConversation}
        mentionables={mentionables}
        slackThreads={slackThreads}
        orcRow={orcRow}
        onSelectConversation={handleSelectConversation}
      />

      {showCreateGroup && (
        <CreateGroupModal
          onClose={() => setShowCreateGroup(false)}
          onCreate={handleCreateGroup}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel — drives MessageThread + MentionComposer off useMessages +
// useSendMessage with mentions[] + threadId wired to the BE.
// ---------------------------------------------------------------------------

interface RightPanelProps {
  conversation: ConversationRow | undefined;
  mentionables: MentionTarget[];
  /** Slack-bridged threads (all orc-owned), surfaced inside the orc conversation. */
  slackThreads: ConversationRow[];
  /** The orchestrator conversation row (for the "back to Orchestrator" action). */
  orcRow: ConversationRow | undefined;
  onSelectConversation: (row: ConversationRow) => void;
}

function LiveTeamChatRightPanel({
  conversation,
  mentionables,
  slackThreads,
  orcRow,
  onSelectConversation,
}: RightPanelProps): JSX.Element {
  // No conversation selected — happens on first render of an empty
  // workspace, or transiently after a workspace switch.
  if (!conversation) {
    return (
      <section
        className="flex flex-1 items-center justify-center bg-background-dark text-sm text-text-secondary-dark"
        data-testid="team-chat-right-panel"
        aria-label="Conversation thread"
      >
        Select a conversation from the list to start chatting.
      </section>
    );
  }

  return (
    <LiveTeamChatRightPanelInner
      conversation={conversation}
      mentionables={mentionables}
      slackThreads={slackThreads}
      orcRow={orcRow}
      onSelectConversation={onSelectConversation}
    />
  );
}

function LiveTeamChatRightPanelInner({
  conversation,
  mentionables,
  slackThreads,
  orcRow,
  onSelectConversation,
}: {
  conversation: ConversationRow;
  mentionables: MentionTarget[];
  slackThreads: ConversationRow[];
  orcRow: ConversationRow | undefined;
  onSelectConversation: (row: ConversationRow) => void;
}): JSX.Element {
  const { messages } = useMessages(conversation.id);
  const { send, error: sendError, reset: resetSendError } = useSendMessage();

  // Slack-style thread panel state — `activeThreadRootId` is the root
  // message id whose thread panel is open (null = closed). It doubles as
  // the compose target: when the panel is open, replies POST with
  // `threadId = activeThreadRootId`; top-level posts have it null.
  const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(null);

  // Reset the open thread whenever the conversation changes — a thread root
  // from one channel is meaningless in another.
  useEffect(() => {
    setActiveThreadRootId(null);
  }, [conversation.id]);

  // Surface validation_error and payload_too_large 400/413s as a toast.
  // Network errors (code 'network_error') get the same treatment so the
  // user always knows the send failed; the timeline already shows the
  // optimistic bubble in `failed` state via the client's emit path.
  const toast = useMemo(() => buildToastMessage(sendError), [sendError]);

  const recipientName = conversation.kind === 'dm' ? conversation.title : undefined;

  // Slack threads all belong to the orchestrator, so they're navigated from
  // INSIDE the orc conversation (here) rather than the sidebar.
  const isSlackThread = conversation.id.startsWith(SLACK_ID_PREFIX);
  const isOrc = conversation.agentSession === ORCHESTRATOR_SESSION && !isSlackThread;
  const showSlackBar = (isOrc || isSlackThread) && slackThreads.length > 0;
  const [slackOpen, setSlackOpen] = useState(false);

  // The root message of the open thread (found in the live timeline) + its
  // replies derived live so a WS-delivered reply shows in the panel instantly.
  const threadRootMessage = useMemo<Message | undefined>(
    () => (activeThreadRootId ? messages.find((m) => m.id === activeThreadRootId) : undefined),
    [messages, activeThreadRootId],
  );
  const threadReplies = useMemo<Message[]>(
    () => (activeThreadRootId ? selectThreadReplies(messages, activeThreadRootId) : []),
    [messages, activeThreadRootId],
  );

  const handleSend = useCallback(
    async (payload: MentionComposerSendPayload) => {
      // Map MentionTarget[] → string[] of IDs (member-id or team-id) per
      // SEALED §3.2 wire shape. Empty array on no mentions; never null.
      const mentionIds = payload.mentions.map((m) => m.id);
      try {
        await send(conversation.id, {
          content: payload.content,
          mentions: mentionIds,
          threadId: activeThreadRootId ?? undefined,
        });
      } catch {
        // Error is captured in `sendError`; the toast renders below.
        // Swallow here so the composer doesn't double-report.
      }
    },
    [conversation.id, send, activeThreadRootId],
  );

  const handleOpenThread = useCallback((m: Message) => {
    setActiveThreadRootId(m.id);
  }, []);

  const handleCloseThread = useCallback(() => {
    setActiveThreadRootId(null);
  }, []);

  const threadOpen = activeThreadRootId !== null;

  return (
    <section
      className="flex flex-1 bg-background-dark"
      data-testid="team-chat-right-panel"
      aria-label={`Conversation with ${conversation.title}`}
      data-thread-active={threadOpen ? 'true' : 'false'}
    >
      {/* Main message column — shrinks to make room for the thread panel. */}
      <div className="flex min-w-0 flex-1 flex-col bg-background-dark">
        <header className="flex items-center justify-between gap-4 border-b border-border-dark bg-background-dark/30 px-6 py-3 backdrop-blur-md">
          <div className="min-w-0 leading-tight">
            <h2 className="truncate text-base font-bold text-text-primary-dark">
              {conversation.kind === 'channel'
                ? `#${conversation.title.replace(/^#+\s*/, '')}`
                : conversation.title}
            </h2>
            {conversation.subtitle && (
              <p className="truncate text-[11px] text-text-secondary-dark">
                {conversation.subtitle}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Header actions. (A "call" affordance was dropped — there's
                nothing to dial in an agent chat.) Search/info are placeholders
                for now until wired to in-conversation search + details. */}
            <HeaderActionButton label="Search">
              <Search size={18} />
            </HeaderActionButton>
            <HeaderActionButton label="Conversation info">
              <Info size={18} />
            </HeaderActionButton>
          </div>
        </header>

        {showSlackBar && (
          <div className="border-b border-border-dark" data-testid="slack-threads-bar">
            <div className="flex items-center justify-between px-4 py-2">
              <button
                type="button"
                onClick={() => setSlackOpen((o) => !o)}
                aria-expanded={slackOpen}
                data-testid="slack-threads-toggle"
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary-dark"
              >
                {slackOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Slack threads · {slackThreads.length}
              </button>
              {isSlackThread && orcRow && (
                <button
                  type="button"
                  onClick={() => onSelectConversation(orcRow)}
                  data-testid="slack-back-to-orc"
                  className="text-xs text-primary hover:underline"
                >
                  ← Orchestrator
                </button>
              )}
            </div>
            {slackOpen && (
              <ul className="chat-scrollbar max-h-48 overflow-y-auto px-2 pb-2" role="list">
                {slackThreads.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onSelectConversation(t)}
                      data-testid={`slack-thread-${t.id}`}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                        t.id === conversation.id
                          ? 'bg-primary/10 text-primary'
                          : 'text-text-secondary-dark hover:bg-white/5 hover:text-text-primary-dark'
                      }`}
                    >
                      <MessageSquare size={13} className="shrink-0 opacity-60" />
                      <span className="truncate">{t.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Main timeline: roots only (replies hidden — they live in the
            thread panel). Hover "Reply in thread" + the "N replies" chip
            both open the thread panel for that root. */}
        <MessageThread
          channelId={conversation.id}
          agentName={recipientName}
          layout="flat"
          hideReplies
          onReplyInThread={handleOpenThread}
          emptyState={
            <NoMessagesEmptyState
              kind={conversation.kind === 'dm' ? 'dm' : 'channel'}
              recipientName={recipientName}
            />
          }
        />

        <MentionComposer mentionables={mentionables} onSend={handleSend} />
      </div>

      {/* Right-hand Slack-style thread panel. */}
      {threadOpen && (
        <ThreadPanel
          rootMessage={threadRootMessage}
          replies={threadReplies}
          mentionables={mentionables}
          onClose={handleCloseThread}
          onSend={handleSend}
        />
      )}

      {toast && (
        <ChatErrorToast
          message={toast.message}
          detail={toast.detail}
          onDismiss={resetSendError}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A presentational header action icon button (search / call / info). */
function HeaderActionButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary-dark transition hover:bg-white/5 hover:text-text-primary-dark"
    >
      {children}
    </button>
  );
}

/**
 * Right-hand Slack-style Thread panel.
 *
 * Renders the thread's root message at the top, a divider, then every
 * reply (derived live from the channel timeline so WS-delivered replies
 * appear instantly), and a composer that posts replies with
 * `threadId = root id` (the host's `onSend` already reads
 * `activeThreadRootId`). The replies are rendered as a self-contained
 * list rather than via `MessageThread` so the panel does not re-subscribe
 * to the whole channel feed.
 *
 * @param rootMessage - The thread root (may be undefined if not yet loaded)
 * @param replies - Replies for this thread, ascending by seq
 * @param mentionables - Mention pool for the reply composer
 * @param onClose - Close the panel (clears the active thread)
 * @param onSend - Host send handler (composes with the active thread id)
 */
function ThreadPanel({
  rootMessage,
  replies,
  mentionables,
  onClose,
  onSend,
}: {
  rootMessage: Message | undefined;
  replies: Message[];
  mentionables: MentionTarget[];
  onClose: () => void;
  onSend: (payload: MentionComposerSendPayload) => void;
}): JSX.Element {
  const replyCount = replies.length;
  return (
    <aside
      data-testid="thread-panel"
      aria-label="Thread"
      className="flex w-[380px] shrink-0 flex-col border-l border-border-dark bg-background-dark"
    >
      <header className="flex items-center justify-between gap-4 border-b border-border-dark bg-background-dark/30 px-4 py-3 backdrop-blur-md">
        <div className="leading-tight">
          <h3 className="text-sm font-bold text-text-primary-dark">Thread</h3>
          {replyCount > 0 && (
            <p className="text-[11px] text-text-secondary-dark">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="thread-close"
          aria-label="Close thread"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary-dark transition hover:bg-white/5 hover:text-text-primary-dark"
        >
          <X size={18} />
        </button>
      </header>

      <div className="chat-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {rootMessage ? (
          <ThreadMessageRow message={rootMessage} isRoot />
        ) : (
          <p className="text-xs text-text-secondary-dark">Thread root unavailable.</p>
        )}
        <div className="flex items-center gap-3 py-1">
          <span className="h-[1px] flex-1 bg-border-dark/30" aria-hidden="true" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary-dark">
            {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          </span>
          <span className="h-[1px] flex-1 bg-border-dark/30" aria-hidden="true" />
        </div>
        {replies.map((m) => (
          <ThreadMessageRow key={m.id} message={m} />
        ))}
      </div>

      <MentionComposer mentionables={mentionables} onSend={onSend} placeholder="Reply…" />
    </aside>
  );
}

/**
 * One message rendered inside the thread panel — a compact, self-contained
 * row mirroring the flat timeline look (bold name, timestamp, glass body)
 * so the panel reads consistently without re-subscribing the channel feed.
 *
 * @param message - The message to render
 * @param isRoot - When true, this is the thread's root (slightly emphasized)
 */
function ThreadMessageRow({
  message,
  isRoot = false,
}: {
  message: Message;
  isRoot?: boolean;
}): JSX.Element {
  const isAgent = message.author.role !== 'user';
  const name = message.author.name ?? message.author.id;
  const time = (() => {
    try {
      return new Date(message.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  })();
  return (
    <div
      className="flex flex-col"
      data-testid={`thread-msg-${message.id}`}
      data-author-role={message.author.role}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[13px] font-bold ${isAgent ? 'text-primary' : 'text-text-primary-dark'}`}
        >
          {name}
        </span>
        <time className="text-[10px] text-text-secondary-dark">{time}</time>
      </div>
      <div className="mt-0.5 max-w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary-dark">
        {message.content}
      </div>
    </div>
  );
}

interface ToastShape {
  message: string;
  detail?: string;
}

/**
 * Translate a `ChatApiError` (or any other Error) into a user-friendly
 * toast headline + detail. Uses the canonical error codes from the
 * BE service so the UI branches deterministically on `code`, not on
 * the human-readable message.
 */
function buildToastMessage(err: Error | null): ToastShape | null {
  if (!err) return null;
  const apiErr = err as ChatApiError;
  const code: string | undefined = (apiErr as { code?: string }).code;
  switch (code) {
    case 'validation_error':
      return {
        message: 'Could not send message — request was rejected.',
        detail: apiErr.message,
      };
    case 'payload_too_large':
      return {
        message: 'Message is too large to send.',
        detail: apiErr.message,
      };
    case 'channel_not_found':
    case 'channel_archived':
      return {
        message: 'This conversation is no longer available.',
        detail: apiErr.message,
      };
    case 'forbidden':
      return {
        message: 'You do not have permission to send here.',
        detail: apiErr.message,
      };
    case 'rate_limited':
      return {
        message: 'Slow down — too many sends in a short window.',
        detail: apiErr.message,
      };
    case 'network_error':
      return {
        message: 'Network error — message did not send.',
        detail: apiErr.message,
      };
    default:
      return {
        message: 'Could not send message.',
        detail: err.message,
      };
  }
}

/** Re-exported for testing the helper without rendering. */
export const __test__ = { buildToastMessage };

export default LiveTeamChatPage;
