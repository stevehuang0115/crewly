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
import { render, screen, waitFor } from '@testing-library/react';
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
import { LiveTeamChatPage, __test__ } from './LiveTeamChatPage';

const ISO = '2026-04-25T20:00:00.000Z';

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

describe('LiveTeamChatPage — Phase C acceptance', () => {
  it('AC#5: WorkspaceRail renders one entry per observed teamId', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-product-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
      {
        id: 'ch-product-onboarding',
        agentSession: '',
        name: 'proj-onboarding',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
      {
        id: 'ch-marketing-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-marketing',
      },
    ];
    const { client } = makeStubClient(channels);

    render(
      <LiveTeamChatPage
        client={client}
        teamLabels={{ 'team-product': 'Crewly Product', 'team-marketing': 'Crewly Marketing' }}
        mentionables={MENTIONABLES}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('workspace-row-team-product')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-row-team-marketing')).toBeInTheDocument();
    });
    // Two unique teamIds → exactly two rail entries (despite three channels).
    expect(screen.queryAllByTestId(/^workspace-row-/).length).toBe(2);
  });

  it('AC#3 + AC#4: groups channels vs DMs by `type` and uses correct `kind`', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
      {
        id: 'dm-sam',
        agentSession: 'crewly-product-sam',
        name: 'Sam',
        createdAt: ISO,
        type: 'dm',
        targetMemberId: 'member-sam',
        presence: 'online',
      },
    ];
    const { client } = makeStubClient(channels);

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);

    await waitFor(() => {
      expect(screen.getByText('Channels')).toBeInTheDocument();
      expect(screen.getByText('Direct Messages')).toBeInTheDocument();
    });
    // Channel row uses kind=channel, DM row uses kind=dm — verified via the
    // data-kind attribute the panel already emits.
    expect(screen.getByTestId('conv-row-ch-general')).toHaveAttribute('data-kind', 'channel');
    expect(screen.getByTestId('conv-row-dm-sam')).toHaveAttribute('data-kind', 'dm');
  });

  it('AC#1: MentionComposer onSend posts a string[] of mention IDs', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
    ];
    const { client, sendCalls } = makeStubClient(channels);

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);

    // Wait for the composer to mount.
    const textarea = await screen.findByTestId('mention-textarea');

    // Type a partial trigger so the popover opens, then click a team
    // suggestion to insert a chip.
    await userEvent.type(textarea, '@');
    await userEvent.click(await screen.findByTestId('mention-suggestion-team-product'));

    // Type more content + insert a second chip (agent).
    await userEvent.type(textarea, ' help me reach @');
    await userEvent.click(screen.getByTestId('mention-suggestion-agent-sam'));

    // Hit send.
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].channelId).toBe('ch-general');
    // Mentions array on the wire is exactly the ids — never the labels,
    // never null. Order = insertion order.
    expect(sendCalls[0].input.mentions).toEqual(['team-product', 'agent-sam']);
  });

  it('AC#1: empty mentions array is produced when no chips are inserted', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
    ];
    const { client, sendCalls } = makeStubClient(channels);

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);
    const textarea = await screen.findByTestId('mention-textarea');
    await userEvent.type(textarea, 'hello world');
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    // Empty array — never null.
    expect(sendCalls[0].input.mentions).toEqual([]);
  });

  it('AC#2: incoming messages with threadId surface the "Reply in thread" affordance', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
    ];
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
    const { client } = makeStubClient(channels, messagesById);

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);
    // The page reads the threadId off the timeline and offers the entry chip.
    expect(await screen.findByTestId('thread-enter')).toBeInTheDocument();
  });

  it('AC#2: composer sends `threadId: <root msg id>` after entering thread mode', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
    ];
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
    const { client, sendCalls } = makeStubClient(channels, messagesById);

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);
    await userEvent.click(await screen.findByTestId('thread-enter'));
    expect(screen.getByTestId('thread-reply-banner')).toBeInTheDocument();

    const textarea = screen.getByTestId('mention-textarea');
    await userEvent.type(textarea, 'me too');
    await userEvent.click(screen.getByTestId('mention-send'));

    await waitFor(() => expect(sendCalls).toHaveLength(1));
    expect(sendCalls[0].input.threadId).toBe('m-root');
  });

  it('AC#2: validation_error 400 surfaces as a toast that is dismissable', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-general',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-product',
      },
    ];
    const { client, injectError } = makeStubClient(channels);
    injectError(
      new ChatApiError({
        code: 'validation_error',
        httpStatus: 400,
        message: 'threadId references a non-existent message',
      }),
    );

    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);
    await userEvent.type(await screen.findByTestId('mention-textarea'), 'hi');
    await userEvent.click(screen.getByTestId('mention-send'));

    const toast = await screen.findByTestId('chat-error-toast');
    expect(toast).toHaveTextContent('Could not send message');
    expect(screen.getByTestId('chat-error-toast-detail')).toHaveTextContent(
      'threadId references a non-existent message',
    );

    // Dismiss clears the toast.
    await userEvent.click(screen.getByTestId('chat-error-toast-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('chat-error-toast')).not.toBeInTheDocument();
    });
  });

  it('mounts the NoTeamsEmptyState when the BE returns zero channels', async () => {
    const { client } = makeStubClient([]);
    render(<LiveTeamChatPage client={client} mentionables={MENTIONABLES} />);
    expect(await screen.findByTestId('empty-no-teams')).toBeInTheDocument();
  });

  it('renders without crashing when the MockChatApiClient default seed is used', async () => {
    // The default seed has DM-only channels; the workspace rail should
    // be empty (no observed teamIds) and the page renders the
    // NoTeamsEmptyState. This is a smoke-test for the dev path.
    render(
      <LiveTeamChatPage
        client={new MockChatApiClient()}
        mentionables={MENTIONABLES}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('empty-no-teams')).toBeInTheDocument(),
    );
  });

  it('injects a Direct Messages workspace when the user has DMs (rail shown alongside a team)', async () => {
    // A team channel + a DM → two workspaces, so the rail is visible and we
    // can assert the synthetic DM workspace was prepended.
    const channels: Channel[] = [
      {
        id: 'ch-team',
        agentSession: '',
        name: 'general',
        createdAt: ISO,
        type: 'channel',
        teamId: 'team-x',
      },
      {
        id: 'orc-dm',
        agentSession: 'crewly-orc',
        name: 'Orchestrator',
        createdAt: ISO,
        type: 'dm',
        presence: 'online',
      },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        directMessagesWorkspace={{ id: '__direct__', name: 'Direct Messages' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('workspace-row-__direct__')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-row-team-x')).toBeInTheDocument();
  });

  it('does not inject the DM workspace when the user has no DM channels', async () => {
    // Two team channels, no DMs → two team workspaces, no DM workspace.
    const channels: Channel[] = [
      { id: 'ch-a', agentSession: '', name: 'general', createdAt: ISO, type: 'channel', teamId: 'team-a' },
      { id: 'ch-b', agentSession: '', name: 'general', createdAt: ISO, type: 'channel', teamId: 'team-b' },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        directMessagesWorkspace={{ id: '__direct__', name: 'Direct Messages' }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('workspace-row-team-a')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('workspace-row-__direct__')).not.toBeInTheDocument();
  });

  it('hides the workspace rail and dedupes the header when only the DM workspace exists', async () => {
    // DM-only → a single workspace → Slack-style 3-column layout (no rail).
    const channels: Channel[] = [
      {
        id: 'orc-dm',
        agentSession: 'crewly-orc',
        name: 'Orchestrator',
        createdAt: ISO,
        type: 'dm',
        presence: 'online',
      },
    ];
    const { client } = makeStubClient(channels);
    render(
      <LiveTeamChatPage
        client={client}
        mentionables={MENTIONABLES}
        directMessagesWorkspace={{ id: '__direct__', name: 'Direct Messages' }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('team-chat-page')).toBeInTheDocument());
    // No workspace rail when there's a single workspace.
    expect(screen.queryAllByTestId(/^workspace-row-/).length).toBe(0);
    // The orchestrator DM is reachable (not the no-teams dead-end).
    expect(screen.queryByTestId('empty-no-teams')).not.toBeInTheDocument();
    expect(screen.getAllByText('Orchestrator').length).toBeGreaterThan(0);
    // "Direct Messages" appears once (group label only, not also a panel header).
    expect(screen.getAllByText('Direct Messages').length).toBe(1);
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
