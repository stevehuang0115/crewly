/**
 * Tests for CloudConnectionBanner component
 *
 * @module components/CloudConnectionBanner.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CloudConnectionBanner } from './CloudConnectionBanner';
import type { UseCloudConnectionResult } from '../hooks/useCloudConnection';

// Mock the hook
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockRefresh = vi.fn();

vi.mock('../hooks/useCloudConnection', () => ({
  useCloudConnection: vi.fn(() => ({
    isConnected: false,
    tier: null,
    isLoading: true,
    isActioning: false,
    error: null,
    connect: mockConnect,
    disconnect: mockDisconnect,
    refresh: mockRefresh,
  })),
}));

vi.mock('../constants/cloud.constants', () => ({
  buildCloudAuthRedirectUrl: () => 'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback',
}));

import { useCloudConnection } from '../hooks/useCloudConnection';

/** Creates a disconnected hook result */
function setDisconnected(overrides?: Partial<UseCloudConnectionResult>): void {
  vi.mocked(useCloudConnection).mockReturnValue({
    isConnected: false,
    tier: null,
    isLoading: false,
    isActioning: false,
    error: null,
    connect: mockConnect,
    disconnect: mockDisconnect,
    refresh: mockRefresh,
    ...overrides,
  });
}

/** Creates a connected hook result */
function setConnected(overrides?: Partial<UseCloudConnectionResult>): void {
  vi.mocked(useCloudConnection).mockReturnValue({
    isConnected: true,
    tier: 'pro',
    isLoading: false,
    isActioning: false,
    error: null,
    connect: mockConnect,
    disconnect: mockDisconnect,
    refresh: mockRefresh,
    ...overrides,
  });
}

describe('CloudConnectionBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(true);
    mockDisconnect.mockResolvedValue(true);
  });

  it('should render nothing when loading', () => {
    vi.mocked(useCloudConnection).mockReturnValue({
      isConnected: false,
      tier: null,
      isLoading: true,
      isActioning: false,
      error: null,
      connect: mockConnect,
      disconnect: mockDisconnect,
      refresh: mockRefresh,
    });

    const { container } = render(<CloudConnectionBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('should render disconnected banner with connect button', () => {
    setDisconnected();
    render(<CloudConnectionBanner />);

    expect(screen.getByText('CrewlyAI Cloud')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
  });

  it('should redirect to cloud auth on connect click', async () => {
    setDisconnected();
    const originalHref = window.location.href;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });

    const user = userEvent.setup();
    render(<CloudConnectionBanner />);

    await user.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(window.location.href).toBe(
      'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback',
    );

    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });
  });

  it('should render connected banner with tier badge', () => {
    setConnected();
    render(<CloudConnectionBanner />);

    expect(screen.getByText('Connected to CrewlyAI Cloud')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });

  it('should render enterprise tier badge correctly', () => {
    setConnected({ tier: 'enterprise' });
    render(<CloudConnectionBanner />);

    expect(screen.getByText('Enterprise')).toBeInTheDocument();
  });

  it('should render free tier badge correctly', () => {
    setConnected({ tier: 'free' });
    render(<CloudConnectionBanner />);

    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('should dismiss when X button is clicked in disconnected state', async () => {
    setDisconnected();
    const user = userEvent.setup();
    render(<CloudConnectionBanner />);

    await user.click(screen.getByLabelText('Dismiss cloud banner'));

    expect(screen.queryByText('CrewlyAI Cloud')).not.toBeInTheDocument();
  });

  it('should dismiss when X button is clicked in connected state', async () => {
    setConnected();
    const user = userEvent.setup();
    render(<CloudConnectionBanner />);

    await user.click(screen.getByLabelText('Dismiss cloud banner'));

    expect(screen.queryByText('Connected to CrewlyAI Cloud')).not.toBeInTheDocument();
  });

  it('should call disconnect when Disconnect button is clicked', async () => {
    setConnected();
    const user = userEvent.setup();
    render(<CloudConnectionBanner />);

    await user.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  it('should disable disconnect button while actioning', () => {
    setConnected({ isActioning: true });
    render(<CloudConnectionBanner />);

    const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
    expect(disconnectButton).toBeDisabled();
  });
});
