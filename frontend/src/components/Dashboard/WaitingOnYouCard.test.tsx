/**
 * Tests for the Dashboard "Waiting on you" section (compact rows, answers in ⋯).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { WaitingOnYouCard, canSkip, fallbackLine, startOfToday, decisionMeta, WAITING_ON_YOU_VISIBLE } from './WaitingOnYouCard';
import type { OwnerDecision } from '../../types/decision.types';

vi.mock('../../services/decisions.service', () => ({
  listOpenDecisions: vi.fn(),
  chooseDecision: vi.fn(),
  remindDecisionTomorrow: vi.fn(),
  skipDecision: vi.fn(),
  skipAllDecisions: vi.fn(),
}));

import { chooseDecision, listOpenDecisions, remindDecisionTomorrow, skipAllDecisions, skipDecision } from '../../services/decisions.service';

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
  vi.mocked(skipDecision).mockReset();
  vi.mocked(skipAllDecisions).mockReset();
});

/** Open a row's "⋯" menu. */
function openMenu(id = 'D-7'): void {
  const row = screen.getByTestId(`decision-row-${id}`);
  fireEvent.click(within(row).getByRole('button', { name: /More options/ }));
}

const directory = new Map([['dev-ann', { name: 'Ann', team: 'Growth' }]]);

describe('WaitingOnYouCard', () => {
  it('renders nothing when no decision is waiting', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([]);
    const { container } = render(<WaitingOnYouCard />);
    await waitFor(() => expect(listOpenDecisions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('with showEmpty, says nothing needs the owner', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([]);
    render(<WaitingOnYouCard showEmpty />);
    expect(await screen.findByText('Nothing needs you right now.')).toBeInTheDocument();
  });

  it('one compact row: question, who/ticket/when, two answers; the rest and the fallback line behind ⋯', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([
      decision({ options: [{ key: 'a', label: 'Send Monday', detail: 'after the review call' }, { key: 'b', label: 'Hold' }, { key: 'c', label: 'Reply in thread', detail: "you'll answer in words in this thread" }] }),
    ]);
    render(<WaitingOnYouCard directory={directory} />);
    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText('Send the draft to the 3 partners?')).toBeInTheDocument();
    expect(screen.getByText(/^Ann · Partner outreach email · /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Monday' })).toHaveAttribute('title', 'after the review call');
    expect(screen.getByRole('button', { name: 'Hold' })).toBeInTheDocument();
    expect(screen.queryByText('Remind me tomorrow')).not.toBeInTheDocument();
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Reply in thread' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remind me tomorrow' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByText(/If no answer by .*, I'll Hold\./)).toBeInTheDocument();
  });

  it('"Reply in thread" in ⋯ answers with its option key', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([
      decision({ options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }, { key: 'c', label: 'Reply in thread' }] }),
    ]);
    vi.mocked(chooseDecision).mockResolvedValue(decision({ status: 'resolved', chosenKey: 'c' }));
    render(<WaitingOnYouCard />);
    await screen.findByText('Yes');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply in thread' }));
    await waitFor(() => expect(chooseDecision).toHaveBeenCalledWith('D-7', 'c'));
  });

  it('clicking an answer calls choose with the option key, then refreshes', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValueOnce([decision()]).mockResolvedValue([]);
    vi.mocked(chooseDecision).mockResolvedValue(decision({ status: 'resolved', chosenKey: 'a' }));
    render(<WaitingOnYouCard />);
    fireEvent.click(await screen.findByText('Send Monday'));
    await waitFor(() => expect(chooseDecision).toHaveBeenCalledWith('D-7', 'a'));
    await waitFor(() => expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument());
  });

  it('"Remind me tomorrow" (in ⋯) calls remind', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision()]);
    vi.mocked(remindDecisionTomorrow).mockResolvedValue(decision());
    render(<WaitingOnYouCard />);
    await screen.findByText('Hold');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remind me tomorrow' }));
    await waitFor(() => expect(remindDecisionTomorrow).toHaveBeenCalledWith('D-7'));
  });

  it('shows an API error and keeps the row', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision()]);
    vi.mocked(chooseDecision).mockRejectedValue(new Error('Decision D-7 is resolved'));
    render(<WaitingOnYouCard />);
    fireEvent.click(await screen.findByText('Hold'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Decision D-7 is resolved');
    expect(screen.getByText('Send the draft to the 3 partners?')).toBeInTheDocument();
  });

  it('flags sensitive and parked cards in the meta line', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision({ sensitive: 'publish' }), decision({ id: 'D-8', status: 'parked' })]);
    render(<WaitingOnYouCard />);
    expect(await screen.findByText('· needs your OK to publish')).toBeInTheDocument();
    expect(screen.getByText('· parked')).toBeInTheDocument();
  });

  it('shows five rows, then "Show all N"', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue(Array.from({ length: 7 }, (_, i) => decision({ id: `D-${i}`, question: `Question ${i}?` })));
    render(<WaitingOnYouCard />);
    await screen.findByText('Question 0?');
    expect(screen.getAllByTestId(/^decision-row-D-\d+$/)).toHaveLength(WAITING_ON_YOU_VISIBLE);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByTestId(/^decision-row-D-\d+$/)).toHaveLength(7);
  });

  it('fallback line: parked, sensitive and wait defaults', () => {
    expect(fallbackLine(decision({ status: 'parked' }))).toBe('Parked — needs your answer');
    expect(fallbackLine(decision({ sensitive: 'deploy' }))).toMatch(/^Needs your OK/);
    expect(fallbackLine(decision({ defaultKey: 'wait' }))).toMatch(/I'll wait\.$/);
  });

  it('meta line: agent name, ticket or team, relative time; raw session when unknown', () => {
    expect(decisionMeta(decision({ ticket: undefined }), directory)).toMatch(/^Ann · Growth · \d+d ago$/);
    expect(decisionMeta(decision({ asker: 'crewly-orc', ticket: undefined }), new Map())).toMatch(/^Orchestrator · /);
    expect(decisionMeta(decision({ asker: 'who-1', ticket: undefined }), new Map())).toMatch(/^who-1 · /);
  });
});

