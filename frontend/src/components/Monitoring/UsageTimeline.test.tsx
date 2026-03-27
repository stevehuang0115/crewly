/**
 * UsageTimeline Component Tests
 *
 * @module components/Monitoring/UsageTimeline.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { UsageTimeline } from './UsageTimeline';
import type { AgentCostEntry } from '../../types';

const mockSessions: AgentCostEntry[] = [
  { sessionName: 'agent-alpha', agentId: 'a1', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.015, eventCount: 3 },
  { sessionName: 'agent-beta', agentId: 'a2', inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, cost: 0.030, eventCount: 5 },
];

describe('UsageTimeline', () => {
  it('should render the chart with data', () => {
    render(<UsageTimeline sessions={mockSessions} />);
    expect(screen.getByTestId('usage-timeline')).toBeInTheDocument();
  });

  it('should render empty state when no sessions', () => {
    render(<UsageTimeline sessions={[]} />);
    expect(screen.getByTestId('usage-timeline-empty')).toBeInTheDocument();
    expect(screen.getByText('No usage data available')).toBeInTheDocument();
  });

  it('should render SVG with aria-label', () => {
    render(<UsageTimeline sessions={mockSessions} />);

    const svg = screen.getByLabelText(/Agent cost bar chart/);
    expect(svg).toBeInTheDocument();
    expect(svg.tagName).toBe('svg');
  });

  it('should render time range pills', () => {
    render(<UsageTimeline sessions={mockSessions} />);

    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('6h')).toBeInTheDocument();
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
  });

  it('should default to 24h selected', () => {
    render(<UsageTimeline sessions={mockSessions} />);

    const pill24h = screen.getByText('24h');
    expect(pill24h).toHaveAttribute('aria-pressed', 'true');
  });

  it('should change selected range on pill click', () => {
    render(<UsageTimeline sessions={mockSessions} />);

    const pill7d = screen.getByText('7d');
    fireEvent.click(pill7d);

    expect(pill7d).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('24h')).toHaveAttribute('aria-pressed', 'false');
  });

  it('should render time range group with aria label', () => {
    render(<UsageTimeline sessions={mockSessions} />);

    const group = screen.getByRole('group', { name: 'Time range filter' });
    expect(group).toBeInTheDocument();
  });

  it('should display chart heading', () => {
    render(<UsageTimeline sessions={mockSessions} />);
    expect(screen.getByText('Cost by Agent')).toBeInTheDocument();
  });
});
