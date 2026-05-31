/**
 * LiveTeamChatPage tests — Phase C wire-up acceptance coverage.
 *
 * These tests inject a `MockChatApiClient` (or a small custom fake) so
 * we exercise the real hook-driven render path without standing up a
 * backend. Each test maps to one of the Phase C acceptance criteria:
 *
 *  - AC#1 — MentionComposer.onSend produces a string[] of mention IDs.
 *  - AC#2 — Thread state surfaces from incoming messages with threadId
 *           and posts replies with `threadId: <root msg id>`. 400s
 *           render as a toast.
 *  - AC#3 — ConversationListPanel partitions Channels vs DMs by `type`.
 *  - AC#4 — Channel rows render with `#` glyph; DM rows render the
 *           avatar (delegated to ConversationListPanel — covered by
 *           that component's own tests; we just verify the page wires
 *           the right `kind` through).
 *  - AC#5 — WorkspaceRail renders one entry per observed teamId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MockChatApiClient,
  ChatApiError,
  type ChatApiClient,
  type ChannelSubscription,
  type AgentPresence,
  type Channel,
  type Message,
  type MessagePage,
  type SendMessageInput,
  type ChatWebsocketEvent,
  type CreateChannelInput,
  type MentionTarget,
} from '@crewly/chat-ui';
import { LiveTeamChatPage, __test__, type ChatTeam } from './LiveTeamChatPage';
import { ORCHESTRATOR_SESSION } from '../../utils/team-chat.utils';

const ISO = '2026-04-25T20:00:00.000Z';

/** A product team used by the interaction tests so their channel is reachable. */
const PRODUCT_TEAM: ChatTeam = {
  id: 'team-product',
  name: 'Crewly Product',
  leaderSessions: [],
  memberSessions: [],
};
/** A team channel that becomes the team's huddle (auto-selected on team view). */
const TEAM_GENERAL: Channel = {
  id: 'ch-general',
  agentSession: '',
  name: 'general',
  createdAt: ISO,
  type: 'channel',
  teamId: 'team-product',
};

beforeEach(() => {
  // jsdom lacks scrollIntoView — patch it so MessageThread's auto-scroll
  // effect doesn't blow up in tests.
  Element.prototype.scrollIntoView = function noop() {
    /* no-op */
  };
});

const MENTIONABLES: MentionTarget[] = [
  {
    id: 'team-product',
    kind: 'team',
    label: 'Crewly Product',
    routingHint: 'Team lead responds',
  },
  {
    id: 'agent-sam',
    kind: 'agent',
    label: 'Sam',
    routingHint: 'Direct ping',
    presence: 'online',
  },
];

/**
 * Build a stub client that drives the page off a fixed channel list.
 * Used for tests that need precise control over the channel.type field
 * (the seed `MockChatApiClient` only seeds DM rows).
 */
function makeStubClient(channels: Channel[], messages: Record<string, Message[]> = {}): {
  client: ChatApiClient;
  sendCalls: Array<{ channelId: string; input: SendMessageInput }>;
  injectError: (err: Error) => void;
} {
  const sendCalls: Array<{ channelId: string; input: SendMessageInput }> = [];
  let nextSendError: Error | null = null;
  const subscribers: Record<string, Array<(e: ChatWebsocketEvent) => void>> = {};

  const client: ChatApiClient = {
    async listChannels(): Promise<Channel[]> {
      return channels;
    },
    async createChannel(_input: CreateChannelInput): Promise<Channel> {
      throw new Error('not used in this test');
    },
    async createHuddle(): Promise<Channel> {
      throw new Error('not used in this test');
    },
    async listMessages(channelId: string): Promise<MessagePage> {
      return { messages: messages[channelId] ?? [], nextCursor: null };
    },
    async sendMessage(channelId: string, input: SendMessageInput): Promise<Message> {
      sendCalls.push({ channelId, input });
      if (nextSendError) {
        const err = nextSendError;
        nextSendError = null;
        throw err;
      }
      const persisted: Message = {
        id: `srv-${sendCalls.length}`,
        channelId,
        seq: sendCalls.length,
        author: { role: 'user', id: 'demo-user', name: 'You' },
        content: input.content,
        createdAt: new Date().toISOString(),
        clientMessageId: input.clientMessageId,
        deliveryStatus: 'sent',
        mentions: input.mentions ?? [],
        threadId: input.threadId,
      };
      const list = subscribers[channelId];
      if (list) for (const cb of list) cb({ type: 'message', channelId, message: persisted });
      return persisted;
    },
    async getAgentPresence(agentId: string): Promise<AgentPresence> {
      return { agentId, status: 'online' };
    },
    subscribeToChannel(channelId, onEvent): ChannelSubscription {
      (subscribers[channelId] ||= []).push(onEvent);
      return {
        unsubscribe: () => {
          subscribers[channelId] = (subscribers[channelId] ?? []).filter((cb) => cb !== onEvent);
        },
      };
    },
  };

  return {
    client,
    sendCalls,
    injectError: (err: Error) => {
      nextSendError = err;
    },
  };
}

