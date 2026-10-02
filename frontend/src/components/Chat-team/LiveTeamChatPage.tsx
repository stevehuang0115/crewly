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
 * Visuals follow the simplified redesign (specs/2026-10-02-ui-redesign.md,
 * Chat): a quiet conversation list (Pinned · DMs · Channels · Group chats,
 * names + unread dots, long sections folded behind "N more"), quiet message
 * chrome (details on hover / "⋯"), a one-line composer, and on phones a
 * list ⇄ conversation switch. Opening a conversation marks it seen
 * (`markChatSeen`, the per-browser read state behind the Chat badge).
 *
 * @module components/Chat-team/LiveTeamChatPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, MoreHorizontal, Pin, PinOff, Search, X } from 'lucide-react';
import {
  ChatAPIProvider,
  MentionComposer,
  MessageThread,
  useChannels,
  useGroupedChannels,
  useMessages,
  useMergedMessages,
  useSendMessage,
  useChatApiClient,
  selectThreadReplies,
  stripInternalHints,
  type ChatApiClient,
  type ChatApiError,
  type Channel,
  type ChatPresenceStatus,
  type ConversationGroup,
  type ConversationRow,
  type MentionComposerSendPayload,
  type MentionTarget,
  type Message,
} from '@crewly/chat-ui';
import {
  NoChannelsEmptyState,
  NoMessagesEmptyState,
} from './EmptyStates';
import { IconButton } from '@crewly/ui/Button';
import { OverflowMenu } from '@crewly/ui/OverflowMenu';
import { ChatErrorToast } from './ChatErrorToast';
import { CreateGroupModal } from './CreateGroupModal';
import { ChatConversationList } from './ChatConversationList';
import { usePinnedChats } from '../../hooks/usePinnedChats';
import { markChatSeen, readChatSeen, type ChatSeenRecord } from '../../hooks/useChatUnreadCount';
import { ORCHESTRATOR_SESSION } from '../../utils/team-chat.utils';

/** How often the conversation list is re-read so unread dots stay current (ms). */
export const CHAT_LIST_POLL_MS = 30_000;

/**
 * Whether a conversation has messages the owner has not seen.
 *
 * `baselineAll` is when Chat was last open before this visit (the badge's
 * record, read before the badge marks everything seen); `seenAt` is when this
 * conversation was last open. Before any record exists (first visit in this
 * browser) nothing is unread, matching the badge.
 *
 * @param lastMessageAt - ISO time of the conversation's last message
 * @param seenAt - When this conversation was last open (ms), if ever
 * @param baselineAll - When Chat was last open (ms), if ever
 * @returns True when there is something new
 */
export function isConversationUnread(
  lastMessageAt: string | undefined,
  seenAt: number | undefined,
  baselineAll: number | undefined,
): boolean {
  if (baselineAll === undefined || !lastMessageAt) return false;
  const at = Date.parse(lastMessageAt);
  if (Number.isNaN(at)) return false;
  return at > Math.max(baselineAll, seenAt ?? 0);
}

/**
 * Landing identifier. The dedicated workspace rail was removed in favour of a
 * single consolidated conversation list, so this is now only a stable token
 * for the (deprecated) `initialWorkspaceId` prop / deep-link plumbing.
 */
export const HOME_ID = 'home';

