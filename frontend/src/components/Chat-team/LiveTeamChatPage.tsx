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
 * @module components/Chat-team/LiveTeamChatPage
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ChatAPIProvider,
  ConversationListPanel,
  MentionComposer,
  MessageThread,
  WorkspaceRail,
  useChannels,
  useGroupedChannels,
  useMessages,
  useObservedWorkspaces,
  useSendMessage,
  useChatApiClient,
  type ChatApiClient,
  type ChatApiError,
  type Channel,
  type ChatPresenceStatus,
  type ConversationGroup,
  type ConversationRow,
  type MentionComposerSendPayload,
  type MentionTarget,
  type Workspace,
} from '@crewly/chat-ui';
import {
  AgentOfflineBanner,
  NoChannelsEmptyState,
  NoMessagesEmptyState,
  NoTeamsEmptyState,
} from './EmptyStates';
import { ChatErrorToast } from './ChatErrorToast';
import { CreateGroupModal } from './CreateGroupModal';
import { usePinnedChats } from '../../hooks/usePinnedChats';

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
   * Optional always-present "Direct Messages" workspace. When provided AND
   * the user has at least one DM channel, it is prepended to the rail so
   * DMs (e.g. the orchestrator + agents) are reachable even when the user
   * has no team channels — otherwise the page would dead-end on the
   * NoTeams empty state. DMs are workspace-agnostic, so this synthetic
   * workspace simply scopes the center panel to show only DMs.
   */
  directMessagesWorkspace?: { id: string; name: string } | null;
  /**
   * Full agent directory (host-supplied). Every agent is shown in the DM
   * list — online or offline — even before a DM channel exists, so the user
   * can reach any agent. Agents that already have a real DM channel are
   * de-duplicated against it.
   */
  directoryAgents?: DirectoryAgentEntry[];
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
}

export function LiveTeamChatPage({
  backendURL,
  authToken,
  client,
  teamLabels,
  mentionables = [],
  initialWorkspaceId,
  initialConversationId,
  directMessagesWorkspace,
  directoryAgents = [],
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
        teamLabels={teamLabels}
        mentionables={mentionables}
        initialWorkspaceId={initialWorkspaceId}
        initialConversationId={initialConversationId}
        directMessagesWorkspace={directMessagesWorkspace}
        directoryAgents={directoryAgents}
        onEnsureDm={onEnsureDm}
      />
    </ChatAPIProvider>
  );
}

// ---------------------------------------------------------------------------
// Body — separated from the Provider wrapper so hooks can read the client.
// ---------------------------------------------------------------------------