describe('LiveTeamChatPage — workspace rail IA', () => {
  const orcDm: Channel = {
    id: 'orc-dm',
    agentSession: ORCHESTRATOR_SESSION,
    name: 'Orchestrator',
    createdAt: ISO,
    type: 'dm',
    presence: 'online',
  };

  it('rail shows Home + orchestrator + one icon per team', async () => {
    const { client } = makeStubClient([orcDm]);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[
          PRODUCT_TEAM,
          { id: 'team-marketing', name: 'Crewly Marketing', leaderSessions: [], memberSessions: [] },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('workspace-row-home')).toBeInTheDocument());
    expect(screen.getByTestId('workspace-row-orc')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-row-team:team-product')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-row-team:team-marketing')).toBeInTheDocument();
    // home + orc + 2 teams
    expect(screen.queryAllByTestId(/^workspace-row-/).length).toBe(4);
  });

  it('Home shows the orchestrator by default (top, pinned group)', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('conv-group-pinned')).toBeInTheDocument());
    expect(screen.getByTestId('conv-row-orc-dm')).toBeInTheDocument();
  });

  it('renders Home (no dead-end) even with zero channels', async () => {
    const { client } = makeStubClient([]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('team-chat-page')).toBeInTheDocument());
    expect(screen.getByTestId('workspace-row-home')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-no-teams')).not.toBeInTheDocument();
  });

  it('a selected team shows huddle → lead → members, lead first', async () => {
    const channels: Channel[] = [
      orcDm,
      TEAM_GENERAL,
      { id: 'dm-maya', agentSession: 'sess-maya', name: 'Maya', createdAt: ISO, type: 'dm', presence: 'online' },
      { id: 'dm-alex', agentSession: 'sess-alex', name: 'Alex', createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[
          {
            id: 'team-product',
            name: 'Crewly Product',
            leaderSessions: ['sess-maya'],
            memberSessions: ['sess-maya', 'sess-alex'],
          },
        ]}
        initialWorkspaceId="team:team-product"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-group-team-huddle')).toBeInTheDocument());
    expect(screen.getByTestId('conv-row-ch-general')).toHaveAttribute('data-kind', 'channel');
    expect(screen.getByTestId('conv-group-team-lead')).toBeInTheDocument();
    expect(screen.getByTestId('conv-group-team-members')).toBeInTheDocument();
    // Lead (Maya) renders before member (Alex).
    const lead = screen.getByTestId('conv-row-dm-maya');
    const member = screen.getByTestId('conv-row-dm-alex');
    expect(lead.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('AC#1: MentionComposer onSend posts a string[] of mention IDs', async () => {
    const { client, sendCalls } = makeStubClient([TEAM_GENERAL]);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[PRODUCT_TEAM]}
        initialWorkspaceId="team:team-product"
      />,
    );
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, '@');
    await userEvent.click(await screen.findByTestId('mention-suggestion-team-product'));
    await userEvent.type(textarea, ' help me reach @');
    await userEvent.click(screen.getByTestId('mention-suggestion-agent-sam'));
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].channelId).toBe('ch-general');
    expect(sendCalls[0].input.mentions).toEqual(['team-product', 'agent-sam']);
  });

  it('AC#1: empty mentions array is produced when no chips are inserted', async () => {
    const { client, sendCalls } = makeStubClient([TEAM_GENERAL]);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[PRODUCT_TEAM]}
        initialWorkspaceId="team:team-product"
      />,
    );
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, 'hello world');
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].input.mentions).toEqual([]);
  });

  it('AC#2: incoming messages with threadId surface the "Reply in thread" affordance', async () => {
    const messagesById: Record<string, Message[]> = {
      'ch-general': [
        {
          id: 'm-root',
          channelId: 'ch-general',
          seq: 1,
          author: { role: 'agent', id: 'agent-sam', name: 'Sam' },
          content: 'kicking off the thread',
          createdAt: ISO,
          mentions: [],
        },
        {
          id: 'm-reply',
          channelId: 'ch-general',
          seq: 2,
          author: { role: 'agent', id: 'agent-sam', name: 'Sam' },
          content: 'reply within thread',
          createdAt: ISO,
          mentions: [],
          threadId: 'm-root',
        },
      ],
    };
    const { client } = makeStubClient([TEAM_GENERAL], messagesById);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[PRODUCT_TEAM]}
        initialWorkspaceId="team:team-product"
      />,
    );
    expect(await screen.findByTestId('thread-enter')).toBeInTheDocument();
  });

  it('AC#2: composer sends `threadId: <root msg id>` after entering thread mode', async () => {
    const messagesById: Record<string, Message[]> = {
      'ch-general': [
        {
          id: 'm-reply',
          channelId: 'ch-general',
          seq: 2,
          author: { role: 'agent', id: 'agent-sam', name: 'Sam' },
          content: 'a thread reply was here',
          createdAt: ISO,
          mentions: [],
          threadId: 'm-root',
        },
      ],
    };
    const { client, sendCalls } = makeStubClient([TEAM_GENERAL], messagesById);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[PRODUCT_TEAM]}
        initialWorkspaceId="team:team-product"
      />,
    );
    await userEvent.click(await screen.findByTestId('thread-enter'));
    expect(screen.getByTestId('thread-reply-banner')).toBeInTheDocument();

    const textarea = screen.getByTestId('mention-textarea');
    await userEvent.type(textarea, 'me too');
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].input.threadId).toBe('m-root');
  });

  it('AC#2: validation_error 400 surfaces as a toast that is dismissable', async () => {
    const { client, injectError } = makeStubClient([TEAM_GENERAL]);
    injectError(
      new ChatApiError({
        code: 'validation_error',
        httpStatus: 400,
        message: 'threadId references a non-existent message',
      }),
    );
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[PRODUCT_TEAM]}
        initialWorkspaceId="team:team-product"
      />,
    );
    await userEvent.type(await screen.findByTestId('mention-textarea'), 'hi');
    await userEvent.click(screen.getByTestId('mention-send'));

    const toast = await screen.findByTestId('chat-error-toast');
    expect(toast).toHaveTextContent('Could not send message');
    expect(screen.getByTestId('chat-error-toast-detail')).toHaveTextContent(
      'threadId references a non-existent message',
    );

    await userEvent.click(screen.getByTestId('chat-error-toast-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('chat-error-toast')).not.toBeInTheDocument();
    });
  });

  it('surfaces Slack threads in a collapsed Slack section under Home, labeled by time', async () => {
    const slackId = 'slack-D0AC7NF5N7L-1777760999-956969';
    const channels: Channel[] = [
      orcDm,
      { id: slackId, agentSession: ORCHESTRATOR_SESSION, name: slackId, createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);

    const toggle = await screen.findByTestId('conv-group-toggle-slack');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId(`conv-row-${slackId}`)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(await screen.findByTestId(`conv-row-${slackId}`)).toBeInTheDocument();
    expect(screen.getAllByText(/Slack thread ·/).length).toBeGreaterThan(0);
  });

  it('calls onEnsureDm when a team member without a channel is opened', async () => {
    const onEnsureDm = vi.fn().mockResolvedValue('real-chan');
    const { client } = makeStubClient([]);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[{ id: 'team-x', name: 'Team X', leaderSessions: [], memberSessions: ['sess-ella'] }]}
        initialWorkspaceId="team:team-x"
        directoryAgents={[{ agentSession: 'sess-ella', name: 'Ella', presence: 'offline' }]}
        onEnsureDm={onEnsureDm}
      />,
    );
    const row = await screen.findByText('Ella');
    fireEvent.click(row);
    await waitFor(() => expect(onEnsureDm).toHaveBeenCalledWith('sess-ella'));
  });

  it('pinning a team member surfaces them under Home', async () => {
    window.localStorage.clear();
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[{ id: 'team-x', name: 'Team X', leaderSessions: [], memberSessions: ['sess-ella'] }]}
        initialWorkspaceId="team:team-x"
      />,
    );
    // Pin Ella from the team view, then switch to Home — she appears under Pinned.
    await waitFor(() => expect(screen.getByTestId('conv-pin-dm-ella')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('conv-pin-dm-ella'));
    fireEvent.click(screen.getByTestId('workspace-row-home'));
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-ella')).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Helper-level tests — exercise the toast-message classifier independently
// so all error-code branches stay covered as the mapping evolves.
// ---------------------------------------------------------------------------

describe('LiveTeamChatPage.buildToastMessage', () => {
  const { buildToastMessage } = __test__;

  it('returns null when there is no error', () => {
    expect(buildToastMessage(null)).toBeNull();
  });

  it('classifies validation_error with the wire message as detail', () => {
    const err = new ChatApiError({
      code: 'validation_error',
      httpStatus: 400,
      message: 'threadId belongs to a different channel',
    });
    expect(buildToastMessage(err)).toEqual({
      message: 'Could not send message — request was rejected.',
      detail: 'threadId belongs to a different channel',
    });
  });

  it('classifies payload_too_large', () => {
    const err = new ChatApiError({
      code: 'payload_too_large',
      httpStatus: 413,
      message: 'mentions JSON exceeds max bytes (1024)',
    });
    expect(buildToastMessage(err)?.message).toBe('Message is too large to send.');
  });

  it('classifies network errors', () => {
    const err = new ChatApiError({
      code: 'network_error',
      httpStatus: 0,
      message: 'failed to fetch',
    });
    expect(buildToastMessage(err)?.message).toBe('Network error — message did not send.');
  });

  it('falls back to a generic message for unknown codes', () => {
    const err = new Error('something else broke');
    expect(buildToastMessage(err)).toEqual({
      message: 'Could not send message.',
      detail: 'something else broke',
    });
  });
});

// Reference vi.fn so this import isn't unused in the lint pass.
void vi;
