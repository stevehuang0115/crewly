/**
 * Tests for AuthStatusIndicator
 *
 * @module components/Auth/AuthStatusIndicator.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AuthStatusIndicator } from './AuthStatusIndicator';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogout = vi.fn();
const mockAuthState = {
  isAuthenticated: false,
  user: null as { id: string; email: string; displayName: string; plan: 'free' | 'pro'; createdAt: string } | null,
  license: null as { plan: string; features: string[]; active: boolean } | null,
  isLoading: false,
  error: null as string | null,
  applyCloudAuth: vi.fn(),
  logout: mockLogout,
  getAccessToken: vi.fn(),
  hasFeature: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../../constants/cloud.constants', () => ({
  buildCloudAuthRedirectUrl: () => 'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthStatusIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.isAuthenticated = false;
    mockAuthState.user = null;
    mockAuthState.license = null;
    mockAuthState.isLoading = false;
    mockAuthState.error = null;
  });

  it('should show loading state', () => {
    mockAuthState.isLoading = true;

    render(<AuthStatusIndicator />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should show connect button when not authenticated', () => {
    render(<AuthStatusIndicator />);

    expect(screen.getByTitle('Connect to CrewlyAI Cloud')).toBeInTheDocument();
    expect(screen.getByText('Connect to Cloud')).toBeInTheDocument();
  });

  it('should redirect to cloud auth on connect click', () => {
    const originalHref = window.location.href;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });

    render(<AuthStatusIndicator />);

    fireEvent.click(screen.getByTitle('Connect to CrewlyAI Cloud'));

    expect(window.location.href).toBe(
      'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback',
    );

    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });
  });

  it('should hide connect label when collapsed and not authenticated', () => {
    render(<AuthStatusIndicator isCollapsed />);

    expect(screen.queryByText('Connect to Cloud')).not.toBeInTheDocument();
    // But the button should still be there
    expect(screen.getByTitle('Connect to CrewlyAI Cloud')).toBeInTheDocument();
  });

  it('should show user info when authenticated', () => {
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 'u1',
      email: 'test@example.com',
      displayName: 'Test User',
      plan: 'free',
      createdAt: '2026-01-01',
    };

    render(<AuthStatusIndicator />);

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('should show pro badge for pro users', () => {
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 'u1',
      email: 'pro@example.com',
      displayName: 'Pro User',
      plan: 'pro',
      createdAt: '2026-01-01',
    };

    render(<AuthStatusIndicator />);

    expect(screen.getByText('Pro')).toBeInTheDocument();
  });

  it('should call logout when sign out clicked', () => {
    mockAuthState.isAuthenticated = true;
    mockAuthState.user = {
      id: 'u1',
      email: 'test@example.com',
      displayName: 'Test User',
      plan: 'free',
      createdAt: '2026-01-01',
    };

    render(<AuthStatusIndicator />);

    fireEvent.click(screen.getByLabelText('Sign out of CrewlyAI Cloud'));

    expect(mockLogout).toHaveBeenCalled();
  });
});
