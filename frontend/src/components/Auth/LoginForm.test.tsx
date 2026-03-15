/**
 * Tests for LoginForm (Cloud redirect)
 *
 * @module components/Auth/LoginForm.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LoginForm } from './LoginForm';

// Mock cloud constants
vi.mock('../../constants/cloud.constants', () => ({
  buildCloudAuthRedirectUrl: () => 'https://crewlyai.com/auth?callback=http://localhost:3000/auth/callback',
}));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the cloud login button', () => {
    render(<LoginForm />);

    expect(screen.getByText('Sign in with CrewlyAI Cloud')).toBeInTheDocument();
  });

  it('should render description text', () => {
    render(<LoginForm />);

    expect(screen.getByText(/Sign in with your CrewlyAI account/)).toBeInTheDocument();
  });

  it('should redirect to cloud auth URL on click', () => {
    const originalHref = window.location.href;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });

    render(<LoginForm />);

    fireEvent.click(screen.getByText('Sign in with CrewlyAI Cloud'));

    expect(window.location.href).toBe(
      'https://crewlyai.com/auth?callback=http://localhost:3000/auth/callback',
    );

    // Restore
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, href: originalHref },
    });
  });

  it('should display error message', () => {
    render(<LoginForm error="Authentication failed" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Authentication failed');
  });

  it('should disable button when loading', () => {
    render(<LoginForm isLoading />);

    const button = screen.getByRole('button', { name: /Sign in with CrewlyAI Cloud/i });
    expect(button).toBeDisabled();
  });

  it('should not render error when error is null', () => {
    render(<LoginForm />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
