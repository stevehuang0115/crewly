/**
 * PaymentWallModal Test Suite
 *
 * Tests modal rendering, header content, usage bar, plan comparison,
 * billing toggle, upgrade API call, and dismiss behavior.
 *
 * @module components/PaymentWall/PaymentWallModal.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { PaymentWallModal } from './PaymentWallModal';
import type { TrialLimitEvent } from '../../types/payment-wall.types';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const mockTeamsEvent: TrialLimitEvent = {
  limitType: 'limit:teams',
  current: 2,
  max: 2,
  plan: 'free',
};

const mockProjectsEvent: TrialLimitEvent = {
  limitType: 'limit:projects',
  current: 3,
  max: 3,
  plan: 'free',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PaymentWallModal', () => {
  it('renders modal with correct title when isOpen is true', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Unlock the Full Crewly')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <PaymentWallModal
        isOpen={false}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Unlock the Full Crewly')).not.toBeInTheDocument();
  });

  it('shows context text with correct limit label', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('paywall-context')).toHaveTextContent(
      /free plan limit for teams/i,
    );
  });

  it('shows context text for projects limit', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockProjectsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('paywall-context')).toHaveTextContent(
      /free plan limit for projects/i,
    );
  });

  it('renders the usage progress bar with correct values', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '2');
    expect(progressbar).toHaveAttribute('aria-valuemax', '2');
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('renders the plan comparison cards', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('plan-card-free')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-pro')).toBeInTheDocument();
  });

  it('has the title element with correct id for aria-labelledby', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    const title = document.getElementById('paywall-title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Unlock the Full Crewly');
  });

  it('renders the Zap icon at 32px', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    const icon = screen.getByTestId('modal-zap-icon');
    expect(icon).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('fires onClose when Maybe Later button is clicked', () => {
    const onClose = vi.fn();
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('maybe-later-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('defaults to monthly billing', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('plan-price')).toHaveTextContent('$29');
    expect(screen.queryByText(/Save/)).not.toBeInTheDocument();
  });

  it('toggles to yearly billing and shows savings', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-yearly'));
    expect(screen.getByTestId('plan-price')).toHaveTextContent('$24');
    expect(screen.getByText(/Save 17%/)).toBeInTheDocument();
  });

  it('calls checkout API with monthly interval when Upgrade Now is clicked', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { checkoutUrl: 'https://checkout.stripe.com/test' },
    });

    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('upgrade-now-btn'));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/payment/checkout', {
        planId: 'pro',
        interval: 'month',
        successUrl: expect.stringContaining('/settings?tab=cloud&upgraded=true'),
        cancelUrl: expect.any(String),
      });
    });
  });

  it('calls checkout API with yearly interval after toggle', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { checkoutUrl: 'https://checkout.stripe.com/test' },
    });

    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-yearly'));
    fireEvent.click(screen.getByTestId('upgrade-now-btn'));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/payment/checkout', {
        planId: 'pro',
        interval: 'year',
        successUrl: expect.stringContaining('/settings?tab=cloud&upgraded=true'),
        cancelUrl: expect.any(String),
      });
    });
  });

  it('handles checkout API error gracefully', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('upgrade-now-btn'));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  it('highlights the correct limit row in plan comparison', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    const highlightedRows = screen.getAllByTestId('highlighted-row');
    expect(highlightedRows.length).toBeGreaterThanOrEqual(2);
    highlightedRows.forEach((row) => {
      expect(row.className).toContain('bg-yellow-500/10');
    });
  });

  it('shows enterprise contact link', () => {
    render(
      <PaymentWallModal
        isOpen={true}
        event={mockTeamsEvent}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Need Enterprise/)).toBeInTheDocument();
    expect(screen.getByText('Contact us')).toBeInTheDocument();
  });
});
