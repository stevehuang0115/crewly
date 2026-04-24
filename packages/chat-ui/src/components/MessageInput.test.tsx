import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { MessageInput } from './MessageInput';

describe('MessageInput', () => {
  it('disables the Send button with empty whitespace input', async () => {
    render(
      <ChatAPIProvider mode="mock">
        <MessageInput channelId="ch-1" />
      </ChatAPIProvider>,
    );
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/Enter to send/i);
    await userEvent.type(textarea, '   ');
    expect(send).toBeDisabled();
  });

  it('sends via Enter and clears the input on success', async () => {
    const client = new MockChatApiClient();
    const channels = await client.listChannels();
    render(
      <ChatAPIProvider client={client} mode="mock">
        <MessageInput channelId={channels[0].id} />
      </ChatAPIProvider>,
    );

    const textarea = screen.getByPlaceholderText(/Enter to send/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, 'hello there{enter}');

    await waitFor(() => {
      expect(textarea.value).toBe('');
    });
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    render(
      <ChatAPIProvider mode="mock">
        <MessageInput channelId="ch-1" />
      </ChatAPIProvider>,
    );

    const textarea = screen.getByPlaceholderText(/Enter to send/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, 'line1{shift>}{enter}{/shift}line2');

    expect(textarea.value).toBe('line1\nline2');
  });

  it('shows a "select a channel" placeholder when channelId is null', () => {
    render(
      <ChatAPIProvider mode="mock">
        <MessageInput channelId={null} />
      </ChatAPIProvider>,
    );
    expect(
      screen.getByPlaceholderText(/Select a channel to send a message/i),
    ).toBeInTheDocument();
  });
});
