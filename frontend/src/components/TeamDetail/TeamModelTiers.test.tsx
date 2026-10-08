/**
 * Tests for TeamModelTiers — "Optimize usage" switch and member tiers (crewly#1173).
 *
 * @module components/TeamDetail/TeamModelTiers.test
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamModelTiers, shortDay } from './TeamModelTiers';

const getMock = vi.fn();
const updateMock = vi.fn();
const reviewMock = vi.fn();
vi.mock('../../services/api.service', () => ({
  apiService: {
    getTeamModelTiers: (id: string) => getMock(id),
    updateTeamModelTiers: (id: string, patch: unknown) => updateMock(id, patch),
    startTeamModelTierReview: (id: string) => reviewMock(id),
  },
}));

const settings = (over: Record<string, unknown> = {}) => ({
  teamId: 't1',
  optimizeUsage: false,
  tierModels: {},
  routingRules: [],
  tierMaps: { 'claude-code': { strong: 'opus', mid: 'sonnet', weak: 'haiku' } },
  members: [
    { id: 'm-owen', name: 'Owen', isLead: true, runtime: 'claude-code', tier: null, modelId: null, model: 'runtime default' },
    { id: 'm-ella', name: 'Ella', isLead: false, runtime: 'claude-code', tier: 'weak', modelId: null, model: 'haiku' },
  ],
  review: { lastReviewAt: null, nextReviewAt: null, drafting: false, openDecisionId: null, recent: [] },
  ...over,
});

describe('TeamModelTiers', () => {
  beforeEach(() => {
    getMock.mockReset();
    updateMock.mockReset();
    reviewMock.mockReset();
  });

  it('shows the switch off and each member tier and model', async () => {
    getMock.mockResolvedValue(settings());
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-model-tiers')).toBeInTheDocument());
    const toggle = screen.getByLabelText('Optimize usage') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect((screen.getByLabelText('Tier of Ella') as HTMLSelectElement).value).toBe('weak');
    expect(screen.getByTestId('tier-row-m-owen')).toHaveTextContent('Owen (lead)');
    expect(screen.getByTestId('tier-row-m-ella')).toHaveTextContent('runs haiku');
    expect(screen.queryByText('Review now')).not.toBeInTheDocument();
  });

  it('turns Optimize usage on', async () => {
    getMock.mockResolvedValue(settings());
    updateMock.mockResolvedValue(settings({ optimizeUsage: true, review: { lastReviewAt: null, nextReviewAt: '2026-10-08T12:00:00Z', drafting: false, openDecisionId: null, recent: [] } }));
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-model-tiers')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Optimize usage'));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('t1', { optimizeUsage: true }));
    await waitFor(() => expect((screen.getByLabelText('Optimize usage') as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText('Review now')).toBeInTheDocument();
  });

  it('sets a member tier', async () => {
    getMock.mockResolvedValue(settings());
    updateMock.mockResolvedValue(settings());
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-model-tiers')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Tier of Owen'), { target: { value: 'mid' } });
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('t1', { memberTiers: { 'm-owen': 'mid' } }));
  });

  it('asks for a review now and says who got it', async () => {
    getMock.mockResolvedValue(settings({ optimizeUsage: true }));
    reviewMock.mockResolvedValue({ reviewId: 'TR-1', lead: 'Owen', delivered: true });
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByText('Review now')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Review now'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Review sent to Owen'));
  });

  it('shows an open proposal and disables Review now', async () => {
    getMock.mockResolvedValue(settings({ optimizeUsage: true, review: { lastReviewAt: null, nextReviewAt: null, drafting: false, openDecisionId: 'D-12', recent: [] } }));
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('tier-review-state')).toHaveTextContent('Proposal D-12 waits for your answer'));
    expect(screen.getByText('Review now').closest('button')).toBeDisabled();
  });

  it('shows the server refusal', async () => {
    getMock.mockResolvedValue(settings());
    updateMock.mockRejectedValue(new Error('Only the owner changes model tiers'));
    render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(screen.getByTestId('team-model-tiers')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Optimize usage'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Only the owner changes model tiers'));
  });

  it('stays hidden when the request fails', async () => {
    getMock.mockRejectedValue(new Error('404'));
    const { container } = render(<TeamModelTiers teamId="t1" />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shortDay handles null and bad dates', () => {
    expect(shortDay(null)).toBe('–');
    expect(shortDay('nope')).toBe('–');
  });
});
