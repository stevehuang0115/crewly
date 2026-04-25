/**
 * TeamChatPage — Slack-like 3-panel chat shell for the OSS frontend.
 *
 * Composes the Phase B primitives from `@crewly/chat-ui`:
 *   WorkspaceRail (left) | ConversationListPanel (center) | MessageThread + MentionComposer (right)
 *
 * Phase B is mock-only on the WorkspaceRail + ConversationListPanel
 * sides — those panels render against `mock-team-chat-data` until
 * Sam's Phase A backend ships (target 2026-04-27 EOD). The right
 * panel (MessageThread) reuses the existing `MockChatApiClient` from
 * `@crewly/chat-ui` so the timeline, delivery states, and unread
 * divider all render with realistic seed data.
 *
 * Selection model:
 *  - `activeWorkspaceId` is the currently-selected workspace.
 *  - `activeConversationId` is the currently-selected channel/DM/activity row.
 *  - When a workspace is selected but no conversation is, the center panel
 *    auto-selects the first row of the first non-empty group so the user
 *    lands in a valid context immediately (design §6.1 affordance).
 *
 * Empty-state mounting follows design §9.1-§9.4. Phase C/D scope (mention
 * routing, real WS, mobile) is intentionally excluded — see the task
 * spec's DEFER list.
 *
 * @module components/Chat-team/TeamChatPage
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChatAPIProvider,
  ConversationListPanel,
  MentionComposer,
  MessageThread,
  WorkspaceRail,
  type ConversationRow,
  type MentionComposerSendPayload,
  type Workspace,
} from '@crewly/chat-ui';
import {
  AgentOfflineBanner,
  NoChannelsEmptyState,
  NoMessagesEmptyState,
  NoTeamsEmptyState,
} from './EmptyStates';
import {
  MOCK_MENTIONABLES,
  MOCK_WORKSPACES,
  findMockConversation,
  getMockGroupsForWorkspace,
} from './mock-team-chat-data';

export interface TeamChatPageProps {
  /**
   * Override the seed workspaces. Tests pass empty array to exercise
   * the §9.1 zero-state; production omits and uses the mock seed.
   */
  workspaces?: Workspace[];
  /**
   * Initial workspace id to land on. Defaults to the first non-activity
   * team in the seed so the page opens in a useful state.
   */
  initialWorkspaceId?: string | null;
  /**
   * Initial conversation id to land on. Defaults to the first row of
   * the initial workspace.
   */
  initialConversationId?: string | null;
}

export function TeamChatPage({
  workspaces = MOCK_WORKSPACES,
  initialWorkspaceId,
  initialConversationId,
}: TeamChatPageProps): JSX.Element {
  const defaultWorkspaceId = useMemo(() => {
    if (initialWorkspaceId !== undefined) return initialWorkspaceId;
    const first = workspaces.find((w) => !w.kind || w.kind === 'team');
    return first?.id ?? null;
  }, [initialWorkspaceId, workspaces]);

  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(defaultWorkspaceId);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );

  const groups = useMemo(
    () => getMockGroupsForWorkspace(activeWorkspaceId),
    [activeWorkspaceId],
  );

  // When the workspace changes, settle on a default conversation. Prefer
  // a previously-explicit id; otherwise auto-select the first non-empty
  // row so the user sees content rather than an empty right panel.
  useEffect(() => {
    if (!activeWorkspaceId) {
      setActiveConversationId(null);
      return;
    }
    if (activeConversationId) {
      const stillExists = groups.some((g) => g.rows.some((r) => r.id === activeConversationId));
      if (stillExists) return;
    }
    const firstRow = groups.flatMap((g) => g.rows).find(Boolean);
    setActiveConversationId(firstRow?.id ?? null);
    // We intentionally do not depend on activeConversationId here —
    // dropping it back to null/first-row is the side-effect we want
    // when the workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, groups]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );
  const activeConversation = useMemo(
    () => findMockConversation(activeConversationId),
    [activeConversationId],
  );

  const handleSelectWorkspace = useCallback((ws: Workspace) => {
    setActiveWorkspaceId(ws.id);
  }, []);

  const handleSelectConversation = useCallback((row: ConversationRow) => {
    setActiveConversationId(row.id);
  }, []);

  const handleSend = useCallback((payload: MentionComposerSendPayload) => {
    // Phase B: log only — Phase C wires send to the chat API.
    // eslint-disable-next-line no-console
    console.info('[TeamChatPage] mock send', payload);
  }, []);

  // §9.1 — no workspaces visible at all.
  if (workspaces.length === 0) {
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
    <ChatAPIProvider mode="mock">
      <div
        className="flex h-full w-full bg-slate-50 dark:bg-slate-950"
        data-testid="team-chat-page"
      >
        <WorkspaceRail
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
        />

        <ConversationListPanel
          workspaceName={activeWorkspace?.name}
          groups={groups}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          emptyState={
            activeWorkspace ? (
              <NoChannelsEmptyState teamName={activeWorkspace.name} />
            ) : undefined
          }
        />

        <ChatTeamRightPanel
          conversation={activeConversation}
          onSend={handleSend}
        />
      </div>
    </ChatAPIProvider>
  );
}

/**
 * Right panel — composes header, optional offline banner, MessageThread,
 * and MentionComposer based on the active conversation. Pulled out so
 * the parent body stays at one screenful.
 */
function ChatTeamRightPanel({
  conversation,
  onSend,
}: {
  conversation: ConversationRow | undefined;
  onSend: (payload: MentionComposerSendPayload) => void;
}): JSX.Element {
  // No conversation selected — happens transiently on workspace switch
  // before the auto-select effect fires, or when the workspace is empty.
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

  const isInactiveDm =
    conversation.kind === 'dm' &&
    (conversation.presence === 'inactive' || conversation.presence === 'offline');

  const recipientName = conversation.kind === 'dm' ? conversation.title : undefined;

  // Phase B: the right panel uses MockChatApiClient seed data — we
  // map the conversation id to the mock client's first channel so the
  // timeline renders. Phase C will pivot this to the actual channelId
  // for the conversation once Sam's BE provides the mapping.
  // For Phase B we use a deterministic stable channel id mapping so
  // every conversation gets its own thread surface.
  const mockChannelId = `mock-${conversation.id}`;

  return (
    <section
      className="flex flex-1 flex-col bg-white dark:bg-slate-900"
      data-testid="team-chat-right-panel"
      aria-label={`Conversation with ${conversation.title}`}
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
      </header>

      {isInactiveDm && recipientName && <AgentOfflineBanner agentName={recipientName} />}

      <MessageThread
        channelId={mockChannelId}
        agentName={recipientName}
        emptyState={
          <NoMessagesEmptyState
            kind={conversation.kind === 'dm' ? 'dm' : 'channel'}
            recipientName={recipientName}
          />
        }
      />

      <MentionComposer
        mentionables={MOCK_MENTIONABLES}
        onSend={onSend}
        inactiveHelper={
          isInactiveDm && recipientName
            ? `${recipientName} is inactive. Message will queue for later delivery.`
            : undefined
        }
      />
    </section>
  );
}

export default TeamChatPage;
