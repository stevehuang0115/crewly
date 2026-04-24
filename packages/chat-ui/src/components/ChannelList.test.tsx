import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { ChannelList } from './ChannelList';

describe('ChannelList', () => {
  it('renders the seeded channels from the mock client', async () => {
    const client = new MockChatApiClient();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <ChannelList />
      </ChatAPIProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading channels/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Ella · Marketing/)).toBeInTheDocument();
  });

  it('calls onSelectChannel with the channel when a row is clicked', async () => {
    const client = new MockChatApiClient();
    const onSelect = vi.fn();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <ChannelList onSelectChannel={onSelect} />
      </ChatAPIProvider>,
    );
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());

    await userEvent.click(screen.getByText(/Ella · Marketing/));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toMatch(/Ella/);
  });

  it('shows the empty state when there are no channels', async () => {
    const client = new MockChatApiClient({ initialChannels: [] });
    render(
      <ChatAPIProvider client={client} mode="mock">
        <ChannelList />
      </ChatAPIProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/No channels yet/)).toBeInTheDocument();
    });
  });
});
