/**
 * Tests for SlackConnectStep.
 *
 * @module components/Onboarding/SlackConnectStep.test
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackConnectStep, SLACK_SETTINGS_PATH } from './SlackConnectStep';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';

vi.mock('../../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: { getSlackInstallUrl: vi.fn(), refreshSlack: vi.fn() },
}));

const svc = vi.mocked(onboardingChecklistService);

describe('SlackConnectStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.refreshSlack.mockResolvedValue({ connected: false, cloudConnected: true });
  });

  it('shows the connected state without asking the backend', () => {
    render(<SlackConnectStep connected cloudConnected onGoToCloud={vi.fn()} onConnected={vi.fn()} />);
    expect(screen.getByTestId('slack-connected')).toBeInTheDocument();
    expect(svc.refreshSlack).not.toHaveBeenCalled();
  });

  it('asks for Crewly Cloud first', () => {
    const onGoToCloud = vi.fn();
    render(<SlackConnectStep connected={false} cloudConnected={false} onGoToCloud={onGoToCloud} onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '去连接 Crewly Cloud' }));
    expect(onGoToCloud).toHaveBeenCalled();
    expect(svc.refreshSlack).not.toHaveBeenCalled();
  });

  it('opens the Cloud install link that returns to /setup?step=slack', async () => {
    svc.getSlackInstallUrl.mockResolvedValue('https://api.crewlyai.com/api/cloud/slack/install?token=x');
    const navigateTo = vi.fn();
    render(<SlackConnectStep connected={false} cloudConnected onGoToCloud={vi.fn()} onConnected={vi.fn()} navigateTo={navigateTo} />);
    expect(screen.getByRole('link', { name: /更多 Slack 设置/ })).toHaveAttribute('href', SLACK_SETTINGS_PATH);
    await act(async () => {
      fireEvent.click(screen.getByTestId('slack-install'));
    });
    expect(svc.getSlackInstallUrl).toHaveBeenCalledWith(`${window.location.origin}/setup?step=slack`);
    expect(navigateTo).toHaveBeenCalledWith('https://api.crewlyai.com/api/cloud/slack/install?token=x');
  });

  it('picks up a just-installed workspace once', async () => {
    svc.refreshSlack.mockResolvedValue({ connected: true, cloudConnected: true });
    const onConnected = vi.fn();
    const { rerender } = render(<SlackConnectStep connected={false} cloudConnected onGoToCloud={vi.fn()} onConnected={onConnected} />);
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    rerender(<SlackConnectStep connected={false} cloudConnected onGoToCloud={vi.fn()} onConnected={onConnected} />);
    expect(svc.refreshSlack).toHaveBeenCalledTimes(1);
  });

  it('shows an install-link error', async () => {
    svc.getSlackInstallUrl.mockRejectedValue(new Error('Log in to Crewly Cloud first'));
    render(<SlackConnectStep connected={false} cloudConnected onGoToCloud={vi.fn()} onConnected={vi.fn()} navigateTo={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('slack-install'));
    });
    expect(screen.getByText('Log in to Crewly Cloud first')).toBeInTheDocument();
  });
});
