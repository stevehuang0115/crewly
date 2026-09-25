/**
 * Tests for CloudConnectStep.
 *
 * @module components/Onboarding/CloudConnectStep.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudConnectStep } from './CloudConnectStep';
import { onboardingChecklistService } from '../../services/onboarding-checklist.service';
import { cloudDevicePairingService } from '../../services/cloud-device-pairing.service';
import { CLOUD_DEVICE_PAIRING_POLL_MS } from '../../constants/cloud.constants';
import { TOKEN_PAGE_URL } from '../../test/onboarding.fixtures';

vi.mock('../../services/onboarding-checklist.service', () => ({
  onboardingChecklistService: { connectCloud: vi.fn() },
}));

vi.mock('../../services/cloud-device-pairing.service', () => ({
  cloudDevicePairingService: { start: vi.fn(), status: vi.fn(), cancel: vi.fn() },
}));

const svc = vi.mocked(onboardingChecklistService);
const pairing = vi.mocked(cloudDevicePairingService);

const PENDING = {
  state: 'pending' as const,
  userCode: 'ABCD-2345',
  verificationUrl: 'https://crewlyai.com/cloud/pair?code=ABCD-2345',
};

describe('CloudConnectStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pairing.start.mockResolvedValue(PENDING);
    pairing.status.mockResolvedValue(PENDING);
  });

  it('leads with device pairing: link + QR + code, then connects by itself', async () => {
    vi.useFakeTimers();
    try {
      pairing.status.mockResolvedValue({ state: 'connected', tier: 'free' });
      const onConnected = vi.fn();
      await act(async () => {
        render(<CloudConnectStep connected={false} tier={null} tokenPageSignInUrl={TOKEN_PAGE_URL} onConnected={onConnected} />);
      });
      expect(pairing.start).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('cloud-pairing-code')).toHaveTextContent('ABCD-2345');
      expect(screen.getByTestId('cloud-pairing-link')).toHaveAttribute('href', PENDING.verificationUrl);
      expect(screen.getByText('等待你在手机上批准…')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLOUD_DEVICE_PAIRING_POLL_MS);
      });
      expect(onConnected).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the connected state and starts no pairing', () => {
    render(<CloudConnectStep connected tier="pro" tokenPageSignInUrl={TOKEN_PAGE_URL} onConnected={vi.fn()} />);
    expect(screen.getByTestId('cloud-connected')).toHaveTextContent('pro');
    expect(pairing.start).not.toHaveBeenCalled();
  });

  it('still offers Google sign-in (secondary) that comes back to this page, not a localhost callback', async () => {
    const navigateTo = vi.fn();
    await act(async () => {
      render(<CloudConnectStep connected={false} tier={null} tokenPageSignInUrl={TOKEN_PAGE_URL} onConnected={vi.fn()} navigateTo={navigateTo} />);
    });
    fireEvent.click(screen.getByTestId('cloud-sign-in'));
    const url = new URL(navigateTo.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cloud/google/start');
    const callback = new URL(url.searchParams.get('redirect') ?? '');
    expect(callback.origin).toBe(window.location.origin);
    expect(callback.pathname).toBe('/auth/callback');
    expect(callback.searchParams.get('next')).toBe('/setup?step=cloud');
  });

  it('falls back to pasting the token and refresh token from the portal token page', async () => {
    svc.connectCloud.mockResolvedValue({ tier: 'free' });
    const onConnected = vi.fn();
    await act(async () => {
      render(<CloudConnectStep connected={false} tier={null} tokenPageSignInUrl={TOKEN_PAGE_URL} onConnected={onConnected} />);
    });
    fireEvent.click(screen.getByTestId('cloud-show-paste'));
    expect(screen.getByRole('link', { name: /Crewly Cloud 登录页/ })).toHaveAttribute('href', TOKEN_PAGE_URL);
    expect(screen.getByTestId('cloud-paste-save')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Token'), { target: { value: ' tok ' } });
    expect(screen.getByText(/大约一小时后需要重新登录/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Refresh token/), { target: { value: ' ref ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cloud-paste-save'));
    });
    expect(svc.connectCloud).toHaveBeenCalledWith('tok', 'ref');
    expect(onConnected).toHaveBeenCalled();
  });

  it('shows a rejected token', async () => {
    svc.connectCloud.mockRejectedValue(new Error('authentication failed'));
    await act(async () => {
      render(<CloudConnectStep connected={false} tier={null} tokenPageSignInUrl={TOKEN_PAGE_URL} onConnected={vi.fn()} />);
    });
    fireEvent.click(screen.getByTestId('cloud-show-paste'));
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'bad' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cloud-paste-save'));
    });
    expect(svc.connectCloud).toHaveBeenCalledWith('bad', undefined);
    expect(screen.getByText('authentication failed')).toBeInTheDocument();
  });
});
