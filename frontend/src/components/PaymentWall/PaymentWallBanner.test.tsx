/**
 * PaymentWallBanner Test Suite
 *
 * Tests rendering, contextual copy, callback invocations,
 * and accessibility attributes of the payment wall banner.
 *
 * @module components/PaymentWall/PaymentWallBanner.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PaymentWallBanner } from './PaymentWallBanner';
import type { TrialLimitEvent } from '../../types/payment-wall.types';

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

const mockRelayEvent: TrialLimitEvent = {
  limitType: 'limit:relay_sessions',
  current: 1,
  max: 1,
  plan: 'free',
};

describe('PaymentWallBanner', () => {
  it('renders with correct copy for teams limit', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('payment-wall-banner')).toBeInTheDocument();
    expect(screen.getByTestId('banner-copy')).toHaveTextContent(
      /free plan limit of 2 teams/i,
    );
  });

  it('renders with correct copy for projects limit', () => {
    render(
      <PaymentWallBanner
        event={mockProjectsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('banner-copy')).toHaveTextContent(
      /3 projects on the free plan/i,
    );
  });

  it('renders with correct copy for relay sessions limit', () => {
    render(
      <PaymentWallBanner
        event={mockRelayEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('banner-copy')).toHaveTextContent(
      /1 Cloud Relay session/i,
    );
  });

  it('renders the max number in bold', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const copyEl = screen.getByTestId('banner-copy');
    const boldEl = copyEl.querySelector('strong');
    expect(boldEl).not.toBeNull();
    expect(boldEl!.textContent).toBe('2');
  });

  it('fires onUpgrade when Upgrade button is clicked', () => {
    const onUpgrade = vi.fn();
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={onUpgrade}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-upgrade-btn'));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('fires onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('banner-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has role="alert" attribute', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('payment-wall-banner');
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('has aria-live="polite" attribute', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('payment-wall-banner');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('has a dismiss button with accessible label', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument();
  });

  it('renders the Zap icon', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId('banner-zap-icon')).toBeInTheDocument();
  });

  it('uses dark theme surface class', () => {
    render(
      <PaymentWallBanner
        event={mockTeamsEvent}
        onUpgrade={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId('payment-wall-banner');
    expect(banner.className).toContain('bg-surface-dark');
    expect(banner.className).toContain('border-primary');
  });
});
