/**
 * Tests for StarterTeamStep.
 *
 * @module components/Onboarding/StarterTeamStep.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StarterTeamStep } from './StarterTeamStep';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import { STARTERS } from '../../test/onboarding.fixtures';

vi.mock('../../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: {
    getStarters: vi.fn(),
    createStarterTeam: vi.fn(),
  },
}));

const svc = vi.mocked(onboardingChecklistService);

describe('StarterTeamStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getStarters.mockResolvedValue(STARTERS);
  });

  it('pre-selects the recommended Personal Assistant and creates it', async () => {
    svc.createStarterTeam.mockResolvedValue({
      starterId: 'personal-assistant-team',
      team: { id: 't1', name: 'Personal Assistant', members: [] },
      created: true,
    });
    const onDone = vi.fn();
    render(<StarterTeamStep onDone={onDone} />);

    const pa = await screen.findByTestId('starter-personal-assistant-team');
    expect(pa).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getByText('Assistant、Researcher')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('starter-create'));
    });
    expect(svc.createStarterTeam).toHaveBeenCalledWith('personal-assistant-team');
    expect(onDone).toHaveBeenCalledWith({
      starterId: 'personal-assistant-team',
      teamId: 't1',
      teamName: 'Personal Assistant',
      suggestions: STARTERS[0].suggestions,
    });
  });

  it('lets Blank be chosen (no team) with its own button label', async () => {
    svc.createStarterTeam.mockResolvedValue({ starterId: 'blank', team: null, created: false });
    const onDone = vi.fn();
    render(<StarterTeamStep onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('starter-blank'));
    expect(screen.getByTestId('starter-blank')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('starter-create')).toHaveTextContent('先只用 Orc');
    await act(async () => {
      fireEvent.click(screen.getByTestId('starter-create'));
    });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ starterId: 'blank', teamId: null }));
  });

  it('selects with the keyboard', async () => {
    render(<StarterTeamStep onDone={vi.fn()} />);
    const mkt = await screen.findByTestId('starter-growth-marketing-team');
    fireEvent.keyDown(mkt, { key: 'Enter' });
    expect(mkt).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a create error', async () => {
    svc.createStarterTeam.mockRejectedValue(new Error('disk full'));
    render(<StarterTeamStep onDone={vi.fn()} />);
    await screen.findByTestId('starter-personal-assistant-team');
    await act(async () => {
      fireEvent.click(screen.getByTestId('starter-create'));
    });
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('shows a load error with retry', async () => {
    svc.getStarters.mockRejectedValueOnce(new Error('offline'));
    render(<StarterTeamStep onDone={vi.fn()} />);
    expect(await screen.findByText('offline')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
    });
    expect(await screen.findByTestId('starter-personal-assistant-team')).toBeInTheDocument();
  });
});
