/**
 * Pricing Page Tests
 *
 * Tests for plan card rendering, billing toggle, current plan indication,
 * upgrade buttons, and the enterprise section.
 *
 * @module pages/Pricing.test
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Pricing } from './Pricing';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLicense = { plan: 'free', features: [], active: true };
const mockUser = { id: '1', email: 'test@test.com', displayName: 'Test', plan: 'free', createdAt: '' };

const mockUseAuth = vi.fn(() => ({
  isAuthenticated: false,
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
  return {
    ...actual,
    Check: (props: Record<string, unknown>) => <svg data-testid="check-icon" {...props} />,
  };
});

const mockCreateCheckoutSession = vi.fn().mockResolvedValue({
  checkoutUrl: 'https://checkout.stripe.com/test',
});

vi.mock('../services/api.service', () => ({
  apiService: {
    createCheckoutSession: (...args: unknown[]) => mockCreateCheckoutSession(...args),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: mockUser,
      license: { plan: 'free', features: [], active: true },
      isLoading: false,
      error: null,
      applyCloudAuth: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn(),
      hasFeature: vi.fn(),
    });
    mockCreateCheckoutSession.mockResolvedValue({
      checkoutUrl: 'https://checkout.stripe.com/test',
    });
  });

  it('renders all three plan cards', () => {
    render(<Pricing />);

    expect(screen.getByTestId('plan-card-free')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-solo')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-team')).toBeInTheDocument();
  });

  it('renders the page heading and subtitle', () => {
    render(<Pricing />);

    expect(screen.getByText('Choose Your Plan')).toBeInTheDocument();
    expect(screen.getByText("Start free, upgrade when you're ready.")).toBeInTheDocument();
  });

  it('shows "Current Plan" button on free tier when user is on free plan', () => {
    render(<Pricing />);

    const freeBtn = screen.getByTestId('cta-free');
    expect(freeBtn).toHaveTextContent('Current Plan');
    expect(freeBtn).toBeDisabled();
  });

  it('shows "Current Plan" on solo tier when user is on pro plan', () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      user: { ...mockUser, plan: 'pro' },
      license: { plan: 'pro', features: ['unlimited_teams'], active: true },
      isLoading: false,
      error: null,
      applyCloudAuth: vi.fn(),
      logout: vi.fn(),
      getAccessToken: vi.fn(),
      hasFeature: vi.fn(),
    });

    render(<Pricing />);

    const soloBtn = screen.getByTestId('cta-solo');
    expect(soloBtn).toHaveTextContent('Current Plan');
    expect(soloBtn).toBeDisabled();
  });

  it('displays monthly prices by default', () => {
    render(<Pricing />);

    expect(screen.getByTestId('price-free')).toHaveTextContent('$0');
    expect(screen.getByTestId('price-solo')).toHaveTextContent('$29');
    expect(screen.getByTestId('price-team')).toHaveTextContent('$99');
  });

  it('switches to yearly prices when billing toggle is clicked', () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));

    expect(screen.getByTestId('price-solo')).toHaveTextContent('$24');
    expect(screen.getByTestId('price-team')).toHaveTextContent('$82');
  });

  it('switches back to monthly prices', () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('billing-monthly'));

    expect(screen.getByTestId('price-solo')).toHaveTextContent('$29');
  });

  it('shows upgrade buttons on paid plans for free users', () => {
    render(<Pricing />);

    const soloBtn = screen.getByTestId('cta-solo');
    expect(soloBtn).toHaveTextContent('Upgrade to Solo');
    expect(soloBtn).not.toBeDisabled();

    const teamBtn = screen.getByTestId('cta-team');
    expect(teamBtn).toHaveTextContent('Upgrade to Team');
    expect(teamBtn).not.toBeDisabled();
  });

  it('calls createCheckoutSession when upgrade button is clicked', async () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('cta-solo'));

    await waitFor(() => {
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        'solo',
        'month',
        expect.stringContaining('/settings?tab=cloud&upgraded=true'),
        expect.any(String),
      );
    });
  });

  it('renders enterprise section with Contact Sales button', () => {
    render(<Pricing />);

    const enterprise = screen.getByTestId('enterprise-section');
    expect(enterprise).toBeInTheDocument();
    expect(screen.getByText('Enterprise')).toBeInTheDocument();

    const salesBtn = screen.getByTestId('contact-sales-btn');
    expect(salesBtn).toHaveTextContent('Contact Sales');
  });

  it('renders the "Popular" badge on the solo card', () => {
    render(<Pricing />);

    expect(screen.getByText('Popular')).toBeInTheDocument();
  });

  it('renders feature lists with check icons', () => {
    render(<Pricing />);

    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.getByText('Unlimited teams')).toBeInTheDocument();
    expect(screen.getByText('5 team seats')).toBeInTheDocument();
    expect(screen.getAllByTestId('check-icon').length).toBeGreaterThanOrEqual(3);
  });

  it('shows yearly savings percentage on the toggle button', () => {
    render(<Pricing />);

    // getYearlySavingsPercent returns 17 for 29 -> 24
    expect(screen.getByTestId('billing-yearly')).toHaveTextContent(/Save 17%/);
  });

  it('passes yearly interval when billing is set to yearly', async () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('cta-team'));

    await waitFor(() => {
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        'team',
        'year',
        expect.any(String),
        expect.any(String),
      );
    });
  });
});
