/**
 * Tests for the Dashboard "Waiting on you" card.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WaitingOnYouCard, fallbackLine } from './WaitingOnYouCard';
import type { OwnerDecision } from '../../types/decision.types';

vi.mock('../../services/decisions.service', () => ({
  listOpenDecisions: vi.fn(),
  chooseDecision: vi.fn(),
  remindDecisionTomorrow: vi.fn(),
}));

import { chooseDecision, listOpenDecisions, remindDecisionTomorrow } from '../../services/decisions.service';

function decision(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-7',
    question: 'Send the draft to the 3 partners?',
    options: [
      { key: 'a', label: 'Send Monday', detail: 'after the review call' },
      { key: 'b', label: 'Hold' },
    ],
    defaultKey: 'b',
    deadline: '2026-10-02T16:00:00.000Z',
    requestedBy: 'tl-sam',
    asker: 'dev-ann',
    ticket: { projectId: 'p1', projectPath: '/p', id: 'APP-12', title: 'Partner outreach email' },
    status: 'open',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(listOpenDecisions).mockReset();
  vi.mocked(chooseDecision).mockReset();
  vi.mocked(remindDecisionTomorrow).mockReset();
});

describe('WaitingOnYouCard', () => {
  it('renders nothing when no decision is waiting', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([]);
    const { container } = render(<WaitingOnYouCard />);
    await waitFor(() => expect(listOpenDecisions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the ticket header, question, options, asker and the fallback line', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision()]);
    render(<WaitingOnYouCard />);
    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText('APP-12 · Partner outreach email')).toBeInTheDocument();
    expect(screen.getByText('Send the draft to the 3 partners?')).toBeInTheDocument();
    expect(screen.getByText('Send Monday')).toBeInTheDocument();
    expect(screen.getByText('after the review call')).toBeInTheDocument();
    expect(screen.getByText('Hold')).toBeInTheDocument();
    expect(screen.getByText('Remind me tomorrow')).toBeInTheDocument();
    expect(screen.getByText('asked by dev-ann')).toBeInTheDocument();
    expect(screen.getByText(/If no answer by .*, I'll Hold\./)).toBeInTheDocument();
  });

  it('clicking an option calls choose with the option key, then refreshes', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValueOnce([decision()]).mockResolvedValue([]);
    vi.mocked(chooseDecision).mockResolvedValue(decision({ status: 'resolved', chosenKey: 'a' }));
    render(<WaitingOnYouCard />);
    fireEvent.click(await screen.findByText('Send Monday'));
    await waitFor(() => expect(chooseDecision).toHaveBeenCalledWith('D-7', 'a'));
    await waitFor(() => expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument());
  });

  it('"Remind me tomorrow" calls remind', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision()]);
    vi.mocked(remindDecisionTomorrow).mockResolvedValue(decision());
    render(<WaitingOnYouCard />);
    fireEvent.click(await screen.findByText('Remind me tomorrow'));
    await waitFor(() => expect(remindDecisionTomorrow).toHaveBeenCalledWith('D-7'));
  });

  it('shows an API error and keeps the card', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision()]);
    vi.mocked(chooseDecision).mockRejectedValue(new Error('Decision D-7 is resolved'));
    render(<WaitingOnYouCard />);
    fireEvent.click(await screen.findByText('Hold'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Decision D-7 is resolved');
  });

  it('fallback line: parked, sensitive and wait defaults', () => {
    expect(fallbackLine(decision({ status: 'parked' }))).toBe('Parked — needs your answer');
    expect(fallbackLine(decision({ sensitive: 'deploy' }))).toMatch(/^Needs your OK/);
    expect(fallbackLine(decision({ defaultKey: 'wait' }))).toMatch(/I'll wait\.$/);
  });
});
