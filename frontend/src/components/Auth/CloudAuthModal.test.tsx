/**
 * Tests for CloudAuthModal
 *
 * @module components/Auth/CloudAuthModal.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CloudAuthModal } from './CloudAuthModal';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    applyCloudAuth: vi.fn(),
    isAuthenticated: false,
    user: null,
    license: null,
    isLoading: false,
    error: null,
    logout: vi.fn(),
    getAccessToken: vi.fn(),
    hasFeature: vi.fn(),
  }),
}));

vi.mock('../../constants/cloud.constants', () => ({
  buildCloudAuthRedirectUrl: () => 'https://crewlyai.com/auth?callback=http://localhost:3000/auth/callback',
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudAuthModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render when closed', () => {
    render(<CloudAuthModal isOpen={false} onClose={onClose} />);

    expect(screen.queryByText('CrewlyAI Cloud')).not.toBeInTheDocument();
  });

  it('should render cloud login button when open', () => {
    render(<CloudAuthModal isOpen={true} onClose={onClose} />);

    expect(screen.getByText('CrewlyAI Cloud')).toBeInTheDocument();
    expect(screen.getByText('Sign in with CrewlyAI Cloud')).toBeInTheDocument();
  });

  it('should show the cloud redirect description', () => {
    render(<CloudAuthModal isOpen={true} onClose={onClose} />);

    expect(screen.getByText(/Sign in with your CrewlyAI account/)).toBeInTheDocument();
  });
});
