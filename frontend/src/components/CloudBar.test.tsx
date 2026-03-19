// @vitest-environment jsdom
/**
 * Tests for CloudBar component
 *
 * Verifies the persistent Cloud Bar status indicator renders correct
 * states, labels, colors, and animations per UX spec section 3.1.
 *
 * @module components/CloudBar.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CloudBar } from './CloudBar';
import type { UseRelayStatusResult, CloudBarState } from '../hooks/useRelayStatus';

// Mock the hook
vi.mock('../hooks/useRelayStatus', () => ({
  useRelayStatus: vi.fn(() => ({
    state: 'offline' as CloudBarState,
    label: 'Cloud Offline',
    sessionId: null,
    isLoading: true,
  })),
}));

import { useRelayStatus } from '../hooks/useRelayStatus';

/** Helper to set hook return value */
function setRelayState(state: CloudBarState, overrides?: Partial<UseRelayStatusResult>): void {
  const labels: Record<CloudBarState, string> = {
    connected: 'Cloud Active',
    paired: 'Linked',
    connecting: 'Connecting...',
    error: 'Relay Error',
    offline: 'Cloud Offline',
  };
  vi.mocked(useRelayStatus).mockReturnValue({
    state,
    label: labels[state],
    sessionId: null,
    isLoading: false,
    ...overrides,
  });
}

describe('CloudBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render nothing while loading', () => {
    vi.mocked(useRelayStatus).mockReturnValue({
      state: 'offline',
      label: 'Cloud Offline',
      sessionId: null,
      isLoading: true,
    });
    const { container } = render(<CloudBar />);
    expect(container.innerHTML).toBe('');
  });

  it('should render "Cloud Active" for connected state', () => {
    setRelayState('connected');
    render(<CloudBar />);
    expect(screen.getByText('Cloud Active')).toBeInTheDocument();
  });

  it('should render "Linked" for paired state', () => {
    setRelayState('paired');
    render(<CloudBar />);
    expect(screen.getByText('Linked')).toBeInTheDocument();
  });

  it('should render "Connecting..." for connecting state', () => {
    setRelayState('connecting');
    render(<CloudBar />);
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('should render "Relay Error" for error state', () => {
    setRelayState('error');
    render(<CloudBar />);
    expect(screen.getByText('Relay Error')).toBeInTheDocument();
  });

  it('should render "Cloud Offline" for offline state', () => {
    setRelayState('offline');
    render(<CloudBar />);
    expect(screen.getByText('Cloud Offline')).toBeInTheDocument();
  });

  it('should have accessible role="status" attribute', () => {
    setRelayState('connected');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar).toHaveAttribute('role', 'status');
  });

  it('should have accessible aria-label', () => {
    setRelayState('error');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar).toHaveAttribute('aria-label', 'Cloud relay status: Relay Error');
  });

  it('should apply green styling for connected state', () => {
    setRelayState('connected');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar.className).toContain('emerald');
  });

  it('should apply yellow styling for connecting state', () => {
    setRelayState('connecting');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar.className).toContain('yellow');
  });

  it('should apply red styling for error state', () => {
    setRelayState('error');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar.className).toContain('red');
  });

  it('should apply grey/zinc styling for offline state', () => {
    setRelayState('offline');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    expect(bar.className).toContain('zinc');
  });

  it('should apply pulse animation for paired state dot', () => {
    setRelayState('paired');
    render(<CloudBar />);
    const bar = screen.getByTestId('cloud-bar');
    const dot = bar.querySelector('.rounded-full');
    expect(dot?.className).toContain('animate-pulse');
  });
});
