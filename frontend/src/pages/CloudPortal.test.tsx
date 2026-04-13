// Layout + ScoreCard consistency
/**
 * CloudPortal Page Tests
 *
 * Tests for subscription display, deploy wizard, deployment status
 * polling, and deployed teams list.
 *
 * @module pages/CloudPortal.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CloudPortal } from './CloudPortal';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

const mockLicense = { plan: 'free', features: [], active: true };
const mockUser = { id: 'user-1', email: 'test@test.com', displayName: 'Test', plan: 'free', createdAt: '' };

const mockUseAuth = vi.fn(() => ({
  isAuthenticated: true,
  user: mockUser,
  license: mockLicense,
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

vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>();
  const MockIcon = (props: Record<string, unknown>) => <svg data-testid="icon" {...props} />;
  return {
    ...actual,
    Cloud: MockIcon,
    Rocket: MockIcon,
    CheckCircle2: MockIcon,
    AlertCircle: MockIcon,
    Loader2: MockIcon,
    MessageSquare: MockIcon,
    Server: MockIcon,
    Globe: MockIcon,
  };
});

const mockGetSubscription = vi.fn();
const mockListDeployments = vi.fn();
const mockCreateDeployment = vi.fn();
const mockGetDeploymentStatus = vi.fn();

vi.mock('../services/api.service', () => ({
  apiService: {
    getSubscription: (...args: unknown[]) => mockGetSubscription(...args),
    listDeployments: (...args: unknown[]) => mockListDeployments(...args),
    createDeployment: (...args: unknown[]) => mockCreateDeployment(...args),
    getDeploymentStatus: (...args: unknown[]) => mockGetDeploymentStatus(...args),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up a paid user with Pro plan.
 */
function setupPaidUser() {
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    user: { ...mockUser, plan: 'pro' },
    license: { plan: 'pro', features: [], active: true },
    isLoading: false,
    error: null,
    applyCloudAuth: vi.fn(),
    logout: vi.fn(),
    getAccessToken: vi.fn(),
    hasFeature: vi.fn(),
  });
  mockGetSubscription.mockResolvedValue({
    plan: 'pro',
    status: 'active',
    currentPeriodEnd: '2026-05-04T00:00:00Z',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudPortal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset useAuth to free user (clearAllMocks doesn't reset mockReturnValue)
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: mockUser,
      license: mockLicense,
      isLoading: false,
      error: null,
      applyCloudAuth: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn(),
      hasFeature: vi.fn(),
    });
    mockGetSubscription.mockResolvedValue(null);
    mockListDeployments.mockResolvedValue({ deployments: [], total: 0 });
    mockCreateDeployment.mockResolvedValue({
      deploymentId: 'dep-123',
      statusUrl: '/api/provisioning/deployments/dep-123/status',
    });
    mockGetDeploymentStatus.mockResolvedValue({
      currentPhase: 'READY',
      success: true,
      ipAddress: '1.2.3.4',
    });
  });

  it('renders the page heading', () => {
    render(<CloudPortal />);
    expect(screen.getByText('Cloud Portal')).toBeInTheDocument();
  });

  it('shows subscription card', () => {
    render(<CloudPortal />);
    expect(screen.getByTestId('subscription-card')).toBeInTheDocument();
  });

  it('shows upgrade button for free users', async () => {
    render(<CloudPortal />);
    await waitFor(() => {
      expect(screen.getByTestId('upgrade-btn')).toBeInTheDocument();
    });
  });

  it('navigates to pricing when upgrade is clicked', async () => {
    render(<CloudPortal />);
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('upgrade-btn'));
    });
    expect(mockNavigate).toHaveBeenCalledWith('/pricing');
  });

  it('shows deploy section for paid users', async () => {
    setupPaidUser();
    render(<CloudPortal />);

    await waitFor(() => {
      expect(screen.getByTestId('deploy-section')).toBeInTheDocument();
    });
  });

  it('does not show deploy section for free users', async () => {
    render(<CloudPortal />);
    await waitFor(() => {
      expect(screen.queryByTestId('deploy-section')).not.toBeInTheDocument();
    });
  });

  it('shows team name input for paid users', async () => {
    setupPaidUser();
    render(<CloudPortal />);

    await waitFor(() => {
      expect(screen.getByTestId('team-name-input')).toBeInTheDocument();
    });
  });

  it('disables deploy button when team name is empty', async () => {
    setupPaidUser();
    render(<CloudPortal />);

    await waitFor(() => {
      const btn = screen.getByTestId('deploy-btn');
      expect(btn).toBeDisabled();
    });
  });

  it('enables deploy button when team name is entered', async () => {
    setupPaidUser();
    render(<CloudPortal />);

    await waitFor(() => {
      fireEvent.change(screen.getByTestId('team-name-input'), {
        target: { value: 'marketing-team' },
      });
    });

    expect(screen.getByTestId('deploy-btn')).not.toBeDisabled();
  });

  it('shows deploying state after clicking deploy', async () => {
    setupPaidUser();
    // Make deployment hang (never resolve status)
    mockGetDeploymentStatus.mockImplementation(() => new Promise(() => {}));

    render(<CloudPortal />);

    await waitFor(() => {
      fireEvent.change(screen.getByTestId('team-name-input'), {
        target: { value: 'my-team' },
      });
    });

    fireEvent.click(screen.getByTestId('deploy-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('deploying-state')).toBeInTheDocument();
    });
  });

  it('shows deployments list section', () => {
    render(<CloudPortal />);
    expect(screen.getByTestId('deployments-list')).toBeInTheDocument();
  });

  it('shows empty state when no deployments exist', async () => {
    render(<CloudPortal />);
    await waitFor(() => {
      expect(screen.getByText(/No deployed teams yet/)).toBeInTheDocument();
    });
  });

  it('shows subscription status for paid users', async () => {
    setupPaidUser();
    render(<CloudPortal />);

    await waitFor(() => {
      expect(screen.getByText(/Pro Plan — Active/i)).toBeInTheDocument();
    });
  });

  it('calls createDeployment with correct parameters', async () => {
    setupPaidUser();
    mockGetDeploymentStatus.mockImplementation(() => new Promise(() => {}));

    render(<CloudPortal />);

    await waitFor(() => {
      fireEvent.change(screen.getByTestId('team-name-input'), {
        target: { value: 'My Team' },
      });
    });

    fireEvent.click(screen.getByTestId('deploy-btn'));

    await waitFor(() => {
      expect(mockCreateDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          dropletName: 'crewly-my-team',
          region: 'sfo3',
          size: 's-2vcpu-4gb',
          installPro: true,
          registerCloud: true,
        })
      );
    });
  });
});
