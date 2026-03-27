/**
 * Tests for StepCloudConnect component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StepCloudConnect } from './StepCloudConnect';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock useAuth
const mockUseAuth = {
  isAuthenticated: false,
  user: null,
  isLoading: false,
  error: null,
  license: null,
  applyCloudAuth: vi.fn(),
  logout: vi.fn(),
  getAccessToken: vi.fn(),
  hasFeature: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth,
}));

describe('StepCloudConnect', () => {
  const defaultProps = {
    connected: false,
    onConnected: vi.fn(),
    onSkip: vi.fn(),
    onNext: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.isAuthenticated = false;
    mockUseAuth.user = null;
  });

  it('renders connect button when not connected', () => {
    render(<StepCloudConnect {...defaultProps} />);
    expect(screen.getByTestId('cloud-connect-btn')).toBeInTheDocument();
    expect(screen.getByText('Connect to Crewly Cloud')).toBeInTheDocument();
  });

  it('renders skip button when not connected', () => {
    render(<StepCloudConnect {...defaultProps} />);
    expect(screen.getByTestId('cloud-skip-btn')).toBeInTheDocument();
  });

  it('calls onSkip when skip button clicked', () => {
    render(<StepCloudConnect {...defaultProps} />);
    fireEvent.click(screen.getByTestId('cloud-skip-btn'));
    expect(defaultProps.onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows success state when connected', () => {
    render(<StepCloudConnect {...defaultProps} connected={true} />);
    expect(screen.getByText('Cloud Connected!')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-next-btn')).toBeInTheDocument();
  });

  it('calls onNext when continue clicked in connected state', () => {
    render(<StepCloudConnect {...defaultProps} connected={true} />);
    fireEvent.click(screen.getByTestId('cloud-next-btn'));
    expect(defaultProps.onNext).toHaveBeenCalledTimes(1);
  });

  it('auto-connects when auth context is authenticated', () => {
    mockUseAuth.isAuthenticated = true;
    mockUseAuth.user = { email: 'user@example.com' } as any;
    render(<StepCloudConnect {...defaultProps} />);
    expect(defaultProps.onConnected).toHaveBeenCalled();
  });

  it('shows benefits list when not connected', () => {
    render(<StepCloudConnect {...defaultProps} />);
    expect(screen.getByText(/Cross-machine team sync/)).toBeInTheDocument();
    expect(screen.getByText(/Marketplace skills/)).toBeInTheDocument();
  });
});
