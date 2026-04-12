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

    expect(screen.getByTestId('plan-card-starter')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-pro')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-max')).toBeInTheDocument();
  });

  it('renders the page heading and subtitle', () => {
    render(<Pricing />);

    expect(screen.getByText('Choose Your Plan')).toBeInTheDocument();
    expect(screen.getByText('Start with Starter, upgrade as you grow.')).toBeInTheDocument();
  });

  it('shows upgrade buttons on all plans for free users', () => {
    render(<Pricing />);

    const starterBtn = screen.getByTestId('cta-starter');
    expect(starterBtn).toHaveTextContent('Get Started');
    expect(starterBtn).not.toBeDisabled();

    const proBtn = screen.getByTestId('cta-pro');
    expect(proBtn).toHaveTextContent('Upgrade to Pro');
    expect(proBtn).not.toBeDisabled();

    const maxBtn = screen.getByTestId('cta-max');
    expect(maxBtn).toHaveTextContent('Upgrade to Max');
    expect(maxBtn).not.toBeDisabled();
  });

  it('shows "Current Plan" on pro tier when user is on pro plan', () => {
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

    const proBtn = screen.getByTestId('cta-pro');
    expect(proBtn).toHaveTextContent('Current Plan');
    expect(proBtn).toBeDisabled();
  });

  it('displays monthly prices by default', () => {
    render(<Pricing />);

    expect(screen.getByTestId('price-starter')).toHaveTextContent('$49');
    expect(screen.getByTestId('price-pro')).toHaveTextContent('$99');
    expect(screen.getByTestId('price-max')).toHaveTextContent('$299');
  });

  it('switches to yearly prices when billing toggle is clicked', () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));

    expect(screen.getByTestId('price-starter')).toHaveTextContent('$39');
    expect(screen.getByTestId('price-pro')).toHaveTextContent('$79');
    expect(screen.getByTestId('price-max')).toHaveTextContent('$239');
  });

  it('switches back to monthly prices', () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('billing-monthly'));

    expect(screen.getByTestId('price-pro')).toHaveTextContent('$99');
  });

  it('calls createCheckoutSession when upgrade button is clicked', async () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('cta-pro'));

    await waitFor(() => {
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        'pro',
        'month',
        expect.stringContaining('/cloud?upgraded=true'),
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

  it('renders the "Popular" badge on the pro card', () => {
    render(<Pricing />);

    expect(screen.getByText('Popular')).toBeInTheDocument();
  });

  it('renders feature lists with check icons', () => {
    render(<Pricing />);

    expect(screen.getByText('3 teams')).toBeInTheDocument();
    expect(screen.getByText('Priority support')).toBeInTheDocument();
    expect(screen.getByText('Everything in Pro')).toBeInTheDocument();
    expect(screen.getAllByTestId('check-icon').length).toBeGreaterThanOrEqual(3);
  });

  it('shows yearly savings percentage on the toggle button', () => {
    render(<Pricing />);

    // getYearlySavingsPercent('pro') returns 20 for 49 -> 39
    expect(screen.getByTestId('billing-yearly')).toHaveTextContent(/Save 20%/);
  });

  it('passes yearly interval when billing is set to yearly', async () => {
    render(<Pricing />);

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('cta-max'));

    await waitFor(() => {
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        'max',
        'year',
        expect.any(String),
        expect.any(String),
      );
    });
  });
});
