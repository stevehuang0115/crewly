/**
 * Tests for CloudDevicePairingPanel: link + QR + code, waiting, connected,
 * cancel, and the ended states. Placeholder values only.
 *
 * @module components/CloudDevicePairingPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudDevicePairingPanel, PAIRING_LABELS_ZH } from './CloudDevicePairingPanel';
import { cloudDevicePairingService } from '../services/cloud-device-pairing.service';
import { CLOUD_DEVICE_PAIRING_POLL_MS } from '../constants/cloud.constants';

vi.mock('../services/cloud-device-pairing.service', () => ({
  cloudDevicePairingService: { start: vi.fn(), status: vi.fn(), cancel: vi.fn() },
}));

const svc = vi.mocked(cloudDevicePairingService);

const PENDING = {
  state: 'pending' as const,
  userCode: 'ABCD-2345',
  verificationUrl: 'https://crewlyai.com/cloud/pair?code=ABCD-2345',
  expiresAt: '2026-09-25T00:15:00.000Z',
  deviceName: 'studio-mac',
};

describe('CloudDevicePairingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('starts on click, shows QR + link + code, waits, then reports connected', async () => {
    svc.start.mockResolvedValue(PENDING);
    svc.status.mockResolvedValueOnce(PENDING).mockResolvedValueOnce({ state: 'connected', tier: 'free', email: 'o@example.test' });
    const onConnected = vi.fn();
    render(<CloudDevicePairingPanel onConnected={onConnected} />);

    expect(svc.start).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('cloud-pairing-start'));
    });

    expect(screen.getByTestId('cloud-pairing-code')).toHaveTextContent('ABCD-2345');
    expect(screen.getByTestId('cloud-pairing-link')).toHaveAttribute('href', PENDING.verificationUrl);
    expect(screen.getByTestId('cloud-pairing-qr').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('cloud-pairing-waiting')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_DEVICE_PAIRING_POLL_MS);
    });
    expect(screen.getByTestId('cloud-pairing-pending')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_DEVICE_PAIRING_POLL_MS);
    });

    expect(screen.getByTestId('cloud-pairing-connected')).toHaveTextContent('Connected to Crewly Cloud (free)');
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith('free');
  });

  it('autoStart begins immediately (setup step, Chinese copy)', async () => {
    svc.start.mockResolvedValue(PENDING);
    await act(async () => {
      render(<CloudDevicePairingPanel autoStart labels={PAIRING_LABELS_ZH} />);
    });
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('等待你在手机上批准…')).toBeInTheDocument();
  });

  it('cancel stops waiting and offers a new link', async () => {
    svc.start.mockResolvedValue(PENDING);
    svc.cancel.mockResolvedValue({ state: 'cancelled' });
    await act(async () => {
      render(<CloudDevicePairingPanel autoStart />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cloud-pairing-cancel'));
    });
    expect(svc.cancel).toHaveBeenCalled();
    expect(screen.getByText('Cancelled.')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-pairing-start')).toHaveTextContent('Get a new link');
  });

  it('shows expiry / denial read while waiting', async () => {
    svc.start.mockResolvedValue(PENDING);
    svc.status.mockResolvedValue({ state: 'denied' });
    await act(async () => {
      render(<CloudDevicePairingPanel autoStart />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_DEVICE_PAIRING_POLL_MS);
    });
    expect(screen.getByText('The request was denied on crewlyai.com.')).toBeInTheDocument();
  });

  it('shows a start failure', async () => {
    svc.start.mockRejectedValue(new Error('Too many pairing requests'));
    await act(async () => {
      render(<CloudDevicePairingPanel autoStart />);
    });
    expect(screen.getByText('Too many pairing requests')).toBeInTheDocument();
  });

  it('keeps waiting through a transient status failure', async () => {
    svc.start.mockResolvedValue(PENDING);
    svc.status.mockRejectedValue(new Error('network'));
    await act(async () => {
      render(<CloudDevicePairingPanel autoStart />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_DEVICE_PAIRING_POLL_MS * 2);
    });
    expect(screen.getByTestId('cloud-pairing-pending')).toBeInTheDocument();
  });
});
