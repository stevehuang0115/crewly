import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { MessageThread, avatarInitials, avatarColor } from './MessageThread';

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
