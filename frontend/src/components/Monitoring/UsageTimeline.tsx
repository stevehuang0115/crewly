/**
 * UsageTimeline Component
 *
 * SVG bar chart showing per-agent cost breakdown with time-range pill selectors.
 * Since the API does not return time-series data, this displays a per-agent
 * cost bar chart as a useful fallback visualization.
 *
 * @module components/Monitoring/UsageTimeline
 */

import React, { useState } from 'react';
import type { AgentCostEntry } from '../../types';

/**
 * Props for the UsageTimeline component.
 */
interface UsageTimelineProps {
  /** Array of agent cost entries for visualization */
  sessions: AgentCostEntry[];
}

/** Available time range options for the filter pills */
type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d';

/** All time range options */
const TIME_RANGES: TimeRange[] = ['1h', '6h', '24h', '7d', '30d'];

/** Chart layout constants */
const CHART_WIDTH = 500;
const CHART_HEIGHT = 200;
const CHART_PADDING_LEFT = 60;
const CHART_PADDING_RIGHT = 20;
const CHART_PADDING_TOP = 10;
const CHART_PADDING_BOTTOM = 40;

/** Bar color */
const BAR_COLOR = '#3b82f6';

/**
 * Formats a USD amount for display on the chart axis.
 *
 * @param value - Amount in USD
 * @returns Formatted string (e.g., "$1.23")
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Truncates a session name for display as a bar label.
 *
 * @param name - Full session name
 * @param maxLen - Maximum character length
 * @returns Truncated name with ellipsis if needed
 */
function truncateName(name: string, maxLen: number = 10): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Bar chart displaying per-agent costs with time-range filter pills.
 *
 * The time-range pills are present for future use when time-series data
 * becomes available from the API. Currently, all ranges show the same
 * aggregate per-agent cost data.
 *
 * @param props - Agent cost entries
 * @returns SVG bar chart with filter pills
 */
export const UsageTimeline: React.FC<UsageTimelineProps> = ({ sessions }) => {
  const [selectedRange, setSelectedRange] = useState<TimeRange>('24h');

  if (sessions.length === 0) {
    return (
      <div
        className="bg-surface-dark p-6 rounded-lg border border-border-dark flex items-center justify-center h-full"
        data-testid="usage-timeline-empty"
      >
        <p className="text-text-secondary-dark text-sm">No usage data available</p>
      </div>
    );
  }

  // Sort sessions by cost descending for the chart
  const sorted = [...sessions].sort((a, b) => b.cost - a.cost);
  const maxCost = Math.max(...sorted.map((s) => s.cost), 0.01);

  const plotWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const barWidth = Math.min(40, plotWidth / sorted.length - 4);
  const barGap = (plotWidth - barWidth * sorted.length) / (sorted.length + 1);

  return (
    <div
      className="bg-surface-dark p-6 rounded-lg border border-border-dark"
      data-testid="usage-timeline"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary-dark">Cost by Agent</h3>
        {/* Time range pills */}
        <div className="flex gap-1" role="group" aria-label="Time range filter">
          {TIME_RANGES.map((range) => (
            <button
              key={range}
              onClick={() => setSelectedRange(range)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                selectedRange === range
                  ? 'bg-primary text-white'
                  : 'bg-background-dark text-text-secondary-dark hover:text-text-primary-dark'
              }`}
              aria-pressed={selectedRange === range}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        aria-label={`Agent cost bar chart for ${selectedRange} time range`}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = CHART_PADDING_TOP + plotHeight * (1 - fraction);
          const value = maxCost * fraction;
          return (
            <g key={fraction}>
              <line
                x1={CHART_PADDING_LEFT}
                y1={y}
                x2={CHART_WIDTH - CHART_PADDING_RIGHT}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <text
                x={CHART_PADDING_LEFT - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-text-secondary-dark text-[9px]"
              >
                {formatCurrency(value)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {sorted.map((session, index) => {
          const barHeight = maxCost > 0 ? (session.cost / maxCost) * plotHeight : 0;
          const x = CHART_PADDING_LEFT + barGap * (index + 1) + barWidth * index;
          const y = CHART_PADDING_TOP + plotHeight - barHeight;

          return (
            <g key={session.sessionName}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                fill={BAR_COLOR}
                rx={2}
                opacity={0.85}
              />
              {/* X-axis label */}
              <text
                x={x + barWidth / 2}
                y={CHART_HEIGHT - CHART_PADDING_BOTTOM + 14}
                textAnchor="middle"
                className="fill-text-secondary-dark text-[9px]"
                transform={`rotate(-30, ${x + barWidth / 2}, ${CHART_HEIGHT - CHART_PADDING_BOTTOM + 14})`}
              >
                {truncateName(session.sessionName)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};
