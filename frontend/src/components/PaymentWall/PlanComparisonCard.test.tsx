/**
 * PlanComparisonCard Test Suite
 *
 * Tests rendering of Starter, Pro, and Max plan cards, feature row
 * highlighting, billing interval toggle, upgrade buttons, and current
 * plan indication.
 *
 * @module components/PaymentWall/PlanComparisonCard.test
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PlanComparisonCard } from './PlanComparisonCard';

describe('PlanComparisonCard', () => {
  const defaultProps = {
    billingInterval: 'monthly' as const,
    onBillingToggle: vi.fn(),
    onUpgrade: vi.fn(),
  };

  it('renders all three plan cards', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.getByTestId('plan-card-starter')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-pro')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-max')).toBeInTheDocument();
  });

  it('shows plan headings', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
  });

  it('shows "Popular" badge on the Pro card', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const proCard = screen.getByTestId('plan-card-pro');
    expect(within(proCard).getByText('Popular')).toBeInTheDocument();
  });

  it('shows "Best Value" badge on the Max card', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const maxCard = screen.getByTestId('plan-card-max');
    expect(within(maxCard).getByText('Best Value')).toBeInTheDocument();
  });

  it('shows "Current" badge when currentPlan matches', () => {
    render(<PlanComparisonCard {...defaultProps} currentPlan="pro" />);

    const proCard = screen.getByTestId('plan-card-pro');
    expect(within(proCard).getByText('Current')).toBeInTheDocument();
  });

  it('renders feature rows in each card', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const starterCard = screen.getByTestId('plan-card-starter');
    const proCard = screen.getByTestId('plan-card-pro');
    const maxCard = screen.getByTestId('plan-card-max');

    expect(within(starterCard).getByText(/Teams: 2 teams/)).toBeInTheDocument();
    expect(within(proCard).getByText(/Teams: 10 teams/)).toBeInTheDocument();
    expect(within(maxCard).getByText(/Teams: Unlimited/)).toBeInTheDocument();
  });

  it('highlights the correct rows when highlightedLimitType is provided', () => {
    render(
      <PlanComparisonCard
        {...defaultProps}
        highlightedLimitType="limit:teams"
      />,
    );

    const highlighted = screen.getAllByTestId('highlighted-row');
    expect(highlighted.length).toBeGreaterThanOrEqual(3);
    highlighted.forEach((row) => {
      expect(row.className).toContain('bg-yellow-500/10');
      expect(row.className).toContain('text-yellow-500');
    });
  });

  it('does not highlight any row when highlightedLimitType is undefined', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.queryAllByTestId('highlighted-row')).toHaveLength(0);
  });

  it('shows monthly prices by default', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="monthly" />,
    );

    expect(screen.getByTestId('plan-price-starter')).toHaveTextContent('$49');
    expect(screen.getByTestId('plan-price-pro')).toHaveTextContent('$99');
    expect(screen.getByTestId('plan-price-max')).toHaveTextContent('$299');
  });

  it('shows yearly prices and savings badge', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="yearly" />,
    );

    expect(screen.getByTestId('plan-price-starter')).toHaveTextContent('$39');
    expect(screen.getByTestId('plan-price-pro')).toHaveTextContent('$79');
    expect(screen.getByTestId('plan-price-max')).toHaveTextContent('$239');
    expect(screen.getByText(/Save 20%/)).toBeInTheDocument();
  });

  it('calls onBillingToggle with "yearly" when Yearly is clicked', () => {
    const onBillingToggle = vi.fn();
    render(
      <PlanComparisonCard
        {...defaultProps}
        onBillingToggle={onBillingToggle}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-yearly'));
    expect(onBillingToggle).toHaveBeenCalledWith('yearly');
  });

  it('calls onBillingToggle with "monthly" when Monthly is clicked', () => {
    const onBillingToggle = vi.fn();
    render(
      <PlanComparisonCard
        {...defaultProps}
        billingInterval="yearly"
        onBillingToggle={onBillingToggle}
      />,
    );

    fireEvent.click(screen.getByTestId('billing-monthly'));
    expect(onBillingToggle).toHaveBeenCalledWith('monthly');
  });

  it('fires onUpgrade with correct plan ID when upgrade button is clicked', () => {
    const onUpgrade = vi.fn();
    render(
      <PlanComparisonCard {...defaultProps} onUpgrade={onUpgrade} />,
    );

    fireEvent.click(screen.getByTestId('upgrade-pro-btn'));
    expect(onUpgrade).toHaveBeenCalledWith('pro');
  });

  it('fires onUpgrade with starter plan ID', () => {
    const onUpgrade = vi.fn();
    render(
      <PlanComparisonCard {...defaultProps} onUpgrade={onUpgrade} />,
    );

    fireEvent.click(screen.getByTestId('upgrade-starter-btn'));
    expect(onUpgrade).toHaveBeenCalledWith('starter');
  });

  it('fires onUpgrade with max plan ID', () => {
    const onUpgrade = vi.fn();
    render(
      <PlanComparisonCard {...defaultProps} onUpgrade={onUpgrade} />,
    );

    fireEvent.click(screen.getByTestId('upgrade-max-btn'));
    expect(onUpgrade).toHaveBeenCalledWith('max');
  });

  it('hides upgrade button for current plan', () => {
    render(
      <PlanComparisonCard {...defaultProps} currentPlan="pro" />,
    );

    expect(screen.queryByTestId('upgrade-pro-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('upgrade-starter-btn')).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-max-btn')).toBeInTheDocument();
  });

  it('highlights Monthly toggle when billingInterval is monthly', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="monthly" />,
    );

    const monthlyBtn = screen.getByTestId('billing-monthly');
    expect(monthlyBtn.className).toContain('bg-primary/20');
    expect(monthlyBtn.className).toContain('text-primary');
  });

  it('highlights Yearly toggle when billingInterval is yearly', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="yearly" />,
    );

    const yearlyBtn = screen.getByTestId('billing-yearly');
    expect(yearlyBtn.className).toContain('bg-primary/20');
    expect(yearlyBtn.className).toContain('text-primary');
  });

  it('Pro card has primary border and ring styling', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const proCard = screen.getByTestId('plan-card-pro');
    expect(proCard.className).toContain('border-primary');
    expect(proCard.className).toContain('ring-1');
    expect(proCard.className).toContain('ring-primary/30');
  });
});
