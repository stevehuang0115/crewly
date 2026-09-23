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
import { RefreshCw, BarChart3 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, LoadingSpinner } from '@crewly/ui';
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
        <LoadingSpinner size="md" text="Loading cost data..." />
      </div>
    );
  }

  // Error state
  if (error && sessions.length === 0) {
    return (
      <div className="max-w-7xl mx-auto" data-testid="cost-dashboard-error">
        <Card padding="none" className="p-8 border-red-500/50 flex flex-col items-center text-center" role="alert">
          <p className="text-red-400 font-medium mb-2">Failed to load cost data</p>
          <p className="text-sm text-text-secondary-dark mb-4">{error}</p>
          <Button variant="primary" icon={RefreshCw} onClick={refresh}>
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="cost-dashboard">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary-dark">Usage</h1>
          <p className="text-sm text-text-secondary-dark">
            Monitor token usage and spending across all agents and tasks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isStale && (
            <Badge variant="warning" data-testid="stale-badge">
              Stale
            </Badge>
          )}
          <span className="text-xs text-text-secondary-dark" data-testid="last-updated">
            Last updated: {formatLastUpdated(lastUpdated)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            onClick={refresh}
            data-testid="refresh-btn"
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {sessions.length === 0 ? (
        <Card padding="none">
          <EmptyState
            icon={BarChart3}
            title="No usage data yet"
            description="Token usage will appear here once agents start processing tasks."
            data-testid="cost-dashboard-empty"
          />
        </Card>
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