describe('WaitingOnYouCard — Skip (specs/2026-10-01-decision-skip.md)', () => {
  const today = () => new Date().toISOString();
  const yesterday = () => new Date(startOfToday().getTime() - 3 * 60 * 60 * 1000).toISOString();

  it('"Skip" (in ⋯) calls skip; it is not offered on sensitive or system cards', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision({ createdAt: today() }), decision({ id: 'D-8', sensitive: 'email', createdAt: today() })]);
    vi.mocked(skipDecision).mockResolvedValue(decision({ status: 'skipped' }));
    render(<WaitingOnYouCard />);
    await screen.findAllByText('Hold');
    openMenu('D-8');
    expect(screen.queryByRole('menuitem', { name: 'Skip' })).not.toBeInTheDocument();
    openMenu('D-7');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Skip' }));
    await waitFor(() => expect(skipDecision).toHaveBeenCalledWith('D-7'));
    expect(canSkip({ system: { key: 'agy' } })).toBe(false);
    expect(canSkip({ kind: 'browser_action' })).toBe(false);
    expect(canSkip({ kind: 'reply_question' })).toBe(true);
  });

  it('"Skip all from before today" appears for older cards and skips them after a confirm', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision({ createdAt: yesterday() }), decision({ id: 'D-8', createdAt: yesterday() }), decision({ id: 'D-9', createdAt: today() })]);
    vi.mocked(skipAllDecisions).mockResolvedValue({ dryRun: false, matched: 2, settled: ['D-7', 'D-8'], rows: [] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<WaitingOnYouCard />);
    const button = await screen.findByText('Skip all from before today');
    expect(button).toHaveAttribute('title', 'Skip 2 cards from before today');
    fireEvent.click(button);
    expect(skipAllDecisions).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(skipAllDecisions).toHaveBeenCalledWith({ olderThan: startOfToday().toISOString(), source: 'all' }));
    expect(confirm).toHaveBeenLastCalledWith('Skip 2 cards from before today? Their agents will be told to drop them.');
    confirm.mockRestore();
  });

  it('no bulk button when every card is from today', async () => {
    vi.mocked(listOpenDecisions).mockResolvedValue([decision({ createdAt: today() })]);
    render(<WaitingOnYouCard />);
    await screen.findByText('Waiting on you');
    expect(screen.queryByText(/Skip all from before today/)).not.toBeInTheDocument();
  });
});
