/**
 * Tests for the cross-conversation message search column (#1400).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ChatSearchHit } from '@crewly/chat-ui';
import { ChatSearchResults, highlightTerms, hitConversationLabel, formatHitTime, SEARCH_LIMIT } from './ChatSearchResults';

const HITS: ChatSearchHit[] = [
  { id: 'm2', time: '2026-10-25T08:00:00.000Z', channelId: 'ch-ops', channel: '#ops', channelType: 'huddle', sender: 'Pia', senderType: 'agent', text: 'Docker reset done, service back', threadId: null },
  { id: 'm1', time: '2026-10-24T08:00:00.000Z', channelId: 'dm-orc', channel: 'crewly-orc', channelType: 'dm', sender: 'Steve', senderType: 'user', text: 'docker will not start', threadId: null },
];

function makeClient(hits: ChatSearchHit[] = HITS) {
  const searchMessages = vi.fn(async (_q: string) => hits);
  return { client: { searchMessages }, searchMessages };
}

describe('highlightTerms', () => {
  it('marks every word, case-insensitively, and leaves the rest plain', () => {
    expect(highlightTerms('Docker reset done', 'docker done')).toEqual([
      { text: 'Docker', match: true },
      { text: ' reset ', match: false },
      { text: 'done', match: true },
    ]);
  });

  it('returns the text unmarked for an empty query', () => {
    expect(highlightTerms('hello', '  ')).toEqual([{ text: 'hello', match: false }]);
  });
});

describe('hitConversationLabel / formatHitTime', () => {
  it('prefixes channels and group chats with #, names DMs after the list title when known', () => {
    expect(hitConversationLabel(HITS[0])).toBe('#ops');
    expect(hitConversationLabel(HITS[1])).toBe('crewly-orc');
    expect(hitConversationLabel(HITS[1], (id) => (id === 'dm-orc' ? 'Orchestrator' : undefined))).toBe('Orchestrator');
  });

  it('shows only the time for today and the date otherwise; bad input is empty', () => {
    const now = new Date('2026-10-25T10:00:00.000Z');
    expect(formatHitTime('2026-10-25T08:00:00.000Z', now)).not.toMatch(/Oct/);
    expect(formatHitTime('2026-10-09T08:00:00.000Z', now)).toMatch(/Oct/);
    expect(formatHitTime('nonsense', now)).toBe('');
  });
});

describe('ChatSearchResults', () => {
  it('searches on open, lists the hits with the words marked, and opens a hit with the query', async () => {
    const { client, searchMessages } = makeClient();
    const onOpen = vi.fn();
    render(<ChatSearchResults client={client} initialQuery="docker" onOpen={onOpen} onClose={vi.fn()} conversationNameOf={(id) => (id === 'dm-orc' ? 'Orchestrator' : undefined)} />);
    await waitFor(() => expect(screen.getByTestId('chat-search-status')).toHaveTextContent('2 messages match.'));
    expect(searchMessages).toHaveBeenCalledWith('docker', { limit: SEARCH_LIMIT });
    const hits = within(screen.getByTestId('chat-search-hits')).getAllByRole('button');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toHaveTextContent('#ops');
    expect(hits[1]).toHaveTextContent('Orchestrator');
    expect(within(hits[0]).getByText('Docker').tagName).toBe('MARK');
    fireEvent.click(screen.getByTestId('chat-search-hit-m1'));
    expect(onOpen).toHaveBeenCalledWith(HITS[1], 'docker');
  });

  it('re-searches on submit, says when nothing matches, and closes on Escape', async () => {
    const { client, searchMessages } = makeClient([]);
    const onClose = vi.fn();
    render(<ChatSearchResults client={client} initialQuery="docker" onOpen={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('chat-search-status')).toHaveTextContent('No messages match.'));
    fireEvent.change(screen.getByTestId('chat-search-input'), { target: { value: 'docker reset' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(searchMessages).toHaveBeenLastCalledWith('docker reset', { limit: SEARCH_LIMIT }));
    fireEvent.keyDown(screen.getByTestId('chat-search-input'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server error and tells the user when the cap was hit', async () => {
    const failing = { searchMessages: vi.fn(async () => { throw new Error('forbidden'); }) };
    render(<ChatSearchResults client={failing} initialQuery="x" onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('chat-search-status')).toHaveTextContent('forbidden'));

    const many = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({ ...HITS[0], id: `h${i}` }));
    const { client } = makeClient(many);
    render(<ChatSearchResults client={client} initialQuery="docker" onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByTestId('chat-search-status')[1]).toHaveTextContent(`newest ${SEARCH_LIMIT}`));
  });

  it('explains when the client cannot search', async () => {
    render(<ChatSearchResults client={{}} initialQuery="docker" onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('chat-search-status')).toHaveTextContent('cannot search messages'));
  });
});
