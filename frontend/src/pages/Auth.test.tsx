/**
 * Auth Page Tests
 *
 * Tests for the login/register page including rendering, redirect on
 * authenticated state, Google sign-in, email input, and benefits list.
 *
 * @module pages/Auth.test
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Auth } from './Auth';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const mockUseAuth = vi.fn(() => ({
  isAuthenticated: false,
  user: null,
  license: null,
  isLoading: false,
  error: null,
  applyCloudAuth: vi.fn(),
  logout: vi.fn(),
  getAccessToken: vi.fn(),
  hasFeature: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../constants/cloud.constants', () => ({
  CLOUD_AUTH_URL: 'https://crewlyai.com/cloud/auth',
  buildCloudAuthRedirectUrl: () => 'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%2Fauth%2Fcallback',
}));

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>();
  return {
    ...actual,
    Check: (props: Record<string, unknown>) => <svg data-testid="check-icon" {...props} />,
    Cloud: (props: Record<string, unknown>) => <svg data-testid="cloud-icon" {...props} />,
  };
});

// Store original href for restoration
const originalHref = window.location.href;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      license: null,
      isLoading: false,
      error: null,
      applyCloudAuth: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn(),
      hasFeature: vi.fn(),
    });
    // Reset location.href using Object.defineProperty for jsdom compatibility
    Object.defineProperty(window, 'location', {
      value: { ...window.location, href: 'http://localhost/auth' },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'location', {
      value: { href: originalHref },
      writable: true,
      configurable: true,
    });
  });

  it('renders the sign-in form', () => {
    render(<Auth />);

    expect(screen.getByText('Crewly Cloud')).toBeInTheDocument();
    expect(screen.getByText('Sign in to unlock premium features')).toBeInTheDocument();
    expect(screen.getByTestId('google-signin-btn')).toBeInTheDocument();
    expect(screen.getByTestId('email-input')).toBeInTheDocument();
    expect(screen.getByTestId('email-signin-btn')).toBeInTheDocument();
  });

  it('redirects to settings when already authenticated', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: { id: '1', email: 'test@test.com', displayName: 'Test', plan: 'pro', createdAt: '' },
      license: { plan: 'pro', features: [], active: true },
      isLoading: false,
      error: null,
      applyCloudAuth: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn(),
      hasFeature: vi.fn(),
    });

    render(<Auth />);

    expect(mockNavigate).toHaveBeenCalledWith('/settings?tab=cloud', { replace: true });
  });

  it('does not redirect when not authenticated', () => {
    render(<Auth />);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('redirects to Cloud auth on Google sign-in click', () => {
    render(<Auth />);

    fireEvent.click(screen.getByTestId('google-signin-btn'));

    expect(window.location.href).toBe(
      'https://crewlyai.com/cloud/auth?redirect=http%3A%2F%2Flocalhost%2Fauth%2Fcallback',
    );
  });

  it('handles email input changes', () => {
    render(<Auth />);

    const input = screen.getByTestId('email-input');
    fireEvent.change(input, { target: { value: 'user@example.com' } });

    expect(input).toHaveValue('user@example.com');
  });

  it('redirects with email param on email form submit', () => {
    render(<Auth />);

    const input = screen.getByTestId('email-input');
    fireEvent.change(input, { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByTestId('email-signin-btn'));

    expect(window.location.href).toContain('email=user%40example.com');
  });

  it('does not redirect on empty email submit', () => {
    render(<Auth />);

    const hrefBefore = window.location.href;
    fireEvent.click(screen.getByTestId('email-signin-btn'));

    expect(window.location.href).toBe(hrefBefore);
  });

  it('renders the benefits list', () => {
    render(<Auth />);

    const benefitsList = screen.getByTestId('benefits-list');
    expect(benefitsList).toBeInTheDocument();

    expect(screen.getByText('Unlimited teams & agents')).toBeInTheDocument();
    expect(screen.getByText('Cloud Relay for cross-machine control')).toBeInTheDocument();
    expect(screen.getByText('Premium marketplace templates')).toBeInTheDocument();
    expect(screen.getByText('Priority support')).toBeInTheDocument();
  });

  it('renders terms of service link', () => {
    render(<Auth />);

    const termsLink = screen.getByText('Terms of Service');
    expect(termsLink).toHaveAttribute('href', 'https://crewlyai.com/terms');
  });
});