interface BodyProps {
  teamLabels?: Record<string, string>;
  mentionables: MentionTarget[];
  initialWorkspaceId?: string | null;
  initialConversationId?: string | null;
  directMessagesWorkspace?: { id: string; name: string } | null;
  directoryAgents: DirectoryAgentEntry[];
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
 * Friendlier label for a Slack thread whose raw title is the synthesized
 * `slack-<channelId>-<ts>` id. We can't resolve the human channel name without
 * the Slack API, so surface the channel id portion.
 */
function prettySlackTitle(raw: string): string {
  const m = raw.match(/^slack-([^-]+)-/);
  return m ? `Slack · ${m[1]}` : raw;
}

/** Count rows in a group including nested sub-groups. */
function countGroupRows(group: ConversationGroup): number {
  return group.rows.length + (group.subGroups?.reduce((a, g) => a + countGroupRows(g), 0) ?? 0);
}

/** Flatten all rows across groups + nested sub-groups, in render order. */
function flattenRows(groups: ConversationGroup[]): ConversationRow[] {
  return groups.flatMap((g) => [...g.rows, ...flattenRows(g.subGroups ?? [])]);
}

function LiveTeamChatPageBody({
  teamLabels,
  mentionables,
  initialWorkspaceId,
  initialConversationId,
  directMessagesWorkspace,
  directoryAgents,
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
        createdAt: '',
        type: 'dm' as const,
        // Channel presence is the narrower online|busy|offline vocabulary.
        presence:
          a.presence === 'online' ? 'online' : a.presence === 'busy' ? 'busy' : 'offline',
      }));
    return synthetic.length > 0 ? [...channels, ...synthetic] : channels;
  }, [channels, directoryAgents]);

  const teamWorkspaces = useObservedWorkspaces(mergedChannels, { teamLabels });

  // Prepend the synthetic "Direct Messages" workspace when the host supplies
  // one and the user actually has DMs — so DMs (orchestrator + agents) are
  // reachable even with zero team channels. DMs are not team-scoped, so this
  // workspace just narrows the center panel to the DM group.
  const hasDms = useMemo(
    () => mergedChannels.some((c) => (c.type ?? 'dm') !== 'channel'),
    [mergedChannels],
  );
  const workspaces = useMemo<Workspace[]>(() => {
    if (directMessagesWorkspace && hasDms) {
      return [
        {
          id: directMessagesWorkspace.id,
          name: directMessagesWorkspace.name,
          initials: 'DM',
          kind: 'activity',
        },
        ...teamWorkspaces,
      ];
    }
    return teamWorkspaces;
  }, [directMessagesWorkspace, hasDms, teamWorkspaces]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? null,
  );
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );

  // Settle the workspace selection: prefer explicit initial, else the
  // first observed workspace. This runs each render but reaches a
  // stable fixed-point because the setter compares values.
  const resolvedWorkspaceId =
    activeWorkspaceId ?? (workspaces[0]?.id ?? null);

  const baseGroups = useGroupedChannels(mergedChannels, {
    workspaceId: resolvedWorkspaceId,
  });

  // Split the flat "Direct Messages" group into one section per team (agents
  // mapped via the directory). Agents with no team (e.g. the orchestrator)
  // stay under "Direct Messages". Channels + Group Chats sections pass
  // through unchanged. This is what makes the long agent list readable.
  const sessionToTeam = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of directoryAgents) {
      if (a.agentSession && a.teamName) m.set(a.agentSession, a.teamName);
    }
    return m;
  }, [directoryAgents]);

  const sectioned = useMemo(() => {
    const dms = baseGroups.find((g) => g.id === 'dms');
    if (!dms) return baseGroups;

    const slackRows: ConversationRow[] = [];
    const byTeam = new Map<string, typeof dms.rows>();
    const noTeam: typeof dms.rows = [];
    for (const row of dms.rows) {
      // Slack-bridged threads → their own "Slack" section (not a team DM).
      if (row.id.startsWith(SLACK_ID_PREFIX)) {
        slackRows.push({ ...row, title: prettySlackTitle(row.title) });
        continue;
      }
      const team = row.agentSession ? sessionToTeam.get(row.agentSession) : undefined;
      if (team) {
        const list = byTeam.get(team) ?? [];
        list.push(row);
        byTeam.set(team, list);
      } else {
        noTeam.push(row);
      }
    }

    const teamSections: ConversationGroup[] = [...byTeam.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([team, rows]) => ({ id: `dm-team:${team}`, label: team, rows }));

    // Order: channels, huddles, teamless DMs, Slack, then Teams.
    return baseGroups.flatMap<ConversationGroup>((g) => {
      if (g.id !== 'dms') return [g];
      const out: ConversationGroup[] = [];
      if (noTeam.length > 0) out.push({ id: 'dms', label: 'Direct Messages', rows: noTeam });
      if (slackRows.length > 0) out.push({ id: 'slack', label: 'Slack', rows: slackRows });
      if (teamSections.length > 0) {
        out.push({ id: 'teams', label: 'Teams', rows: [], subGroups: teamSections });
      }
      return out;
    });
  }, [baseGroups, sessionToTeam]);

  // Lift pinned conversations into a top "Pinned Chats" section, removing them
  // from their normal section (including nested team sub-groups) so they appear
  // once. Orchestrator is pinned by default; the user can pin/unpin any chat.
  const groups = useMemo(() => {
    const pinnedRows: ConversationRow[] = [];
    const prune = (g: ConversationGroup): ConversationGroup => {
      const keep: ConversationRow[] = [];
      for (const r of g.rows) {
        if (pinnedChats.isPinned(pinKeyOf(r))) pinnedRows.push(r);
        else keep.push(r);
      }
      const subs = (g.subGroups ?? [])
        .map(prune)
        .filter((sg) => countGroupRows(sg) > 0);
      return { ...g, rows: keep, subGroups: subs.length > 0 ? subs : undefined };
    };
    const pruned = sectioned.map(prune).filter((g) => countGroupRows(g) > 0);
    if (pinnedRows.length === 0) return pruned;
    return [{ id: 'pinned', label: 'Pinned Chats', rows: pinnedRows }, ...pruned];
  }, [sectioned, pinnedChats]);

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
    () => flattenRows(groups).find((r) => r.id === resolvedConversationId),
    [groups, resolvedConversationId],
  );

  // §9.1 — no workspaces visible at all (e.g. brand-new account).
  if (workspaces.length === 0 && !channelsLoading) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-slate-50 dark:bg-slate-950"
        data-testid="team-chat-page"
      >
        <NoTeamsEmptyState />
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full bg-slate-50 dark:bg-slate-950"
      data-testid="team-chat-page"
      data-loading={channelsLoading ? 'true' : 'false'}
      data-error={channelsError ? 'true' : 'false'}
    >
      {/* Slack hides the workspace switcher when there's only one workspace
          (e.g. DM-only). Showing a single lonely icon column adds noise. */}
      {workspaces.length > 1 && (
        <WorkspaceRail
          workspaces={workspaces}
          activeWorkspaceId={resolvedWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
        />
      )}

      <ConversationListPanel
        // Avoid a duplicate header: the DM workspace's group label ("Direct
        // Messages") already heads the list, so don't also render it as the
        // panel title. Real team workspaces still show their name.
        workspaceName={
          activeWorkspace && activeWorkspace.id !== directMessagesWorkspace?.id
            ? activeWorkspace.name
            : undefined
        }
        groups={groups}
        activeConversationId={resolvedConversationId}
        onSelectConversation={handleSelectConversation}
        isPinned={(row) => pinnedChats.isPinned(pinKeyOf(row))}
        onTogglePin={(row) => pinnedChats.toggle(pinKeyOf(row))}
        headerAction={
          <button
            type="button"
            onClick={() => setShowCreateGroup(true)}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            data-testid="new-group-button"
            title="Create a multi-agent group chat"
          >
            + New group
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
}

function LiveTeamChatRightPanel({
  conversation,
  mentionables,
}: RightPanelProps): JSX.Element {
  // No conversation selected — happens on first render of an empty
  // workspace, or transiently after a workspace switch.
  if (!conversation) {
    return (
      <section
        className="flex flex-1 items-center justify-center bg-slate-50 text-sm text-slate-500 dark:bg-slate-950"
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
    />
  );
}

function LiveTeamChatRightPanelInner({
  conversation,
  mentionables,
}: {
  conversation: ConversationRow;
  mentionables: MentionTarget[];
}): JSX.Element {
  const { messages } = useMessages(conversation.id);
  const { send, error: sendError, reset: resetSendError } = useSendMessage();

  // Phase C thread-pane state — `threadRoot` is the message id we're
  // composing replies against. Top-level posts have `threadRoot=null`.
  const [threadRoot, setThreadRoot] = useState<string | null>(null);

  // Surface validation_error and payload_too_large 400/413s as a toast.
  // Network errors (code 'network_error') get the same treatment so the
  // user always knows the send failed; the timeline already shows the
  // optimistic bubble in `failed` state via the client's emit path.
  const toast = useMemo(() => buildToastMessage(sendError), [sendError]);

  const isInactiveDm =
    conversation.kind === 'dm' &&
    (conversation.presence === 'inactive' || conversation.presence === 'offline');
  const recipientName = conversation.kind === 'dm' ? conversation.title : undefined;

  /**
   * Pick a sensible thread root from incoming messages. When any message
   * in the timeline already carries a `threadId`, surface a small
   * "Reply in thread" affordance keyed to that thread. The user clicks
   * to enter thread-reply mode.
   */
  const lastObservedThreadId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = messages[i].threadId;
      if (t) return t;
    }
    return null;
  }, [messages]);

  const handleSend = useCallback(
    async (payload: MentionComposerSendPayload) => {
      // Map MentionTarget[] → string[] of IDs (member-id or team-id) per
      // SEALED §3.2 wire shape. Empty array on no mentions; never null.
      const mentionIds = payload.mentions.map((m) => m.id);
      try {
        await send(conversation.id, {
          content: payload.content,
          mentions: mentionIds,
          threadId: threadRoot ?? undefined,
        });
      } catch {
        // Error is captured in `sendError`; the toast renders below.
        // Swallow here so the composer doesn't double-report.
      }
    },
    [conversation.id, send, threadRoot],
  );

  const handleEnterThread = useCallback(() => {
    if (lastObservedThreadId) setThreadRoot(lastObservedThreadId);
  }, [lastObservedThreadId]);

  const handleExitThread = useCallback(() => {
    setThreadRoot(null);
  }, []);

  return (
    <section
      className="flex flex-1 flex-col bg-white dark:bg-slate-900"
      data-testid="team-chat-right-panel"
      aria-label={`Conversation with ${conversation.title}`}
      data-thread-active={threadRoot ? 'true' : 'false'}
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
            {conversation.kind === 'channel' ? `#${conversation.title}` : conversation.title}
          </h2>
          {conversation.subtitle && (
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              {conversation.subtitle}
            </p>
          )}
        </div>
        {/* Phase C minimal thread affordance — surfaces only when the
            timeline contains a threaded reply, so we know there IS a
            thread to drop into. */}
        {lastObservedThreadId && !threadRoot && (
          <button
            type="button"
            onClick={handleEnterThread}
            data-testid="thread-enter"
            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Reply in thread
          </button>
        )}
      </header>

      {isInactiveDm && recipientName && <AgentOfflineBanner agentName={recipientName} />}

      <MessageThread
        channelId={conversation.id}
        agentName={recipientName}
        layout="flat"
        emptyState={
          <NoMessagesEmptyState
            kind={conversation.kind === 'dm' ? 'dm' : 'channel'}
            recipientName={recipientName}
          />
        }
      />

      {threadRoot && (
        <ThreadReplyBanner threadRootId={threadRoot} onExit={handleExitThread} />
      )}

      <MentionComposer
        mentionables={mentionables}
        onSend={handleSend}
        inactiveHelper={
          isInactiveDm && recipientName
            ? `${recipientName} is inactive — sending will activate them and deliver your message.`
            : threadRoot
              ? `Replying in thread ${threadRoot}`
              : undefined
        }
      />

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
 * Small banner above the composer when a thread reply is active.
 * Mirrors Slack's "Replying to a thread in #general" affordance.
 */
function ThreadReplyBanner({
  threadRootId,
  onExit,
}: {
  threadRootId: string;
  onExit: () => void;
}): JSX.Element {
  return (
    <div
      role="note"
      data-testid="thread-reply-banner"
      className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-100 px-4 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    >
      <span>
        Replying to thread <code className="rounded bg-slate-200 px-1 dark:bg-slate-700">{threadRootId}</code>
      </span>
      <button
        type="button"
        onClick={onExit}
        data-testid="thread-exit"
        className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
      >
        Cancel
      </button>
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
