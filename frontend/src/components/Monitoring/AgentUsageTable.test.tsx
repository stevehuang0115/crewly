/**
 * AgentUsageTable Component Tests
 *
 * @module components/Monitoring/AgentUsageTable.test
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AgentUsageTable } from './AgentUsageTable';
import type { AgentCostEntry } from '../../types';

const mockSessions: AgentCostEntry[] = [
  { sessionName: 'agent-alpha', agentId: 'a1', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.015, eventCount: 3 },
  { sessionName: 'agent-beta', agentId: 'a2', inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, cost: 0.030, eventCount: 5 },
  { sessionName: 'agent-gamma', agentId: 'a3', inputTokens: 500, outputTokens: 250, totalTokens: 750, cost: 0.0075, eventCount: 1 },
];

describe('AgentUsageTable', () => {
  it('should render table with sessions', () => {
    render(<AgentUsageTable sessions={mockSessions} />);

    expect(screen.getByTestId('agent-usage-table')).toBeInTheDocument();
    expect(screen.getByText('agent-alpha')).toBeInTheDocument();
    expect(screen.getByText('agent-beta')).toBeInTheDocument();
    expect(screen.getByText('agent-gamma')).toBeInTheDocument();
  });

  it('should render empty state when no sessions', () => {
    render(<AgentUsageTable sessions={[]} />);
    expect(screen.getByTestId('agent-usage-table-empty')).toBeInTheDocument();
    expect(screen.getByText('No agent usage data available.')).toBeInTheDocument();
  });

  it('should render proper table semantics', () => {
    render(<AgentUsageTable sessions={mockSessions} />);

    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();

    const columnHeaders = screen.getAllByRole('columnheader');
    expect(columnHeaders).toHaveLength(5);
    expect(columnHeaders[0]).toHaveAttribute('scope', 'col');
  });

  it('should render footer row with totals', () => {
    render(<AgentUsageTable sessions={mockSessions} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('should sort by column when header is clicked', () => {
    render(<AgentUsageTable sessions={mockSessions} />);

    // Click "Agent" header to sort by name (first click = desc since it's a new column)
    const headers = screen.getAllByRole('columnheader');
    const agentHeader = headers[0]; // Agent
    fireEvent.click(agentHeader);

    // Click again for asc: alpha, beta, gamma
    fireEvent.click(agentHeader);

    const cells = screen.getAllByRole('cell');
    // First data cell should be agent-alpha (asc sort)
    expect(cells[0]).toHaveTextContent('agent-alpha');
  });

  it('should toggle sort direction on repeated clicks', () => {
    render(<AgentUsageTable sessions={mockSessions} />);

    const headers = screen.getAllByRole('columnheader');
    const costHeader = headers[4]; // Cost is the 5th column

    // Default is cost desc, click to toggle to asc
    fireEvent.click(costHeader);
    expect(costHeader).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(costHeader);
    expect(costHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('should have aria-sort attributes on headers', () => {
    render(<AgentUsageTable sessions={mockSessions} />);

    const headers = screen.getAllByRole('columnheader');
    // Default sorted column is 'cost' desc (5th column, index 4)
    expect(headers[4]).toHaveAttribute('aria-sort', 'descending');

    // Other headers should be 'none'
    expect(headers[0]).toHaveAttribute('aria-sort', 'none');
  });
});
