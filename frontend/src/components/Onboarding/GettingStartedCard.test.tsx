/**
 * Tests for the dashboard "开始使用" card.
 *
 * @module components/Onboarding/GettingStartedCard.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GettingStartedCard, stepRoute } from './GettingStartedCard';
import { useOnboardingChecklist } from '../../hooks/useOnboardingChecklist';
import { makeChecklist } from '../../test/onboarding.fixtures';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../hooks/useOnboardingChecklist', () => ({
  useOnboardingChecklist: vi.fn(),
}));

const mockHook = vi.mocked(useOnboardingChecklist);
const setDismissed = vi.fn();

/**
 * Make the hook return a checklist.
 *
 * @param checklist - Checklist or null
 */
function withChecklist(checklist: ReturnType<typeof makeChecklist> | null): void {
  mockHook.mockReturnValue({ checklist, loading: false, error: null, refresh: vi.fn(), setDismissed });
}

describe('GettingStartedCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the five steps with progress and continues at the first open one', () => {
    withChecklist(makeChecklist(['harness', 'team']));
    render(<GettingStartedCard />);
    expect(screen.getByText('Get started')).toBeInTheDocument();
    expect(screen.getByText('2/5 steps done')).toBeInTheDocument();
    expect(screen.getByTestId('getting-started-step-harness')).toBeDisabled();
    fireEvent.click(screen.getByTestId('getting-started-continue'));
    expect(mockNavigate).toHaveBeenCalledWith('/setup?step=first_task');
    fireEvent.click(screen.getByTestId('getting-started-step-slack'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/setup?step=slack');
  });

  it('can be hidden', async () => {
    withChecklist(makeChecklist());
    render(<GettingStartedCard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('getting-started-dismiss'));
    });
    expect(setDismissed).toHaveBeenCalledWith(true);
  });

  it('renders nothing when loading, all done, or dismissed', () => {
    withChecklist(null);
    const { container, rerender } = render(<GettingStartedCard />);
    expect(container).toBeEmptyDOMElement();
    withChecklist(makeChecklist(['harness', 'team', 'first_task', 'cloud', 'slack']));
    rerender(<GettingStartedCard />);
    expect(container).toBeEmptyDOMElement();
    withChecklist(makeChecklist([], { dismissed: true }));
    rerender(<GettingStartedCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the optional Chrome step after Slack, opens the Web Store in a new tab, and never makes it the Continue target', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    withChecklist(makeChecklist(['harness', 'team', 'first_task', 'cloud', 'slack'], { allDone: false }));
    render(<GettingStartedCard />);
    const rows = screen.getAllByTestId(/^getting-started-step-/).map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual([
      'getting-started-step-harness',
      'getting-started-step-team',
      'getting-started-step-first_task',
      'getting-started-step-cloud',
      'getting-started-step-slack',
      'getting-started-step-chrome',
    ]);
    expect(screen.getByTestId('getting-started-optional-chrome')).toHaveTextContent('Optional');
    // Counts are over the required steps only.
    expect(screen.getByText('5/5 steps done')).toBeInTheDocument();
    // Continue skips the optional step: it is not the next required step.
    expect(screen.queryByTestId('getting-started-continue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('getting-started-step-chrome'));
    expect(open).toHaveBeenCalledWith(
      'https://chromewebstore.google.com/detail/crewly-in-chrome/mekcefkcdgefjhadkcbkdpmilcaekhnc?utm_source=crewly-app&utm_medium=checklist&utm_campaign=chrome-ext-usage',
      '_blank',
      'noopener,noreferrer',
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('marks the Chrome step done when a browser is connected', () => {
    withChecklist(makeChecklist(['harness', 'team', 'chrome']));
    render(<GettingStartedCard />);
    expect(screen.getByTestId('getting-started-step-chrome')).toBeDisabled();
    // Chrome done does not count toward the 5: harness + team = 2/5.
    expect(screen.getByText('2/5 steps done')).toBeInTheDocument();
  });

  it('is hidden at 100% of the required steps even though Chrome is not connected', () => {
    withChecklist(makeChecklist(['harness', 'team', 'first_task', 'cloud', 'slack']));
    const { container } = render(<GettingStartedCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sends the harness step to the start of setup', () => {
    expect(stepRoute('harness')).toBe('/setup');
    expect(stepRoute('cloud')).toBe('/setup?step=cloud');
  });
});
