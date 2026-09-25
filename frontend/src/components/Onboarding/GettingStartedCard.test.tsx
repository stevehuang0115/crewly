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
    expect(screen.getByText('开始使用')).toBeInTheDocument();
    expect(screen.getByText('已完成 2/5 步')).toBeInTheDocument();
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

  it('sends the harness step to the start of setup', () => {
    expect(stepRoute('harness')).toBe('/setup');
    expect(stepRoute('cloud')).toBe('/setup?step=cloud');
  });
});