/** Build the legacy workspace id for a team (kept for deep-link callers). */
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
  /**
   * @deprecated The dedicated workspace rail was removed in favour of a single
   * consolidated conversation list, so per-workspace selection no longer
   * applies. Accepted for backwards compatibility (deep-link callers) but
   * ignored.
   */
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
   * Teams (host-derived, lead detection from team config). Each team's huddle
   * channel surfaces in the consolidated "Channels" list (Slack-style), and a
   * team's lead(s) get a "Lead" badge in the Direct messages list. When empty
   * the list shows just the orchestrator + any agent DMs.
   */
  teams?: ChatTeam[];
  /**
   * Ensure (find-or-create) a DM channel for an agent session, returning the
   * resolved channel id. Called when the user opens a directory agent that
   * doesn't have a channel yet. Host-supplied to keep this component
   * transport-agnostic.
   */
  onEnsureDm?: (agentSession: string) => Promise<string>;
  /**
   * The Chat "seen" record as it was before this visit (the host reads it
   * before the nav badge marks Chat seen). Drives the per-conversation
   * unread dots. Defaults to the current record.
   */
  seenBaseline?: ChatSeenRecord;
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
  initialConversationId,
  directoryAgents = [],
  teams = [],
  onEnsureDm,
  seenBaseline,
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
        initialConversationId={initialConversationId}
        directoryAgents={directoryAgents}
        teams={teams}
        onEnsureDm={onEnsureDm}
        seenBaseline={seenBaseline}
      />
    </ChatAPIProvider>
  );
}

// ---------------------------------------------------------------------------
// Body — separated from the Provider wrapper so hooks can read the client.
// ---------------------------------------------------------------------------

