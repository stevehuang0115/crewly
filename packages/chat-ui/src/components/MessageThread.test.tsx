import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { MessageThread } from './MessageThread';

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
});
