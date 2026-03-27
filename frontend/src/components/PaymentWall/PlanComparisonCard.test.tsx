/**
 * PlanComparisonCard Test Suite
 *
 * Tests rendering of Free and Pro plan cards, feature row highlighting,
 * billing interval toggle, upgrade button, and enterprise link.
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

  it('renders both Free and Pro plan cards', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.getByTestId('plan-card-free')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card-pro')).toBeInTheDocument();
  });

  it('shows "Free" and "Pro" headings', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });

  it('shows "Current Plan" badge on the Free card', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const freeCard = screen.getByTestId('plan-card-free');
    expect(within(freeCard).getByText('Current Plan')).toBeInTheDocument();
  });

  it('shows "Popular" badge on the Pro card', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const proCard = screen.getByTestId('plan-card-pro');
    expect(within(proCard).getByText('Popular')).toBeInTheDocument();
  });

  it('renders all 6 feature rows in both cards', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    const freeCard = screen.getByTestId('plan-card-free');
    const proCard = screen.getByTestId('plan-card-pro');

    expect(within(freeCard).getByText(/Teams: 2 teams/)).toBeInTheDocument();
    expect(within(freeCard).getByText(/Projects: 3 projects/)).toBeInTheDocument();

    expect(within(proCard).getByText(/Teams: Unlimited/)).toBeInTheDocument();
    expect(within(proCard).getByText(/Projects: Unlimited/)).toBeInTheDocument();
  });

  it('highlights the correct row when highlightedLimitType is provided', () => {
    render(
      <PlanComparisonCard
        {...defaultProps}
        highlightedLimitType="limit:teams"
      />,
    );

    const highlighted = screen.getAllByTestId('highlighted-row');
    expect(highlighted).toHaveLength(2);
    highlighted.forEach((row) => {
      expect(row.className).toContain('bg-yellow-500/10');
      expect(row.className).toContain('text-yellow-500');
    });
  });

  it('does not highlight any row when highlightedLimitType is undefined', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.queryAllByTestId('highlighted-row')).toHaveLength(0);
  });

  it('shows $29/mo for monthly billing', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="monthly" />,
    );

    expect(screen.getByTestId('plan-price')).toHaveTextContent('$29');
    expect(screen.queryByText(/Save/)).not.toBeInTheDocument();
  });

  it('shows $24/mo and savings badge for yearly billing', () => {
    render(
      <PlanComparisonCard {...defaultProps} billingInterval="yearly" />,
    );

    expect(screen.getByTestId('plan-price')).toHaveTextContent('$24');
    expect(screen.getByText(/Save 17%/)).toBeInTheDocument();
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

  it('fires onUpgrade when Upgrade Now button is clicked', () => {
    const onUpgrade = vi.fn();
    render(
      <PlanComparisonCard {...defaultProps} onUpgrade={onUpgrade} />,
    );

    fireEvent.click(screen.getByTestId('upgrade-now-btn'));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it('shows enterprise contact link', () => {
    render(<PlanComparisonCard {...defaultProps} />);

    expect(screen.getByText(/Need Enterprise/)).toBeInTheDocument();
    const link = screen.getByText('Contact us');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', 'mailto:team@crewlyai.com');
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
