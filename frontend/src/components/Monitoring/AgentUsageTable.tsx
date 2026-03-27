/**
 * AgentUsageTable Component
 *
 * Sortable table displaying per-agent token usage and cost data.
 * Uses semantic HTML table elements with proper accessibility attributes.
 *
 * @module components/Monitoring/AgentUsageTable
 */

import React, { useState, useMemo } from 'react';
import type { AgentCostEntry } from '../../types';

/**
 * Props for the AgentUsageTable component.
 */
interface AgentUsageTableProps {
  /** Array of agent cost entries to display */
  sessions: AgentCostEntry[];
}

/** Columns available for sorting */
type SortColumn = 'sessionName' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cost';

/** Sort direction */
type SortDirection = 'asc' | 'desc';

/**
 * Formats a number with comma separators for readability.
 *
 * @param value - Number to format
 * @returns Formatted string (e.g., "1,234,567")
 */
function formatNumber(value: number): string {
  return value.toLocaleString();
}

/**
 * Formats a USD amount for display.
 *
 * @param value - Amount in USD
 * @returns Formatted string (e.g., "$12.34")
 */
function formatCurrency(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * Sortable table with agent usage data and a totals footer row.
 *
 * Features:
 * - Click column headers to sort ascending/descending
 * - Visual sort indicator (arrow) on active column
 * - Footer row with aggregate totals
 * - Proper thead/th/scope attributes for screen readers
 *
 * @param props - Agent cost entries
 * @returns Accessible sortable table
 */
export const AgentUsageTable: React.FC<AgentUsageTableProps> = ({ sessions }) => {
  const [sortColumn, setSortColumn] = useState<SortColumn>('cost');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  /**
   * Handles column header click for sorting.
   * Toggles direction if clicking the same column; defaults to descending for new columns.
   *
   * @param column - Column to sort by
   */
  const handleSort = (column: SortColumn): void => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  /** Sorted sessions based on current sort state */
  const sortedSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const aVal = a[sortColumn];
      const bVal = b[sortColumn];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      const aNum = aVal as number;
      const bNum = bVal as number;
      return sortDirection === 'asc' ? aNum - bNum : bNum - aNum;
    });
    return sorted;
  }, [sessions, sortColumn, sortDirection]);

  /** Aggregate totals for the footer */
  const totals = useMemo(() => ({
    inputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    outputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    cost: sessions.reduce((sum, s) => sum + s.cost, 0),
  }), [sessions]);

  /**
   * Renders a sort indicator arrow for a column header.
   *
   * @param column - Column to check
   * @returns Arrow character or empty string
   */
  const sortIndicator = (column: SortColumn): string => {
    if (sortColumn !== column) return '';
    return sortDirection === 'asc' ? ' \u2191' : ' \u2193';
  };

  /** Column definitions for the table header */
  const columns: { key: SortColumn; label: string }[] = [
    { key: 'sessionName', label: 'Agent' },
    { key: 'inputTokens', label: 'Input Tokens' },
    { key: 'outputTokens', label: 'Output Tokens' },
    { key: 'totalTokens', label: 'Total Tokens' },
    { key: 'cost', label: 'Cost' },
  ];

  if (sessions.length === 0) {
    return (
      <div
        className="bg-surface-dark p-6 rounded-lg border border-border-dark text-center text-text-secondary-dark"
        data-testid="agent-usage-table-empty"
      >
        No agent usage data available.
      </div>
    );
  }

  return (
    <div
      className="bg-surface-dark rounded-lg border border-border-dark overflow-hidden"
      data-testid="agent-usage-table"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-dark">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="px-4 py-3 text-left text-xs font-semibold text-text-secondary-dark uppercase tracking-wider cursor-pointer hover:text-text-primary-dark select-none"
                onClick={() => handleSort(col.key)}
                aria-sort={
                  sortColumn === col.key
                    ? sortDirection === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                {col.label}{sortIndicator(col.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedSessions.map((session) => (
            <tr
              key={session.sessionName}
              className="border-b border-border-dark/50 hover:bg-background-dark/50 transition-colors"
            >
              <td className="px-4 py-3 font-medium text-text-primary-dark">{session.sessionName}</td>
              <td className="px-4 py-3 text-text-secondary-dark">{formatNumber(session.inputTokens)}</td>
              <td className="px-4 py-3 text-text-secondary-dark">{formatNumber(session.outputTokens)}</td>
              <td className="px-4 py-3 text-text-secondary-dark">{formatNumber(session.totalTokens)}</td>
              <td className="px-4 py-3 text-text-primary-dark font-medium">{formatCurrency(session.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-dark bg-background-dark/30">
            <td className="px-4 py-3 font-semibold text-text-primary-dark">Total</td>
            <td className="px-4 py-3 font-semibold text-text-secondary-dark">{formatNumber(totals.inputTokens)}</td>
            <td className="px-4 py-3 font-semibold text-text-secondary-dark">{formatNumber(totals.outputTokens)}</td>
            <td className="px-4 py-3 font-semibold text-text-secondary-dark">{formatNumber(totals.totalTokens)}</td>
            <td className="px-4 py-3 font-semibold text-text-primary-dark">{formatCurrency(totals.cost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
