/**
 * TokenSummaryCards Component
 *
 * Displays four stat cards for cost monitoring: Total Cost, Total Tokens,
 * Active Agents, and Average Cost per Task.
 *
 * @module components/Monitoring/TokenSummaryCards
 */

import React from 'react';

/**
 * Props for the TokenSummaryCards component.
 */
interface TokenSummaryCardsProps {
  /** Total estimated cost in USD */
  totalCost: number;
  /** Total tokens consumed across all agents */
  totalTokens: number;
  /** Number of agents with recorded usage */
  activeAgents: number;
  /** Average cost per task in USD */
  avgCostPerTask: number;
}

/**
 * Formats a number with K/M suffixes for compact display.
 *
 * @param value - Number to format
 * @returns Formatted string (e.g., "1.2M", "45.3K", "123")
 */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toString();
}

/**
 * Formats a USD amount for display.
 *
 * @param value - Amount in USD
 * @returns Formatted string (e.g., "$12.34")
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Single stat card matching the Dashboard StatCard pattern.
 */
const StatCard: React.FC<{ title: string; value: string }> = ({ title, value }) => (
  <div className="bg-surface-dark p-6 rounded-lg border border-border-dark transition-all hover:shadow-lg hover:border-primary/50">
    <p className="text-sm font-medium text-text-secondary-dark">{title}</p>
    <p className="text-3xl font-bold mt-1">{value}</p>
  </div>
);

/**
 * Renders four stat cards summarizing token usage and costs.
 *
 * Uses the same bg-surface-dark card pattern as the Dashboard StatCard
 * for visual consistency.
 *
 * @param props - Cost and usage metrics
 * @returns Four-card grid layout
 */
export const TokenSummaryCards: React.FC<TokenSummaryCardsProps> = ({
  totalCost,
  totalTokens,
  activeAgents,
  avgCostPerTask,
}) => {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
      data-testid="token-summary-cards"
    >
      <StatCard title="Total Cost" value={formatCurrency(totalCost)} />
      <StatCard title="Total Tokens" value={formatTokenCount(totalTokens)} />
      <StatCard title="Active Agents" value={activeAgents.toString()} />
      <StatCard title="Avg Cost / Task" value={formatCurrency(avgCostPerTask)} />
    </div>
  );
};
