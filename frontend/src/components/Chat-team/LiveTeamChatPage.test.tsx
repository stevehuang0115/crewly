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
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
  // Rail collapse + group-collapse state persist to localStorage; clear it so
  // one test's collapse choices don't leak into another's initial render.
  window.localStorage.clear();
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

describe('LiveTeamChatPage — consolidated conversation list', () => {
  const orcDm: Channel = {
    id: 'orc-dm',
    agentSession: ORCHESTRATOR_SESSION,
    name: 'Orchestrator',
    createdAt: ISO,
    type: 'dm',
    presence: 'online',
  };

  it('renders a single list (no workspace rail) with teams as Channels', async () => {
    const channels: Channel[] = [orcDm, TEAM_GENERAL];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
    );
    // The dedicated workspace rail is gone — no workspace tiles render.
    await waitFor(() => expect(screen.getByTestId('conv-group-channels')).toBeInTheDocument());
    expect(screen.queryByTestId('workspace-rail')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^workspace-row-/).length).toBe(0);
    // The team's huddle channel surfaces as a "# <team name>" channel row.
    const channelRow = screen.getByTestId('conv-row-ch-general');
    expect(channelRow).toHaveAttribute('data-kind', 'channel');
    expect(channelRow).toHaveTextContent('Crewly Product');
  });

  it('surfaces the orchestrator (pinned by default) in the Pinned group', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    // The orchestrator is pinned by default, so it lands in Pinned (not DMs).
    await waitFor(() => expect(screen.getByTestId('conv-group-pinned')).toBeInTheDocument());
    expect(
      within(screen.getByTestId('conv-group-pinned')).getByTestId('conv-row-orc-dm'),
    ).toBeInTheDocument();
  });

  it('tags a team lead with a "Lead" badge in the DM list', async () => {
    const channels: Channel[] = [
      orcDm,
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
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-group-dms')).toBeInTheDocument());
    // The lead carries a "Lead" badge; a non-lead does not.
    expect(screen.getByTestId('conv-badge-dm-maya')).toHaveTextContent('Lead');
    expect(screen.queryByTestId('conv-badge-dm-alex')).not.toBeInTheDocument();
  });

  it('shows each agent\'s role under their name in the DM list', async () => {
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-maya', agentSession: 'sess-maya', name: 'Maya', createdAt: ISO, type: 'dm' },
      { id: 'dm-alex', agentSession: 'sess-alex', name: 'Alex', createdAt: ISO, type: 'dm' },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[]}
        directoryAgents={[
          { agentSession: 'sess-maya', name: 'Maya', role: 'eng-lead' },
          { agentSession: 'sess-alex', name: 'Alex', role: 'designer' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-group-dms')).toBeInTheDocument());
    expect(screen.getByText('eng-lead')).toBeInTheDocument();
    expect(screen.getByText('designer')).toBeInTheDocument();
  });

  it('conversation header offers Search but no Call action', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Search')).toBeInTheDocument());
    // There's nothing to dial in an agent chat — the Call icon must be gone.
    expect(screen.queryByLabelText('Call')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Conversation info')).toBeInTheDocument();
  });

  it('does not warn that the agent is inactive (sending wakes it anyway)', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Search')).toBeInTheDocument());
    expect(screen.queryByTestId('banner-agent-offline')).not.toBeInTheDocument();
    expect(screen.queryByText(/currently inactive/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is inactive — sending will activate/i)).not.toBeInTheDocument();
  });

  it('renders without a dead-end even with zero channels', async () => {
    const { client } = makeStubClient([]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('team-chat-page')).toBeInTheDocument());
    expect(screen.queryByTestId('empty-no-teams')).not.toBeInTheDocument();
  });

  it('AC#1: MentionComposer onSend posts a string[] of mention IDs', async () => {
    const { client, sendCalls } = makeStubClient([TEAM_GENERAL]);
    render(
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
    );
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, '@');
    await userEvent.click(await screen.findByTestId('mention-suggestion-team-product'));
    await userEvent.type(textarea, ' help me reach @');
    await userEvent.click(screen.getByTestId('mention-suggestion-agent-sam'));
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    // The team's huddle channel is auto-selected; the send targets it.
    expect(sendCalls[0].channelId).toBe('ch-general');
    expect(sendCalls[0].input.mentions).toEqual(['team-product', 'agent-sam']);
  });

  it('AC#1: empty mentions array is produced when no chips are inserted', async () => {
    const { client, sendCalls } = makeStubClient([TEAM_GENERAL]);
    render(
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
    );
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, 'hello world');
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].input.mentions).toEqual([]);
  });

  it('AC#2: a root with replies shows the "N replies" chip and opens the thread panel', async () => {
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
          replyCount: 1,
          lastReplyAt: ISO,
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
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
    );
    // The reply is hidden from the main timeline; the chip is shown on the root.
    expect(await screen.findByText('kicking off the thread')).toBeInTheDocument();
    expect(screen.queryByText('reply within thread')).not.toBeInTheDocument();
    const summary = await screen.findByTestId('msg-thread-summary-m-root');
    expect(summary).toHaveTextContent('1 reply');

    await userEvent.click(summary);
    const panel = await screen.findByTestId('thread-panel');
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId('thread-msg-m-root')).toBeInTheDocument();
    expect(screen.getByTestId('thread-msg-m-reply')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('thread-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('thread-panel')).not.toBeInTheDocument(),
    );
  });

  it('AC#2: the thread panel composer sends `threadId: <root msg id>`', async () => {
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
          replyCount: 1,
          lastReplyAt: ISO,
        },
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
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
    );
    await userEvent.click(await screen.findByTestId('msg-thread-summary-m-root'));
    const panel = await screen.findByTestId('thread-panel');

    const textareas = screen.getAllByTestId('mention-textarea');
    const panelTextarea = textareas[textareas.length - 1];
    await userEvent.type(panelTextarea, 'me too');
    const sendButtons = within(panel).getAllByTestId('mention-send');
    await userEvent.click(sendButtons[sendButtons.length - 1]);

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
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />,
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

  it('merges Slack-bridged messages into the Orchestrator timeline (no Slack sidebar section)', async () => {
    const slackId = 'slack-D0AC7NF5N7L-1777760999-956969';
    const channels: Channel[] = [
      orcDm,
      { id: slackId, agentSession: ORCHESTRATOR_SESSION, name: slackId, createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const messagesById: Record<string, Message[]> = {
      'orc-dm': [
        {
          id: 'orc-msg',
          channelId: 'orc-dm',
          seq: 1,
          author: { role: 'agent', id: 'orc', name: 'Orchestrator' },
          content: 'orchestrator says hi',
          createdAt: '2026-04-25T20:00:00.000Z',
          mentions: [],
        },
      ],
      [slackId]: [
        {
          id: 'slack-msg',
          channelId: slackId,
          seq: 1,
          author: { role: 'user', id: 'alice', name: 'Alice' },
          content: 'message from slack',
          createdAt: '2026-04-25T20:01:00.000Z',
          mentions: [],
        },
      ],
    };
    const { client } = makeStubClient(channels, messagesById);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);

    // The orchestrator is auto-selected; its timeline includes the Slack message
    // merged inline — and there is NO separate Slack sidebar group / bar.
    expect(await screen.findByText('orchestrator says hi')).toBeInTheDocument();
    expect(await screen.findByText('message from slack')).toBeInTheDocument();
    expect(screen.queryByTestId('conv-group-slack')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slack-threads-bar')).not.toBeInTheDocument();
    // The Slack thread is NOT listed as its own conversation row.
    expect(screen.queryByTestId(`conv-row-${slackId}`)).not.toBeInTheDocument();
  });

  it('calls onEnsureDm when a directory agent without a channel is opened', async () => {
    const onEnsureDm = vi.fn().mockResolvedValue('real-chan');
    const { client } = makeStubClient([orcDm]);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[{ id: 'team-x', name: 'Team X', leaderSessions: [], memberSessions: ['sess-ella'] }]}
        directoryAgents={[{ agentSession: 'sess-ella', name: 'Ella', presence: 'offline' }]}
        onEnsureDm={onEnsureDm}
      />,
    );
    const row = await screen.findByText('Ella');
    fireEvent.click(row);
    await waitFor(() => expect(onEnsureDm).toHaveBeenCalledWith('sess-ella'));
  });

  it('pinning an agent lifts them into the Pinned group', async () => {
    window.localStorage.clear();
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('conv-pin-dm-ella')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('conv-pin-dm-ella'));
    await waitFor(() => expect(screen.getByTestId('conv-group-pinned')).toBeInTheDocument());
    expect(within(screen.getByTestId('conv-group-pinned')).getByTestId('conv-row-dm-ella')).toBeInTheDocument();
  });

  it('unpinning the orchestrator moves it out of Pinned into Direct messages', async () => {
    window.localStorage.clear();
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm', presence: 'online' },
    ];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    // Pinned by default → orc starts in the Pinned group.
    await waitFor(() =>
      expect(within(screen.getByTestId('conv-group-pinned')).getByTestId('conv-row-orc-dm')).toBeInTheDocument(),
    );
    // Unpin it → it drops into Direct messages.
    fireEvent.click(screen.getByTestId('conv-pin-orc-dm'));
    await waitFor(() =>
      expect(within(screen.getByTestId('conv-group-dms')).getByTestId('conv-row-orc-dm')).toBeInTheDocument(),
    );
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
