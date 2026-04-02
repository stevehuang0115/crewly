/**
 * CostDashboard Page
 *
 * Main cost monitoring dashboard that orchestrates all monitoring components.
 * Displays budget status, token summary cards, usage timeline, model mix chart,
 * agent usage table, and budget configuration panel.
 *
 * @module pages/CostDashboard
 */

import React from 'react';
import { useTokenUsage } from '../hooks/useTokenUsage';
import { useBudgetConfig } from '../hooks/useBudgetConfig';
import { TokenSummaryCards } from '../components/Monitoring/TokenSummaryCards';
import { BudgetStatusBar } from '../components/Monitoring/BudgetStatusBar';
import { AgentUsageTable } from '../components/Monitoring/AgentUsageTable';
import { ModelMixChart } from '../components/Monitoring/ModelMixChart';
import { UsageTimeline } from '../components/Monitoring/UsageTimeline';
import { BudgetConfigPanel } from '../components/Monitoring/BudgetConfigPanel';
import { TaskUsageTable } from '../components/Monitoring/TaskUsageTable';

/**
 * Formats seconds ago into a human-readable string.
 *
 * @param date - Timestamp to measure against now
 * @returns Human-readable relative time (e.g., "5s ago")
 */
function formatLastUpdated(date: Date | null): string {
  if (!date) return 'Never';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

/**
 * Cost Dashboard page component.
 *
 * Brings together all monitoring components into a single view:
 * - BudgetStatusBar: spending progress against limits
 * - TokenSummaryCards: key metrics at a glance
 * - UsageTimeline + ModelMixChart: visual breakdowns side by side
 * - AgentUsageTable: detailed per-agent data
 * - BudgetConfigPanel: collapsible configuration editor
 *
 * Handles loading, empty, and error states.
 *
 * @returns Cost monitoring dashboard page
 */
export const CostDashboard: React.FC = () => {
  const {
    sessions,
    totalCost,
    totalTokens,
    activeAgents,
    avgCostPerTask,
    loading,
    error,
    lastUpdated,
    isStale,
    refresh,
  } = useTokenUsage();

  const { config, saveConfig, resetConfig } = useBudgetConfig();

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        <p className="ml-3 text-text-secondary-dark">Loading cost data...</p>
      </div>
    );
  }

  // Error state
  if (error && sessions.length === 0) {
    return (
      <div className="max-w-7xl mx-auto" data-testid="cost-dashboard-error">
        <div className="bg-surface-dark p-8 rounded-lg border border-red-500/50 text-center">
          <p className="text-red-400 font-medium mb-2">Failed to load cost data</p>
          <p className="text-sm text-text-secondary-dark mb-4">{error}</p>
          <button
            onClick={refresh}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto" data-testid="cost-dashboard">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Usage</h2>
          <p className="text-sm text-text-secondary-dark mt-1">
            Monitor token usage and spending across all agents and tasks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isStale && (
            <span
              className="px-2 py-1 text-xs font-medium rounded-full bg-yellow-500/20 text-yellow-400"
              data-testid="stale-badge"
            >
              Stale
            </span>
          )}
          <span className="text-xs text-text-secondary-dark" data-testid="last-updated">
            Last updated: {formatLastUpdated(lastUpdated)}
          </span>
          <button
            onClick={refresh}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-background-dark text-text-secondary-dark hover:text-text-primary-dark transition-colors"
            data-testid="refresh-btn"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Empty state */}
      {sessions.length === 0 ? (
        <div
          className="bg-surface-dark p-12 rounded-lg border border-border-dark text-center"
          data-testid="cost-dashboard-empty"
        >
          <p className="text-lg font-medium text-text-primary-dark mb-2">No usage data yet</p>
          <p className="text-sm text-text-secondary-dark">
            Token usage will appear here once agents start processing tasks.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Budget Status */}
          <BudgetStatusBar currentCost={totalCost} budgetConfig={config} />

          {/* Summary Cards */}
          <TokenSummaryCards
            totalCost={totalCost}
            totalTokens={totalTokens}
            activeAgents={activeAgents}
            avgCostPerTask={avgCostPerTask}
          />

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <UsageTimeline sessions={sessions} />
            <ModelMixChart sessions={sessions} totalCost={totalCost} />
          </div>

          {/* Agent Usage Table */}
          <AgentUsageTable sessions={sessions} />

          {/* Per-Task Usage Table */}
          <TaskUsageTable />

          {/* Budget Configuration */}
          <BudgetConfigPanel
            config={config}
            onSave={saveConfig}
            onReset={resetConfig}
          />
        </div>
      )}
    </div>
  );
};

export default CostDashboard;
