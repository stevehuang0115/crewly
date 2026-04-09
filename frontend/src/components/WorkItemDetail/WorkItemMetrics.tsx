/**
 * WorkItem Metrics Sidebar Component
 *
 * Displays summary metrics for a WorkItem: token usage, cost,
 * retry info, timing, and linked references (request, mission).
 *
 * @module components/WorkItemDetail/WorkItemMetrics
 */

import React from 'react';
import {
  Cpu,
  DollarSign,
  RefreshCw,
  Clock,
  Link2,
  User,
  Target,
} from 'lucide-react';
import { Card } from '../UI/Card';
import type { WorkItem } from './workitem-detail.types';
import {
  formatCost,
  formatTokens,
  formatTimestamp,
  getWorkItemOwnerLabel,
} from './workitem-detail.types';

// =============================================================================
// Props
// =============================================================================

interface WorkItemMetricsProps {
  /** The WorkItem to display metrics for */
  item: WorkItem;
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * A single metric row with icon, label, and value.
 */
const MetricRow: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  valueClass?: string;
}> = ({ icon: Icon, label, value, valueClass = 'text-text-primary-dark' }) => (
  <div className="flex items-center justify-between py-2">
    <div className="flex items-center gap-2 text-text-secondary-dark">
      <Icon className="h-4 w-4" />
      <span className="text-sm">{label}</span>
    </div>
    <span className={`text-sm font-medium ${valueClass}`}>{value}</span>
  </div>
);

// =============================================================================
// Component
// =============================================================================

/**
 * Sidebar panel showing summary metrics for a WorkItem.
 *
 * @param props - WorkItem data
 * @returns Metrics sidebar JSX element
 */
export const WorkItemMetrics: React.FC<WorkItemMetricsProps> = ({ item }) => {
  const duration = computeDuration(item);

  return (
    <div className="space-y-4" data-testid="workitem-metrics">
      {/* Token Usage */}
      <Card variant="default" padding="md">
        <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
          Token Usage
        </h3>
        <div className="divide-y divide-border-dark">
          <MetricRow icon={Cpu} label="Input Tokens" value={formatTokens(item.inputTokens)} />
          <MetricRow icon={Cpu} label="Output Tokens" value={formatTokens(item.outputTokens)} />
          <MetricRow
            icon={DollarSign}
            label="Cost"
            value={formatCost(item.cost)}
            valueClass={item.cost > 0 ? 'text-yellow-400' : 'text-text-primary-dark'}
          />
        </div>
      </Card>

      {/* Execution Info */}
      <Card variant="default" padding="md">
        <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
          Execution
        </h3>
        <div className="divide-y divide-border-dark">
          <MetricRow icon={RefreshCw} label="Retries" value={`${item.retryCount} / ${item.maxRetries}`} />
          <MetricRow icon={Clock} label="Duration" value={duration} />
          <MetricRow icon={User} label="Owner" value={getWorkItemOwnerLabel(item.owner)} />
          {item.target && (
            <MetricRow icon={Target} label="Agent" value={item.target} />
          )}
        </div>
      </Card>

      {/* Linked References */}
      {(item.requestId || item.missionId || item.projectTaskId || item.triggerId) && (
        <Card variant="default" padding="md">
          <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
            Linked References
          </h3>
          <div className="divide-y divide-border-dark">
            {item.requestId && (
              <MetricRow icon={Link2} label="Request" value={truncateId(item.requestId)} />
            )}
            {item.missionId && (
              <MetricRow icon={Link2} label="Mission" value={truncateId(item.missionId)} />
            )}
            {item.projectTaskId && (
              <MetricRow icon={Link2} label="Project Task" value={truncateId(item.projectTaskId)} />
            )}
            {item.triggerId && (
              <MetricRow icon={Link2} label="Trigger" value={truncateId(item.triggerId)} />
            )}
            {item.parentWorkItemId && (
              <MetricRow icon={Link2} label="Parent Item" value={truncateId(item.parentWorkItemId)} />
            )}
          </div>
        </Card>
      )}

      {/* Timestamps */}
      <Card variant="default" padding="md">
        <h3 className="text-xs font-semibold text-text-secondary-dark uppercase tracking-wider mb-3">
          Timestamps
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-text-secondary-dark">Created</span>
            <span className="text-text-primary-dark">{formatTimestamp(item.createdAt)}</span>
          </div>
          {item.startedAt && (
            <div className="flex justify-between">
              <span className="text-text-secondary-dark">Started</span>
              <span className="text-text-primary-dark">{formatTimestamp(item.startedAt)}</span>
            </div>
          )}
          {item.completedAt && (
            <div className="flex justify-between">
              <span className="text-text-secondary-dark">Completed</span>
              <span className="text-text-primary-dark">{formatTimestamp(item.completedAt)}</span>
            </div>
          )}
          {item.scheduledAt && (
            <div className="flex justify-between">
              <span className="text-text-secondary-dark">Scheduled</span>
              <span className="text-text-primary-dark">{formatTimestamp(item.scheduledAt)}</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

WorkItemMetrics.displayName = 'WorkItemMetrics';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Computes a human-readable duration for a WorkItem.
 *
 * @param item - The WorkItem
 * @returns Duration string (e.g., "2m 15s")
 */
function computeDuration(item: WorkItem): string {
  const start = item.startedAt ? new Date(item.startedAt).getTime() : null;
  const end = item.completedAt
    ? new Date(item.completedAt).getTime()
    : item.startedAt
      ? Date.now()
      : null;

  if (!start || !end) return '--';

  const diffMs = end - start;
  const sec = Math.floor(diffMs / 1000) % 60;
  const min = Math.floor(diffMs / 60_000) % 60;
  const hr = Math.floor(diffMs / 3_600_000);

  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Truncates a UUID for display, showing first 8 characters.
 *
 * @param id - The full ID string
 * @returns Truncated string (e.g., "abc12345...")
 */
function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...`;
}
