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
import { LiveTeamChatPage, __test__, crewlyChannelRow, isConversationUnread, filterMessages, type ChatTeam } from './LiveTeamChatPage';
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

  it('marks leads ("Lead" in the row details) — by leaderSessions AND by team-leader role', async () => {
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-maya', agentSession: 'sess-maya', name: 'Maya', createdAt: ISO, type: 'dm', presence: 'online' },
      { id: 'dm-alex', agentSession: 'sess-alex', name: 'Alex', createdAt: ISO, type: 'dm', presence: 'online' },
      // Victor is a team-leader by ROLE but is NOT in any team's leaderSessions
      // (the gap that previously left him unbadged).
      { id: 'dm-victor', agentSession: 'sess-victor', name: 'Victor', createdAt: ISO, type: 'dm', presence: 'online' },
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
        directoryAgents={[
          { agentSession: 'sess-maya', name: 'Maya', role: 'product-manager' },
          { agentSession: 'sess-alex', name: 'Alex', role: 'designer' },
          { agentSession: 'sess-victor', name: 'Victor', role: 'team-leader' },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-maya')).toBeInTheDocument());
    // Maya: lead via leaderSessions. Victor: lead via team-leader role. The
    // simplified list shows names only; role · Lead · presence is the row's tooltip.
    expect(screen.getByTestId('conv-row-dm-maya')).toHaveAttribute('title', 'product-manager · Lead · online');
    expect(screen.getByTestId('conv-row-dm-victor').getAttribute('title')).toContain('Lead');
    // Alex is neither → no Lead.
    expect(screen.getByTestId('conv-row-dm-alex').getAttribute('title')).not.toContain('Lead');
  });

  it('keeps each agent\'s role in the DM row details', async () => {
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
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-maya')).toHaveAttribute('title', 'eng-lead'));
    expect(screen.getByTestId('conv-row-dm-alex')).toHaveAttribute('title', 'designer');
  });

  it('conversation header: name, presence, Search and ⋯ (no Call action)', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Search this conversation')).toBeInTheDocument());
    expect(screen.getByText('Orchestrator', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    // There's nothing to dial in an agent chat — the Call icon must be gone.
    expect(screen.queryByLabelText('Call')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Conversation options')).toBeInTheDocument();
  });

  it('does not warn that the agent is inactive (sending wakes it anyway)', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Search this conversation')).toBeInTheDocument());
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

describe('LiveTeamChatPage — simplified chat (specs/2026-10-02-ui-redesign.md)', () => {
  const orcDm: Channel = {
    id: 'orc-dm',
    agentSession: ORCHESTRATOR_SESSION,
    name: 'Orchestrator',
    createdAt: ISO,
    type: 'dm',
    presence: 'online',
  };
  const recent = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

  it('shows an unread dot for conversations with messages since Chat was last open, and marks the open one seen', async () => {
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm', lastMessageAt: recent(60_000) },
      { id: 'dm-owen', agentSession: 'sess-owen', name: 'Owen', createdAt: ISO, type: 'dm', lastMessageAt: recent(3 * 3600_000) },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        teams={[]}
        initialConversationId="orc-dm"
        seenBaseline={{ all: Date.now() - 3600_000 }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-ella')).toHaveAttribute('data-unread', 'true'));
    expect(screen.getByTestId('conv-unread-dm-ella')).toBeInTheDocument();
    expect(screen.getByTestId('conv-row-dm-owen')).toHaveAttribute('data-unread', 'false');
    fireEvent.click(screen.getByTestId('conv-row-dm-ella'));
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-ella')).toHaveAttribute('data-unread', 'false'));
    const record = JSON.parse(window.localStorage.getItem('crewly.chat.seen') ?? '{}');
    expect(record['dm-ella']).toBeGreaterThan(0);
  });

  it('first visit in this browser (no seen record): nothing is marked unread', async () => {
    const channels: Channel[] = [
      orcDm,
      { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm', lastMessageAt: recent(60_000) },
    ];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} seenBaseline={{}} />);
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-ella')).toHaveAttribute('data-unread', 'false'));
  });

  it('folds long DM and channel lists behind "N more"; Find searches everything', async () => {
    const dms: Channel[] = Array.from({ length: 10 }, (_, i) => ({
      id: `dm-${i}`, agentSession: `s-${i}`, name: `Agent ${i}`, createdAt: ISO, type: 'dm' as const,
    }));
    const chans: Channel[] = [
      { id: 'ch-a', agentSession: '', name: 'active', createdAt: ISO, type: 'channel', teamId: 't-a', lastMessageAt: recent(3600_000) },
      { id: 'ch-b', agentSession: '', name: 'stale', createdAt: ISO, type: 'channel', teamId: 't-b', lastMessageAt: '2026-01-01T00:00:00.000Z' },
    ];
    const { client } = makeStubClient([orcDm, ...dms, ...chans]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('conv-group-dms')).toBeInTheDocument());
    const dmGroup = screen.getByTestId('conv-group-dms');
    expect(within(dmGroup).getAllByTestId(/^conv-row-/)).toHaveLength(6);
    fireEvent.click(screen.getByTestId('conv-more-dms'));
    expect(within(dmGroup).getAllByTestId(/^conv-row-/)).toHaveLength(10);
    // Channels: only the active one, the stale one behind "1 more".
    expect(screen.getByTestId('conv-row-ch-a')).toBeInTheDocument();
    expect(screen.queryByTestId('conv-row-ch-b')).not.toBeInTheDocument();
    expect(screen.getByTestId('conv-more-channels')).toHaveTextContent('1 more');
    // Find reaches folded rows.
    fireEvent.click(screen.getByTestId('conv-search-toggle'));
    fireEvent.change(screen.getByTestId('conv-search'), { target: { value: 'stale' } });
    expect(within(screen.getByTestId('conv-search-results')).getByTestId('conv-row-ch-b')).toBeInTheDocument();
  });

  it('searches the open conversation (thread replies included)', async () => {
    const messagesById: Record<string, Message[]> = {
      'orc-dm': [
        { id: 'a', channelId: 'orc-dm', seq: 1, author: { role: 'agent', id: 'orc', name: 'Orchestrator' }, content: 'Docker will not start', createdAt: ISO, mentions: [] },
        { id: 'b', channelId: 'orc-dm', seq: 2, author: { role: 'user', id: 'me', name: 'You' }, content: 'approved', createdAt: ISO, mentions: [] },
        { id: 'c', channelId: 'orc-dm', seq: 3, author: { role: 'agent', id: 'orc', name: 'Orchestrator' }, content: 'Docker reset done', createdAt: ISO, mentions: [], threadId: 'a' },
      ],
    };
    const { client } = makeStubClient([orcDm], messagesById);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    expect(await screen.findByText('approved')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Search this conversation'));
    fireEvent.change(screen.getByTestId('conversation-search'), { target: { value: 'docker' } });
    expect(screen.queryByText('approved')).not.toBeInTheDocument();
    expect(screen.getByText('Docker reset done')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-search-count')).toHaveTextContent('2 loaded messages match.');
    fireEvent.click(screen.getByLabelText('Close search'));
    expect(await screen.findByText('approved')).toBeInTheDocument();
  });

  it('pins and unpins the open conversation from the header ⋯ (works on phones)', async () => {
    const channels: Channel[] = [orcDm, { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm' }];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} initialConversationId="dm-ella" />);
    await waitFor(() => expect(screen.getByText('Ella', { selector: 'h1' })).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Conversation options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
    await waitFor(() => expect(within(screen.getByTestId('conv-group-pinned')).getByTestId('conv-row-dm-ella')).toBeInTheDocument());
  });

  it('phones: list ⇄ conversation with a back button', async () => {
    const channels: Channel[] = [orcDm, { id: 'dm-ella', agentSession: 'sess-ella', name: 'Ella', createdAt: ISO, type: 'dm' }];
    const { client } = makeStubClient(channels);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('chat-back')).toBeInTheDocument());
    expect(screen.getByTestId('team-chat-page')).toHaveAttribute('data-mobile-view', 'conversation');
    fireEvent.click(screen.getByTestId('chat-back'));
    expect(screen.getByTestId('team-chat-page')).toHaveAttribute('data-mobile-view', 'list');
    expect(screen.getByTestId('team-chat-right-panel').className).toContain('hidden md:flex');
    fireEvent.click(screen.getByTestId('conv-row-dm-ella'));
    await waitFor(() => expect(screen.getByTestId('team-chat-page')).toHaveAttribute('data-mobile-view', 'conversation'));
  });

  it('uses the one-line composer and quiet message chrome', async () => {
    const { client } = makeStubClient([orcDm]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} />);
    await waitFor(() => expect(screen.getByTestId('mention-composer')).toHaveAttribute('data-variant', 'compact'));
    expect(screen.getByTestId('mention-textarea')).toHaveAttribute('placeholder', 'Message Orchestrator');
  });
});

describe('LiveTeamChatPage — review fixes', () => {
  const orcDm: Channel = { id: 'orc-dm', agentSession: ORCHESTRATOR_SESSION, name: 'Orchestrator', createdAt: ISO, type: 'dm', presence: 'online' };

  it('pinning a channel lifts it into Pinned', async () => {
    const { client } = makeStubClient([orcDm, TEAM_GENERAL]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} />);
    await waitFor(() => expect(screen.getByTestId('conv-pin-ch-general')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('conv-pin-ch-general'));
    await waitFor(() => expect(within(screen.getByTestId('conv-group-pinned')).getByTestId('conv-row-ch-general')).toBeInTheDocument());
    expect(screen.queryByTestId('conv-group-channels')).not.toBeInTheDocument();
  });

  it('shows the agent name for a DM that was created under its raw session name', async () => {
    const raw: Channel = { id: 'dm-raw', agentSession: 'sess-ella-1a2b', name: 'sess-ella-1a2b', createdAt: ISO, type: 'dm' };
    const { client } = makeStubClient([orcDm, raw]);
    render(
      <LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[]} directoryAgents={[{ agentSession: 'sess-ella-1a2b', name: 'Ella' }]} />,
    );
    await waitFor(() => expect(screen.getByTestId('conv-row-dm-raw')).toHaveTextContent('Ella'));
  });
});

describe('isConversationUnread / filterMessages', () => {
  it('compares the last message with the later of "Chat last open" and "this conversation last open"', () => {
    const t = Date.parse('2026-10-02T10:00:00Z');
    expect(isConversationUnread('2026-10-02T10:00:01Z', undefined, t)).toBe(true);
    expect(isConversationUnread('2026-10-02T10:00:01Z', t + 5000, t)).toBe(false);
    expect(isConversationUnread('2026-10-02T09:00:00Z', undefined, t)).toBe(false);
    expect(isConversationUnread('2026-10-02T10:00:01Z', undefined, undefined)).toBe(false);
    expect(isConversationUnread(undefined, undefined, t)).toBe(false);
  });

  it('filterMessages ignores case and internal hints', () => {
    const m = (content: string) => ({ id: content, channelId: 'c', seq: 1, author: { role: 'agent' as const, id: 'x' }, content, createdAt: ISO, mentions: [] });
    expect(filterMessages([m('Hello'), m('bye [Thread context file: /tmp/hello]')], 'HELLO').map((x) => x.id)).toEqual(['Hello']);
    expect(filterMessages([m('a')], '  ')).toHaveLength(1);
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

describe('LiveTeamChatPage — Crewly channels (agents from any team)', () => {
  const BRIEF = {
    id: 'huddle-brief',
    name: 'tech-brief',
    origin: 'crewly' as const,
    createdAt: ISO,
    slack: { channelId: 'C1', channelName: 'tech-brief' },
    members: [
      { sessionName: 'research-ella', name: 'Ella', teamName: 'Research' },
      { sessionName: 'eng-sam', name: 'Sam', teamName: 'Engineering' },
    ],
  };

  it('lists channels in their own section above the team channels, and opens one', async () => {
    const { client } = makeStubClient([TEAM_GENERAL]);
    const channelsApi = { list: vi.fn().mockResolvedValue([BRIEF]), create: vi.fn(), rename: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() };
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} channelsApi={channelsApi} />);
    const section = await screen.findByTestId('conv-group-crewly-channels');
    const row = within(section).getByTestId('conv-row-huddle-brief');
    expect(row).toHaveTextContent('tech-brief');
    expect(row).toHaveAttribute('title', 'Ella, Sam · Slack');
    const headings = Array.from(document.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings.indexOf('Channels')).toBeLessThan(headings.indexOf('Team channels'));
  });

  it('creates a channel from the New channel dialog and opens it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ data: { agents: [{ agentSession: 'research-ella', name: 'Ella', role: 'researcher' }] } }),
    }));
    try {
      const { client } = makeStubClient([TEAM_GENERAL]);
      const channelsApi = { list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue(BRIEF), rename: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() };
      render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} channelsApi={channelsApi} />);
      await screen.findByTestId('conversation-list-panel');
      fireEvent.click(screen.getByTestId('new-channel-button'));
      fireEvent.change(await screen.findByLabelText('Channel name'), { target: { value: 'Tech Brief' } });
      fireEvent.click(await screen.findByLabelText(/Ella/));
      channelsApi.list.mockResolvedValue([BRIEF]);
      fireEvent.click(screen.getByTestId('create-group-submit'));
      await waitFor(() => expect(channelsApi.create).toHaveBeenCalledWith({ name: 'Tech Brief', memberSessions: ['research-ella'] }));
      await waitFor(() => expect(screen.getByTestId('conv-row-huddle-brief')).toHaveAttribute('aria-current', 'page'));
      expect(screen.queryByText('New channel')).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a channel has Channel settings (rename, members); other conversations do not', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ data: { agents: [] } }) }));
    try {
      const { client } = makeStubClient([TEAM_GENERAL]);
      const channelsApi = { list: vi.fn().mockResolvedValue([BRIEF]), create: vi.fn(), rename: vi.fn().mockResolvedValue({ ...BRIEF, name: 'morning-brief' }), addMember: vi.fn(), removeMember: vi.fn() };
      render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} teams={[PRODUCT_TEAM]} channelsApi={channelsApi} initialConversationId="huddle-brief" />);
      await screen.findByTestId('conv-row-huddle-brief');
      fireEvent.click(screen.getByLabelText('Conversation options'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Channel settings' }));
      const input = (await screen.findByTestId('channel-settings-modal')).querySelector('input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Morning Brief' } });
      fireEvent.click(screen.getByTestId('channel-rename-submit'));
      await waitFor(() => expect(channelsApi.rename).toHaveBeenCalledWith('huddle-brief', 'Morning Brief'));
      await waitFor(() => expect(channelsApi.list.mock.calls.length).toBeGreaterThan(1));

      fireEvent.click(screen.getByTestId('conv-row-ch-general'));
      fireEvent.click(screen.getByLabelText('Conversation options'));
      expect(screen.queryByRole('menuitem', { name: 'Channel settings' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('crewlyChannelRow names the members and marks a Slack link', () => {
    expect(crewlyChannelRow(BRIEF)).toEqual({ id: 'huddle-brief', kind: 'channel', title: 'tech-brief', subtitle: 'Ella, Sam · Slack' });
    expect(crewlyChannelRow({ ...BRIEF, slack: null, members: [] })).toEqual({ id: 'huddle-brief', kind: 'channel', title: 'tech-brief' });
  });

  it('@-mentions in a channel are sent as agent session names (the huddle roster)', async () => {
    const { client, sendCalls } = makeStubClient([]);
    const channelsApi = { list: vi.fn().mockResolvedValue([BRIEF]), create: vi.fn(), rename: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() };
    const mentionables: MentionTarget[] = [{ id: 'm-sam', kind: 'agent', label: 'Sam', routingHint: 'dev', agentSession: 'eng-sam' }];
    render(<LiveTeamChatPage client={client} mentionables={mentionables} teams={[]} channelsApi={channelsApi} initialConversationId="huddle-brief" />);
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, '@');
    await userEvent.click(await screen.findByTestId('mention-suggestion-m-sam'));
    await userEvent.type(textarea, ' numbers?');
    await userEvent.click(screen.getByTestId('mention-send'));
    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].channelId).toBe('huddle-brief');
    expect(sendCalls[0].input.mentions).toEqual(['eng-sam']);
  });
});