interface BodyProps {
  mentionables: MentionTarget[];
  initialConversationId?: string | null;
  directoryAgents: DirectoryAgentEntry[];
  teams: ChatTeam[];
  onEnsureDm?: (agentSession: string) => Promise<string>;
  seenBaseline?: ChatSeenRecord;
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

/** Flatten all rows across groups + nested sub-groups, in render order. */
function flattenRows(groups: ConversationGroup[]): ConversationRow[] {
  return groups.flatMap((g) => [...g.rows, ...flattenRows(g.subGroups ?? [])]);
}

function LiveTeamChatPageBody({
  mentionables,
  initialConversationId,
  directoryAgents,
  teams,
  onEnsureDm,
  seenBaseline,
}: BodyProps): JSX.Element {
  const { channels, loading: channelsLoading, error: channelsError, refresh } = useChannels();
  // Phones show the list OR the conversation; md and up show both.
  const [mobileView, setMobileView] = useState<'list' | 'conversation'>('conversation');
  // Read state: the record from before this visit + conversations opened now.
  const [baseline] = useState<ChatSeenRecord>(() => seenBaseline ?? readChatSeen());
  const [seen, setSeen] = useState<ChatSeenRecord>(() => ({ ...(seenBaseline ?? readChatSeen()) }));

  // Re-read the list now and then so unread dots and ordering stay current
  // (useChannels loads once).
  useEffect(() => {
    const timer = setInterval(() => void refresh(), CHAT_LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
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

  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );

  // All conversations, partitioned by type (channels / huddles / dms).
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

  // The orchestrator's own DM channel id — the merge target for Slack threads
  // (excludes the Slack-bridged channels, which share the orc session).
  const orcChannelId = useMemo(
    () =>
      allDmRows.find(
        (r) => r.agentSession === ORCHESTRATOR_SESSION && !r.id.startsWith(SLACK_ID_PREFIX),
      )?.id,
    [allDmRows],
  );

  // Slack-bridged thread channels (`slack-<chan>-<ts>`, all orc-owned). Each is
  // its own chat-v2 channel; rather than 30+ separate sidebar rows, their
  // messages are MERGED inline into the Orchestrator conversation timeline (see
  // `mergeChannelIds` below). They are intentionally NOT listed as conversations.
  const slackChannelIds = useMemo(
    () => allDmRows.filter((r) => r.id.startsWith(SLACK_ID_PREFIX)).map((r) => r.id),
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

  // One consolidated conversation list (the dedicated workspace rail was
  // removed). Top → bottom:
  //   Pinned → Channels (team huddles) → Direct messages (orc first) → Group chats
  // Teams surface as Slack-style "# channels"; people are reached via DMs; a
  // team's lead(s) carry a "Lead" badge in the DM list. Slack threads are NOT
  // listed — they're merged into the Orchestrator timeline (see mergeChannelIds).
  const groups = useMemo<ConversationGroup[]>(() => {
    const roleBySession = new Map(
      directoryAgents.map((a) => [a.agentSession, a.role] as const),
    );
    // Agents that lead ANY team — the per-team rosters are gone, so we surface
    // the lead signal as a badge in the flat DM list instead. A lead is anyone
    // configured as a team's leader OR whose role is `team-leader` (so every
    // team-leader is badged even when a team's `leaderSessions` is incomplete —
    // which is why previously only one Lead showed).
    const leadSessions = new Set(teams.flatMap((t) => t.leaderSessions));
    const isLeadRole = (role?: string): boolean => role === 'team-leader';
    const withMeta = (r: ConversationRow): ConversationRow => {
      const role = r.agentSession ? roleBySession.get(r.agentSession) : undefined;
      const isLead =
        (!!r.agentSession && leadSessions.has(r.agentSession)) || isLeadRole(role);
      let row = r;
      if (role) row = { ...row, subtitle: role };
      if (isLead) row = { ...row, badge: 'Lead' };
      return row;
    };

    // Channels = team huddle channels, titled by team name (falling back to the
    // raw channel name when the team can't be resolved).
    const teamNameOf = (chId: string): string | undefined => {
      const tid = channelTeamId.get(chId);
      return tid ? teams.find((t) => t.id === tid)?.name : undefined;
    };
    const channelRows = allChannelRows.map((r) => {
      const name = teamNameOf(r.id);
      return name ? { ...r, title: name } : r;
    });

    // Real DMs + synthetic directory rows; exclude Slack-bridged thread channels.
    const agentDmRows = allDmRows.filter(
      (r) => r.agentSession && !r.id.startsWith(SLACK_ID_PREFIX),
    );

    // Orchestrator first; then online → busy → offline; then most-recent; name.
    const presenceRank = (p?: ChatPresenceStatus): number =>
      p === 'online' ? 0 : p === 'busy' ? 1 : p === 'offline' ? 2 : 3;
    const byDmOrder = (a: ConversationRow, b: ConversationRow): number => {
      if (a.agentSession === ORCHESTRATOR_SESSION) return -1;
      if (b.agentSession === ORCHESTRATOR_SESSION) return 1;
      const pr = presenceRank(a.presence) - presenceRank(b.presence);
      if (pr !== 0) return pr;
      const at = a.lastMessageAt ?? '';
      const bt = b.lastMessageAt ?? '';
      if (at !== bt) return bt.localeCompare(at);
      return a.title.localeCompare(b.title);
    };

    // Pinned: ANY pinned conversation (the orchestrator included) — pinning is
    // an explicit user choice, so it wins over the orc's default DM placement.
    const pinnedRows = [...agentDmRows]
      .filter((r) => pinnedChats.isPinned(pinKeyOf(r)))
      .sort(byDmOrder)
      .map(withMeta);
    const pinnedKeys = new Set(pinnedRows.map((r) => pinKeyOf(r)));

    // Direct messages: everything not lifted into Pinned.
    const dmRows = [...agentDmRows]
      .filter((r) => !pinnedKeys.has(pinKeyOf(r)))
      .sort(byDmOrder)
      .map(withMeta);

    const out: ConversationGroup[] = [];
    if (pinnedRows.length > 0) out.push({ id: 'pinned', label: 'Pinned', rows: pinnedRows });
    if (channelRows.length > 0) out.push({ id: 'channels', label: 'Channels', rows: channelRows });
    if (dmRows.length > 0) out.push({ id: 'dms', label: 'Direct messages', rows: dmRows });
    if (allHuddleRows.length > 0) out.push({ id: 'huddles', label: 'Group chats', rows: allHuddleRows });
    return out;
  }, [
    teams,
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

  const handleSelectConversation = useCallback(
    async (row: ConversationRow) => {
      // Virtual directory row (no channel yet): create the DM on first open,
      // refresh, then select the resolved real channel.
      if (row.id.startsWith(VIRTUAL_DM_PREFIX) && row.agentSession && onEnsureDm) {
        const channelId = await onEnsureDm(row.agentSession);
        await refresh();
        setActiveConversationId(channelId);
        setMobileView('conversation');
        return;
      }
      setActiveConversationId(row.id);
      setMobileView('conversation');
    },
    [onEnsureDm, refresh],
  );

  // "New group" — create a multi-agent group chat, then refresh the channel list
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

  const activeConversation = useMemo(
    () => flattenRows(groups).find((r) => r.id === resolvedConversationId),
    [groups, resolvedConversationId],
  );

  // The Orchestrator conversation merges its own channel + every Slack-bridged
  // thread channel into one timeline (the user's Slack DMs land in ChatDB as
  // `slack-*` channels; surfacing them inline keeps the orc feed whole). Every
  // other conversation is a single-channel feed (`null`).
  const mergeChannelIds = useMemo<string[] | null>(() => {
    if (!orcChannelId || activeConversation?.id !== orcChannelId) return null;
    if (slackChannelIds.length === 0) return null;
    return [orcChannelId, ...slackChannelIds];
  }, [activeConversation, orcChannelId, slackChannelIds]);

  // Last activity of a row; the orchestrator's includes its merged Slack threads.
  const lastActivityOf = useCallback(
    (row: ConversationRow): string | undefined => {
      if (row.id !== orcChannelId || slackChannelIds.length === 0) return row.lastMessageAt;
      const times = [row.lastMessageAt, ...allDmRows.filter((r) => r.id.startsWith(SLACK_ID_PREFIX)).map((r) => r.lastMessageAt)]
        .filter((t): t is string => !!t)
        .sort();
      return times[times.length - 1];
    },
    [orcChannelId, slackChannelIds, allDmRows],
  );

  const isUnread = useCallback(
    (row: ConversationRow): boolean =>
      row.id !== resolvedConversationId &&
      isConversationUnread(lastActivityOf(row), seen[row.id], baseline.all),
    [resolvedConversationId, lastActivityOf, seen, baseline],
  );

  // Opening a conversation (and new messages while it is open) marks it seen.
  const activeLastAt = activeConversation ? lastActivityOf(activeConversation) : undefined;
  useEffect(() => {
    if (!resolvedConversationId || resolvedConversationId.startsWith(VIRTUAL_DM_PREFIX)) return;
    const now = Date.now();
    const ids = [resolvedConversationId, ...(mergeChannelIds ?? [])];
    for (const id of ids) markChatSeen(id, now);
    setSeen((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = now;
      return next;
    });
  }, [resolvedConversationId, activeLastAt, mergeChannelIds]);

  return (
    <div
      className="flex h-full w-full bg-bg"
      data-testid="team-chat-page"
      data-loading={channelsLoading ? 'true' : 'false'}
      data-error={channelsError ? 'true' : 'false'}
      data-mobile-view={mobileView}
    >
      <ChatConversationList
        className={mobileView === 'conversation' ? 'hidden md:flex' : 'flex'}
        groups={groups}
        activeConversationId={resolvedConversationId}
        onSelectConversation={(row) => void handleSelectConversation(row)}
        isUnread={isUnread}
        isPinned={(row) => pinnedChats.isPinned(pinKeyOf(row))}
        onTogglePin={(row) => pinnedChats.toggle(pinKeyOf(row))}
        onNewGroup={() => setShowCreateGroup(true)}
        alwaysShowSession={ORCHESTRATOR_SESSION}
        emptyState={
          totalRows === 0 && !channelsLoading ? (
            <NoChannelsEmptyState teamName="This workspace" />
          ) : undefined
        }
      />

      <LiveTeamChatRightPanel
        className={mobileView === 'list' ? 'hidden md:flex' : 'flex'}
        conversation={activeConversation}
        mentionables={mentionables}
        mergeChannelIds={mergeChannelIds}
        pinned={activeConversation ? pinnedChats.isPinned(pinKeyOf(activeConversation)) : false}
        onTogglePin={() => activeConversation && pinnedChats.toggle(pinKeyOf(activeConversation))}
        onBack={() => setMobileView('list')}
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
  /**
   * When set, the timeline is the chronological MERGE of these channels (the
   * Orchestrator conversation + its Slack-bridged thread channels). When null,
   * the conversation is a single-channel feed.
   */
  mergeChannelIds: string[] | null;
  /** Visibility classes (phones show the list or the conversation) */
  className?: string;
  /** Whether the open conversation is pinned */
  pinned: boolean;
  onTogglePin: () => void;
  /** Phones: back to the conversation list */
  onBack: () => void;
}

/** Header / chrome props every conversation view shares. */
type ChromeProps = Pick<RightPanelProps, 'className' | 'pinned' | 'onTogglePin' | 'onBack'>;

function LiveTeamChatRightPanel({
  conversation,
  mentionables,
  mergeChannelIds,
  ...chrome
}: RightPanelProps): JSX.Element {
  // No conversation selected — happens on first render of an empty workspace.
  if (!conversation) {
    return (
      <section
        className={`${chrome.className ?? 'flex'} flex-1 items-center justify-center bg-bg text-sm text-text-2`}
        data-testid="team-chat-right-panel"
        aria-label="Conversation thread"
      >
        Select a conversation from the list to start chatting.
      </section>
    );
  }

  // Branch on the data source (conditional RENDER, not conditional hooks): the
  // merged variant subscribes to several channels, the single variant to one.
  if (mergeChannelIds && mergeChannelIds.length > 0) {
    return (
      <MergedConversationPanel
        conversation={conversation}
        mentionables={mentionables}
        channelIds={mergeChannelIds}
        chrome={chrome}
      />
    );
  }
  return (
    <SingleChannelConversationPanel
      conversation={conversation}
      mentionables={mentionables}
      chrome={chrome}
    />
  );
}

/** Single-channel timeline (the default for every conversation but the orc). */
function SingleChannelConversationPanel({
  conversation,
  mentionables,
  chrome,
}: {
  conversation: ConversationRow;
  mentionables: MentionTarget[];
  chrome: ChromeProps;
}): JSX.Element {
  const { messages, agentThinking, hasMore, loadMore } = useMessages(conversation.id);
  return (
    <ConversationView
      chrome={chrome}
      conversation={conversation}
      mentionables={mentionables}
      messages={messages}
      agentThinking={agentThinking}
      hasMore={hasMore}
      onLoadMore={loadMore}
    />
  );
}

/**
 * Orchestrator timeline merging its own channel with every Slack-bridged thread
 * channel so Slack messages appear inline (chronologically) rather than as
 * dozens of separate sidebar conversations. Cross-channel pagination is out of
 * scope — the merged feed loads each channel's most-recent page.
 */
function MergedConversationPanel({
  conversation,
  mentionables,
  channelIds,
  chrome,
}: {
  conversation: ConversationRow;
  mentionables: MentionTarget[];
  channelIds: string[];
  chrome: ChromeProps;
}): JSX.Element {
  const { messages, agentThinking, hasMore, loadMore } = useMergedMessages(channelIds);
  return (
    <ConversationView
      chrome={chrome}
      conversation={conversation}
      mentionables={mentionables}
      messages={messages}
      agentThinking={agentThinking}
      hasMore={hasMore}
      onLoadMore={loadMore}
    />
  );
}

/**
 * Messages matching an in-conversation search (loaded messages only; thread
 * replies included, internal hints ignored).
 *
 * @param messages - Loaded timeline
 * @param query - Search text
 * @returns Matching messages, or all of them for an empty query
 */
export function filterMessages(messages: Message[], query: string): Message[] {
  const q = query.trim().toLowerCase();
  if (!q) return messages;
  return messages.filter((m) => stripInternalHints(m.content).toLowerCase().includes(q));
}

/**
 * The quiet line next to the conversation title: role / Lead / presence.
 *
 * @param conversation - Open conversation
 * @returns e.g. "team-leader · Lead · online"
 */
export function conversationMeta(conversation: ConversationRow): string | undefined {
  const parts = [
    conversation.subtitle,
    conversation.badge,
    conversation.kind === 'dm' ? conversation.presence : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Presentational conversation surface: header + (controlled) MessageThread +
 * composer + Slack-style thread panel + error toast. Data is injected so the
 * same view drives both the single-channel and merged feeds.
 */
function ConversationView({
  conversation,
  mentionables,
  messages,
  agentThinking,
  hasMore,
  onLoadMore,
  chrome,
}: {
  conversation: ConversationRow;
  mentionables: MentionTarget[];
  messages: Message[];
  agentThinking: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  chrome: ChromeProps;
}): JSX.Element {
  const { send, error: sendError, reset: resetSendError } = useSendMessage();

  // Slack-style thread panel state — `activeThreadRootId` is the root
  // message id whose thread panel is open (null = closed). It doubles as
  // the compose target: when the panel is open, replies POST with
  // `threadId = activeThreadRootId`; top-level posts have it null.
  const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(null);
  // In-conversation search (null = closed).
  const [search, setSearch] = useState<string | null>(null);

  // Reset the open thread and the search whenever the conversation changes —
  // a thread root from one channel is meaningless in another.
  useEffect(() => {
    setActiveThreadRootId(null);
    setSearch(null);
  }, [conversation.id]);

  // Surface validation_error and payload_too_large 400/413s as a toast.
  // Network errors (code 'network_error') get the same treatment so the
  // user always knows the send failed; the timeline already shows the
  // optimistic bubble in `failed` state via the client's emit path.
  const toast = useMemo(() => buildToastMessage(sendError), [sendError]);

  const recipientName = conversation.kind === 'dm' ? conversation.title : undefined;
  const title =
    conversation.kind === 'channel' ? `#${conversation.title.replace(/^#+\s*/, '')}` : conversation.title;
  const meta = conversationMeta(conversation);

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

  const searching = search !== null && search.trim().length > 0;
  const shownMessages = useMemo(() => (searching ? filterMessages(messages, search ?? '') : messages), [messages, search, searching]);

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
      className={`${chrome.className ?? 'flex'} min-w-0 flex-1 bg-bg`}
      data-testid="team-chat-right-panel"
      aria-label={`Conversation with ${conversation.title}`}
      data-thread-active={threadOpen ? 'true' : 'false'}
    >
      {/* Main message column — shrinks to make room for the thread panel. */}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-border-soft px-2 md:gap-4 md:px-8">
          <button
            type="button"
            onClick={chrome.onBack}
            aria-label="Back to conversations"
            title="Conversations"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--crewly-radius-sm)] text-text-2 hover:text-text md:hidden"
            data-testid="chat-back"
          >
            <ChevronLeft size={20} />
          </button>
          {search !== null ? (
            <input
              type="search"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch(null);
              }}
              placeholder={`Search ${title}`}
              aria-label="Search this conversation"
              data-testid="conversation-search"
              className="h-9 min-w-0 flex-1 rounded-[var(--crewly-radius-sm)] border border-border bg-surface px-3 text-sm text-text outline-none placeholder:text-text-3 focus:border-primary"
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
              <h1 className="truncate text-lg font-extrabold leading-7 text-text">{title}</h1>
              {meta && <span className="truncate text-[13px] text-text-2">{meta}</span>}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            <IconButton
              type="button"
              icon={search !== null ? X : Search}
              aria-label={search !== null ? 'Close search' : 'Search this conversation'}
              title={search !== null ? 'Close search' : 'Search'}
              onClick={() => setSearch((v) => (v === null ? '' : null))}
              data-testid="conversation-search-toggle"
            />
            <OverflowMenu
              icon={MoreHorizontal}
              label="Conversation options"
              buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-[var(--crewly-radius-sm)] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              items={[
                {
                  label: chrome.pinned ? 'Unpin conversation' : 'Pin conversation',
                  icon: chrome.pinned ? PinOff : Pin,
                  onClick: chrome.onTogglePin,
                },
              ]}
            />
          </div>
        </header>

        {searching && (
          <p className="mx-auto w-full max-w-[760px] px-4 pt-3 text-[13px] text-text-2 md:px-8" role="status" data-testid="conversation-search-count">
            {shownMessages.length === 0
              ? 'No loaded messages match.'
              : `${shownMessages.length} loaded message${shownMessages.length === 1 ? '' : 's'} match.`}
            {hasMore ? ' Load older messages to search further back.' : ''}
          </p>
        )}

        {/* Main timeline: roots only (replies hidden — they live in the
            thread panel), unless searching. "Reply in thread" (hover / ⋯)
            and the "N replies" link both open the thread panel. */}
        <MessageThread
          channelId={conversation.id}
          agentName={recipientName}
          layout="flat"
          variant="quiet"
          hideReplies={!searching}
          onReplyInThread={handleOpenThread}
          messages={shownMessages}
          agentThinking={agentThinking && !searching}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          emptyState={
            <NoMessagesEmptyState
              kind={conversation.kind === 'dm' ? 'dm' : 'channel'}
              recipientName={recipientName}
            />
          }
        />

        <MentionComposer
          mentionables={mentionables}
          onSend={handleSend}
          variant="compact"
          placeholder={`Message ${title}`}
        />
      </div>

      {/* Slack-style thread panel: beside the timeline on desktop, full screen on phones. */}
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

/**
 * Right-hand Slack-style Thread panel.
 *
 * Renders the thread's root message at the top, a divider, then every
 * reply (derived live from the channel timeline so WS-delivered replies
 * appear instantly), and a composer that posts replies with
 * `threadId = root id` (the host's `onSend` already reads
 * `activeThreadRootId`). The replies are rendered as a self-contained
 * list rather than via `MessageThread` so the panel does not re-subscribe
 * to the whole channel feed. On phones it covers the screen.
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
      className="fixed inset-0 z-50 flex flex-col bg-bg md:static md:z-auto md:w-[380px] md:shrink-0 md:border-l md:border-border"
    >
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-border-soft px-4">
        <div className="leading-tight">
          <h2 className="text-[15px] font-bold text-text">Thread</h2>
          {replyCount > 0 && (
            <p className="text-xs text-text-2">
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </p>
          )}
        </div>
        <IconButton
          type="button"
          icon={X}
          onClick={onClose}
          data-testid="thread-close"
          aria-label="Close thread"
        />
      </header>

      <div className="chat-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {rootMessage ? (
          <ThreadMessageRow message={rootMessage} isRoot />
        ) : (
          <p className="text-xs text-text-2">Thread root unavailable.</p>
        )}
        <div className="flex items-center gap-3 text-xs font-bold text-text-3">
          <span className="h-px flex-1 bg-border-soft" aria-hidden="true" />
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
          <span className="h-px flex-1 bg-border-soft" aria-hidden="true" />
        </div>
        {replies.map((m) => (
          <ThreadMessageRow key={m.id} message={m} />
        ))}
      </div>

      <MentionComposer mentionables={mentionables} onSend={onSend} placeholder="Reply…" variant="compact" />
    </aside>
  );
}

/**
 * One message rendered inside the thread panel — the same quiet look as the
 * timeline (bold name, quiet time, plain body) without re-subscribing the
 * channel feed.
 *
 * @param message - The message to render
 * @param isRoot - When true, this is the thread's root
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
      data-root={isRoot ? 'true' : undefined}
    >
      <div className="text-[13px] leading-5">
        <span className="font-bold text-text" title={isAgent ? 'Agent' : undefined}>{name}</span>
        <time className="text-text-3"> · {time}</time>
      </div>
      <div className="mt-0.5 max-w-full whitespace-pre-wrap break-words text-[15px] leading-6 text-text">
        {stripInternalHints(message.content)}
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
