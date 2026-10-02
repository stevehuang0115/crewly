/**
 * Tests for MessageThread's additive `variant="quiet"` (the simplified OSS
 * chat): quiet header line, folded long messages, actions behind "⋯".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChatAPIProvider } from '../context/ChatAPIProvider';
import { MockChatApiClient } from '../api/mock-client';
import { MessageThread, messageDetails, quietTimeLabel, shouldFoldMessage } from './MessageThread';
import type { Message } from '../types/chat.types';

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    channelId: 'c1',
    seq: 1,
    author: { role: 'agent', id: 'crewly-orc', name: 'Orchestrator' },
    content: 'The deploy is live.',
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    mentions: [],
    ...over,
  } as Message;
}

function renderQuiet(messages: Message[], onReplyInThread?: (m: Message) => void) {
  return render(
    <ChatAPIProvider client={new MockChatApiClient()} mode="mock">
      <MessageThread channelId="c1" layout="flat" variant="quiet" messages={messages} onReplyInThread={onReplyInThread} />
    </ChatAPIProvider>,
  );
}

describe('MessageThread variant="quiet"', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = function () {
      /* jsdom no-op */
    };
  });

  it('shows name + relative time on one line, no avatar or AGENT tag', () => {
    renderQuiet([msg()]);
    const row = screen.getByTestId('msg-m1');
    expect(within(row).getByText('Orchestrator')).toHaveAttribute('title', 'Agent');
    expect(within(row).getByText('· 3h ago')).toBeInTheDocument();
    expect(within(row).queryByText('Agent')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-thread').querySelector('[data-variant="quiet"]')).not.toBeNull();
  });

  it('folds long messages behind "Show more"', () => {
    renderQuiet([msg({ content: 'x'.repeat(900) })]);
    const toggle = screen.getByTestId('msg-fold-m1');
    expect(toggle).toHaveTextContent('Show more');
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('Show less');
  });

  it('puts Reply in thread, Copy text and the details line behind ⋯', () => {
    const onReply = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderQuiet([msg({ channelId: 'slack-C1-1' })], onReply);
    fireEvent.click(screen.getByTestId('msg-more-m1'));
    const menu = screen.getByTestId('msg-menu-m1');
    expect(within(menu).getByText(/via Slack/)).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Add reaction/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy text' }));
    expect(writeText).toHaveBeenCalledWith('The deploy is live.');
    fireEvent.click(screen.getByTestId('msg-more-m1'));
    fireEvent.click(screen.getByTestId('msg-menu-reply-m1'));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('keeps the "N replies" link and the hover reply action', () => {
    const onReply = vi.fn();
    renderQuiet([msg({ replyCount: 2 })], onReply);
    fireEvent.click(screen.getByTestId('msg-thread-summary-m1'));
    fireEvent.click(screen.getByTestId('msg-reply-action-m1'));
    expect(onReply).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('msg-thread-summary-m1')).toHaveTextContent('2 replies');
  });

  it('groups consecutive messages under one header', () => {
    renderQuiet([msg(), msg({ id: 'm2', seq: 2, content: 'Second.' })]);
    expect(screen.getAllByText('Orchestrator')).toHaveLength(1);
    // Follow-ups leave room for the always-visible ⋯ on phones.
    expect(screen.getByText('Second.').closest('div')?.className).toContain('pr-9 md:pr-0');
  });

  it('helpers: fold threshold, time label, details', () => {
    expect(shouldFoldMessage('short')).toBe(false);
    expect(shouldFoldMessage(Array.from({ length: 12 }, () => 'l').join('\n'))).toBe(true);
    expect(quietTimeLabel(new Date().toISOString())).toBe('just now');
    expect(quietTimeLabel('nope')).toBe('');
    expect(messageDetails(msg({ deliveryStatus: 'failed' }))).toMatch(/· not sent$/);
  });
});
