/**
 * ModelMixChart Component Tests
 *
 * @module components/Monitoring/ModelMixChart.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ModelMixChart } from './ModelMixChart';
import type { AgentCostEntry } from '../../types';

const mockSessions: AgentCostEntry[] = [
  { sessionName: 'agent-opus-1', agentId: 'a1', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.03, eventCount: 3 },
  { sessionName: 'agent-sonnet-1', agentId: 'a2', inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, cost: 0.021, eventCount: 5 },
  { sessionName: 'agent-haiku-1', agentId: 'a3', inputTokens: 3000, outputTokens: 1500, totalTokens: 4500, cost: 0.003, eventCount: 8 },
];

describe('ModelMixChart', () => {
  it('should render the chart with data', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={0.054} />);
    expect(screen.getByTestId('model-mix-chart')).toBeInTheDocument();
  });

  it('should render empty state when no sessions', () => {
    render(<ModelMixChart sessions={[]} totalCost={0} />);
    expect(screen.getByTestId('model-mix-chart-empty')).toBeInTheDocument();
    expect(screen.getByText('No model data available')).toBeInTheDocument();
  });

  it('should display model names in legend', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={0.054} />);

    expect(screen.getByText('Opus')).toBeInTheDocument();
    expect(screen.getByText('Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Haiku')).toBeInTheDocument();
  });

  it('should render SVG with aria-label', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={0.054} />);

    const svg = screen.getByLabelText('Token distribution by model donut chart');
    expect(svg).toBeInTheDocument();
    expect(svg.tagName).toBe('svg');
  });

  it('should display total cost in center', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={1.23} />);
    expect(screen.getByText('$1.23')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('should show percentage for each segment', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={0.054} />);

    // Total tokens = 1500 + 3000 + 4500 = 9000
    // Haiku = 4500/9000 = 50.0%
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('should classify "Other" for unknown model names', () => {
    const otherSessions: AgentCostEntry[] = [
      { sessionName: 'agent-unknown-1', agentId: 'a1', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.01, eventCount: 1 },
    ];

    render(<ModelMixChart sessions={otherSessions} totalCost={0.01} />);
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('should render chart heading', () => {
    render(<ModelMixChart sessions={mockSessions} totalCost={0.054} />);
    expect(screen.getByText('Model Distribution')).toBeInTheDocument();
  });
});
