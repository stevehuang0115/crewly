/**
 * ModelMixChart Component
 *
 * SVG donut chart showing token distribution by model with a legend.
 * Uses pure SVG rendering without external charting libraries.
 *
 * @module components/Monitoring/ModelMixChart
 */

import React, { useMemo } from 'react';
import type { AgentCostEntry } from '../../types';

/**
 * Props for the ModelMixChart component.
 */
interface ModelMixChartProps {
  /** Array of agent cost entries for distribution analysis */
  sessions: AgentCostEntry[];
  /** Total cost across all sessions in USD */
  totalCost: number;
}

/** Color palette for model segments */
const MODEL_COLORS: Record<string, string> = {
  Opus: '#8b5cf6',
  Sonnet: '#3b82f6',
  Haiku: '#10b981',
  Other: '#6b7280',
};

/** SVG donut chart configuration */
const CHART_SIZE = 160;
const CHART_CENTER = CHART_SIZE / 2;
const CHART_RADIUS = 60;
const CHART_STROKE_WIDTH = 20;

/**
 * A segment in the donut chart representing a model's token share.
 */
interface ChartSegment {
  /** Model display name */
  name: string;
  /** Token count for this model */
  tokens: number;
  /** Percentage of total tokens */
  percent: number;
  /** Hex color for the segment */
  color: string;
}

/**
 * Classifies a session name into a model category.
 *
 * @param sessionName - Agent session name
 * @returns Model category name (Opus, Sonnet, Haiku, or Other)
 */
function classifyModel(sessionName: string): string {
  const lower = sessionName.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return 'Other';
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
 * Computes chart segments from session data.
 *
 * Groups sessions by model classification and calculates per-model
 * token totals and percentages.
 *
 * @param sessions - Agent cost entries
 * @returns Array of chart segments, sorted by token count descending
 */
function computeSegments(sessions: AgentCostEntry[]): ChartSegment[] {
  const modelTokens: Record<string, number> = {};

  sessions.forEach((s) => {
    const model = classifyModel(s.sessionName);
    modelTokens[model] = (modelTokens[model] || 0) + s.totalTokens;
  });

  const total = Object.values(modelTokens).reduce((sum, t) => sum + t, 0);
  if (total === 0) return [];

  return Object.entries(modelTokens)
    .map(([name, tokens]) => ({
      name,
      tokens,
      percent: (tokens / total) * 100,
      color: MODEL_COLORS[name] || MODEL_COLORS.Other,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * SVG donut chart with legend showing token distribution by model.
 *
 * The donut center displays the total cost. The legend to the right
 * lists each model with its color swatch and percentage.
 *
 * When there is no data, displays a placeholder message.
 *
 * @param props - Session data and total cost
 * @returns Donut chart with legend
 */
export const ModelMixChart: React.FC<ModelMixChartProps> = ({ sessions, totalCost }) => {
  const segments = useMemo(() => computeSegments(sessions), [sessions]);

  if (segments.length === 0) {
    return (
      <div
        className="bg-surface-dark p-6 rounded-lg border border-border-dark flex items-center justify-center h-full"
        data-testid="model-mix-chart-empty"
      >
        <p className="text-text-secondary-dark text-sm">No model data available</p>
      </div>
    );
  }

  // Compute stroke-dasharray/offset for each arc segment
  const circumference = 2 * Math.PI * CHART_RADIUS;
  let cumulativeOffset = 0;

  const arcs = segments.map((seg) => {
    const dashLength = (seg.percent / 100) * circumference;
    const dashGap = circumference - dashLength;
    const offset = -cumulativeOffset;
    cumulativeOffset += dashLength;

    return {
      ...seg,
      dashArray: `${dashLength} ${dashGap}`,
      dashOffset: offset,
    };
  });

  return (
    <div
      className="bg-surface-dark p-6 rounded-lg border border-border-dark"
      data-testid="model-mix-chart"
    >
      <h3 className="text-sm font-semibold text-text-primary-dark mb-4">Model Distribution</h3>
      <div className="flex items-center gap-6">
        {/* Donut chart */}
        <svg
          width={CHART_SIZE}
          height={CHART_SIZE}
          viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
          aria-label="Token distribution by model donut chart"
          className="flex-shrink-0"
        >
          {arcs.map((arc) => (
            <circle
              key={arc.name}
              cx={CHART_CENTER}
              cy={CHART_CENTER}
              r={CHART_RADIUS}
              fill="none"
              stroke={arc.color}
              strokeWidth={CHART_STROKE_WIDTH}
              strokeDasharray={arc.dashArray}
              strokeDashoffset={arc.dashOffset}
              transform={`rotate(-90 ${CHART_CENTER} ${CHART_CENTER})`}
            />
          ))}
          {/* Center text: total cost */}
          <text
            x={CHART_CENTER}
            y={CHART_CENTER - 6}
            textAnchor="middle"
            className="fill-text-secondary-dark text-[10px]"
          >
            Total
          </text>
          <text
            x={CHART_CENTER}
            y={CHART_CENTER + 10}
            textAnchor="middle"
            className="fill-text-primary-dark text-sm font-semibold"
          >
            {formatCurrency(totalCost)}
          </text>
        </svg>

        {/* Legend */}
        <div className="flex flex-col gap-2">
          {segments.map((seg) => (
            <div key={seg.name} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-sm text-text-primary-dark">{seg.name}</span>
              <span className="text-xs text-text-secondary-dark">
                {seg.percent.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
