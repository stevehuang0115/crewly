import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import {
  MessageThread,
  avatarInitials,
  avatarColor,
  relativeTime,
  formatDayLabel,
  isNewDay,
  stripInternalHints,
} from './MessageThread';
import type { Channel, Message } from '../types/chat.types';

describe('MessageThread', () => {
  beforeEach(() => {
    // jsdom lacks scrollIntoView — patch it to a no-op so React's effect
    // doesn't throw in the auto-scroll path.
    Element.prototype.scrollIntoView = function () {
      /* no-op */
    };
  });
  afterEach(() => {
    // Restore is fine with a best-effort no-op — jsdom doesn't care.
  });

  it('shows the empty-state prompt when no channel is selected', () => {
    render(
      <ChatAPIProvider mode="mock">
        <MessageThread channelId={null} />
      </ChatAPIProvider>,
    );
    expect(screen.getByText(/select a channel/i)).toBeInTheDocument();
  });

  it('renders seeded welcome message for the channel', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} />
      </ChatAPIProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome/i)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase B Slack-like additions: optional unread divider (design §6.2).
  // Additive — legacy callers omit `unreadAfterSeq` and see no divider.
  // ---------------------------------------------------------------------------

  it('does NOT render an unread divider when unreadAfterSeq is omitted', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Welcome/i)).toBeInTheDocument());
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });

  it('renders the unread divider after the matching seq when supplied', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    // Seed messages so we have multiple seqs to pick from.
    await client.sendMessage(channels[0].id, { content: 'second' });
    await client.sendMessage(channels[0].id, { content: 'third' });
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} unreadAfterSeq={1} />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/second/i)).toBeInTheDocument());
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
  });

  it('renders the divider at the top when the matching seq is below the loaded window', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} unreadAfterSeq={9999} />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Welcome/i)).toBeInTheDocument());
    // Divider still surfaces because there are messages but no matching seq.
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();
  });

  it('honours a custom unreadDividerLabel', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread
          channelId={channels[0].id}
          unreadAfterSeq={9999}
          unreadDividerLabel="Unread"
        />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Welcome/i)).toBeInTheDocument());
    const divider = screen.getByTestId('unread-divider');
    expect(divider).toHaveTextContent('Unread');
  });

  // ---------------------------------------------------------------------------
  // Slack-like flat layout (additive — default stays `bubble`).
  // ---------------------------------------------------------------------------

  it('default (bubble) layout renders messages in rounded bubbles', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    const { container } = render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Welcome/i)).toBeInTheDocument());
    expect(container.querySelector('.rounded-2xl')).not.toBeNull();
  });

  it('flat layout renders messages without chat bubbles', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    const { container } = render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} layout="flat" />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Welcome/i)).toBeInTheDocument());
    // No iMessage bubble styling in flat mode.
    expect(container.querySelector('.rounded-2xl')).toBeNull();
    // The own-message bubble fill (brand primary) must not appear in flat mode.
    expect(container.querySelector('.bg-primary')).toBeNull();
    // Flat messages are plain rows (cohesive surface) — no per-message
    // boxed/frosted body. The `glass-panel` treatment was removed so the
    // timeline reads as one whole, not a stack of isolated cards.
    expect(container.querySelector('.glass-panel')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Avatar helpers — pure, exercised independently per the 1:1 test policy.
// ---------------------------------------------------------------------------

describe('avatarInitials / avatarColor', () => {
  it('derives initials from a single-word name', () => {
    expect(avatarInitials('Sam')).toBe('SA');
  });

  it('derives initials from the first two words / segments', () => {
    expect(avatarInitials('crewly-orc')).toBe('CO');
    expect(avatarInitials('Crewly Product Team')).toBe('CP');
  });

  it('falls back to "?" for an empty name', () => {
    expect(avatarInitials('')).toBe('?');
  });

  it('is deterministic and returns a known palette class', () => {
    const a = avatarColor('Orchestrator');
    const b = avatarColor('Orchestrator');
    expect(a).toBe(b);
    expect(a.startsWith('bg-')).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Slack-style threading additions (additive — legacy callers omit the props).
// ---------------------------------------------------------------------------

describe('MessageThread threading', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = function () {
      /* no-op */
    };
  });

  const channel: Channel = {
    id: 'c-thread',
    agentSession: '',
    name: '#general',
    createdAt: '2026-04-25T00:00:00.000Z',
    type: 'channel',
    teamId: 't1',
  };

  const root: Message = {
    id: 'root-1',
    channelId: 'c-thread',
    seq: 1,
    author: { role: 'user', id: 'me', name: 'Me' },
    content: 'root message',
    createdAt: '2026-04-25T00:00:00.000Z',
    mentions: [],
    replyCount: 2,
    lastReplyAt: new Date().toISOString(),
  };
  const reply: Message = {
    id: 'reply-1',
    channelId: 'c-thread',
    seq: 2,
    author: { role: 'agent', id: 'sam', name: 'Sam' },
    content: 'a reply',
    createdAt: '2026-04-25T00:01:00.000Z',
    mentions: [],
    threadId: 'root-1',
  };

  function renderWith(props: Record<string, unknown>) {
    const client = new MockChatApiClient({
      initialChannels: [channel],
      initialMessages: { 'c-thread': [root, reply] },
    });
    return render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId="c-thread" layout="flat" {...props} />
      </ChatAPIProvider>,
    );
  }

  it('does not show reply affordances when onReplyInThread is omitted', async () => {
    renderWith({});
    await waitFor(() => expect(screen.getByText('root message')).toBeInTheDocument());
    expect(screen.queryByTestId('msg-reply-action-root-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('msg-thread-summary-root-1')).not.toBeInTheDocument();
  });

  it('renders the hover reply action + the N replies summary chip when enabled', async () => {
    const onReplyInThread = vi.fn();
    renderWith({ onReplyInThread });
    await waitFor(() => expect(screen.getByText('root message')).toBeInTheDocument());

    const action = screen.getByTestId('msg-reply-action-root-1');
    expect(action).toBeInTheDocument();
    const summary = screen.getByTestId('msg-thread-summary-root-1');
    expect(summary).toHaveTextContent('2 replies');

    fireEvent.click(summary);
    expect(onReplyInThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-1' }));
    fireEvent.click(action);
    expect(onReplyInThread).toHaveBeenCalledTimes(2);
  });

  it('hideReplies=true removes thread-reply rows from the main timeline', async () => {
    renderWith({ onReplyInThread: vi.fn(), hideReplies: true });
    await waitFor(() => expect(screen.getByText('root message')).toBeInTheDocument());
    expect(screen.queryByText('a reply')).not.toBeInTheDocument();
  });

  it('hideReplies=false (default) keeps thread-reply rows visible', async () => {
    renderWith({ onReplyInThread: vi.fn() });
    await waitFor(() => expect(screen.getByText('root message')).toBeInTheDocument());
    expect(screen.getByText('a reply')).toBeInTheDocument();
  });
  // ---------------------------------------------------------------------------
  // Controlled-feed mode: when `messages` is supplied the host owns the data
  // and the internal useMessages fetch is bypassed entirely.
  // ---------------------------------------------------------------------------

  it('renders controlled messages and skips the internal channel fetch', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    const controlled: Message[] = [
      {
        id: 'm-ctrl-1',
        channelId: channels[0].id,
        seq: 1,
        author: { role: 'agent', id: 'orc', name: 'Orchestrator' },
        content: 'merged-feed-message',
        createdAt: '2026-01-01T00:00:00.000Z',
        mentions: [],
      },
    ];
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageThread channelId={channels[0].id} layout="flat" messages={controlled} />
      </ChatAPIProvider>,
    );
    // The controlled message renders…
    expect(await screen.findByText('merged-feed-message')).toBeInTheDocument();
    // …and the channel's seeded "Welcome" message does NOT (fetch was skipped).
    expect(screen.queryByText(/Welcome/i)).not.toBeInTheDocument();
  });

  it('uses the controlled onLoadMore + hasMore for the "Load older" affordance', async () => {
    const onLoadMore = vi.fn();
    const controlled: Message[] = [
      {
        id: 'm-ctrl-2',
        channelId: 'orc',
        seq: 1,
        author: { role: 'agent', id: 'orc', name: 'Orchestrator' },
        content: 'hello',
        createdAt: '2026-01-01T00:00:00.000Z',
        mentions: [],
      },
    ];
    render(
      <ChatAPIProvider mode="mock">
        <MessageThread
          channelId="orc"
          layout="flat"
          messages={controlled}
          hasMore
          onLoadMore={onLoadMore}
        />
      </ChatAPIProvider>,
    );
    fireEvent.click(await screen.findByText('Load older'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('relativeTime', () => {
  it('renders "now" for a just-now timestamp', () => {
    expect(relativeTime(new Date().toISOString())).toBe('now');
  });

  it('renders minute / hour / day buckets', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe('5m');
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h');
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d');
  });

  it('returns empty string on an unparseable value', () => {
    expect(relativeTime('not-a-date')).toBe('');
  });
});

describe('formatDayLabel', () => {
  it('labels today as "Today" and yesterday as "Yesterday"', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    expect(formatDayLabel(now.toISOString())).toBe('Today');
    expect(formatDayLabel(yesterday.toISOString())).toBe('Yesterday');
  });

  it('labels older days with weekday + month + day', () => {
    const label = formatDayLabel('2026-05-29T12:00:00.000Z');
    expect(label).toMatch(/May/);
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(formatDayLabel('nope')).toBe('nope');
  });
});

describe('isNewDay', () => {
  it('returns true for the first message (no previous)', () => {
    expect(isNewDay(null, '2026-05-29T10:00:00.000Z')).toBe(true);
  });
  it('returns false within the same calendar day', () => {
    // Build LOCAL times so the assertion is timezone-independent (isNewDay
    // compares local calendar days).
    const morning = new Date(2026, 4, 29, 1, 0).toISOString();
    const evening = new Date(2026, 4, 29, 23, 0).toISOString();
    expect(isNewDay(morning, evening)).toBe(false);
  });
  it('returns true across a day boundary', () => {
    const lateNight = new Date(2026, 4, 29, 23, 0).toISOString();
    const nextMorning = new Date(2026, 4, 30, 0, 30).toISOString();
    expect(isNewDay(lateNight, nextMorning)).toBe(true);
  });
});

describe('stripInternalHints', () => {
  it('removes a trailing "[Thread context file: …]" hint', () => {
    const raw = 'real reply text\n\n[Thread context file: /Users/x/.crewly/slack-threads/C-1.md]';
    expect(stripInternalHints(raw)).toBe('real reply text');
  });
  it('leaves clean content untouched (just trimmed)', () => {
    expect(stripInternalHints('hello world')).toBe('hello world');
  });
  it('removes an inline hint mid-content too (absorbing the leading space)', () => {
    expect(stripInternalHints('a [Thread context file: /p/x.md] b')).toBe('a b');
  });
});
