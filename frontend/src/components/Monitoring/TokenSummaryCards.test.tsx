/**
 * TokenSummaryCards Component Tests
 *
 * @module components/Monitoring/TokenSummaryCards.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TokenSummaryCards } from './TokenSummaryCards';

describe('TokenSummaryCards', () => {
  it('should render four stat cards', () => {
    render(
      <TokenSummaryCards
        totalCost={12.50}
        totalTokens={45000}
        activeAgents={3}
        avgCostPerTask={1.25}
      />
    );

    expect(screen.getByTestId('token-summary-cards')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
    expect(screen.getByText('Total Tokens')).toBeInTheDocument();
    expect(screen.getByText('Active Agents')).toBeInTheDocument();
    expect(screen.getByText('Avg Cost / Task')).toBeInTheDocument();
  });

  it('should format currency values correctly', () => {
    render(
      <TokenSummaryCards
        totalCost={12.5}
        totalTokens={1000}
        activeAgents={1}
        avgCostPerTask={0.05}
      />
    );

    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('$0.05')).toBeInTheDocument();
  });

  it('should format tokens with K suffix', () => {
    render(
      <TokenSummaryCards
        totalCost={0}
        totalTokens={45300}
        activeAgents={0}
        avgCostPerTask={0}
      />
    );

    expect(screen.getByText('45.3K')).toBeInTheDocument();
  });

  it('should format tokens with M suffix', () => {
    render(
      <TokenSummaryCards
        totalCost={0}
        totalTokens={1_500_000}
        activeAgents={0}
        avgCostPerTask={0}
      />
    );

    expect(screen.getByText('1.5M')).toBeInTheDocument();
  });

  it('should display raw number for small token counts', () => {
    render(
      <TokenSummaryCards
        totalCost={0}
        totalTokens={500}
        activeAgents={0}
        avgCostPerTask={0}
      />
    );

    expect(screen.getByText('500')).toBeInTheDocument();
  });

  it('should display active agents count', () => {
    render(
      <TokenSummaryCards
        totalCost={0}
        totalTokens={0}
        activeAgents={7}
        avgCostPerTask={0}
      />
    );

    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
