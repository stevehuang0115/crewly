/**
 * Tests for UsageDetails.
 *
 * @module components/Usage/UsageDetails.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { UsageDetails } from './UsageDetails';
import { makeUsageStats, usageRow, M } from '../../test/usage.fixtures';

describe('UsageDetails', () => {
  it('is collapsed until opened', () => {
    const onOpenChange = vi.fn();
    render(
      <MemoryRouter>
        <UsageDetails stats={makeUsageStats()} open={false} onOpenChange={onOpenChange} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('usage-runtimes')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('lists runtimes with cached input, and work items linked to their run (5, then Show all)', () => {
    const work = Array.from({ length: 6 }, (_, i) => usageRow(`wi-${i}`, `Item ${i}`, (6 - i) * M, { link: `/workitems/wi-${i}`, meta: { agent: 'Nova', status: 'completed' } }));
    render(
      <MemoryRouter>
        <UsageDetails stats={makeUsageStats({ groups: { ...makeUsageStats().groups, workItem: work } })} open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('usage-runtime-claude-code')).toHaveTextContent('Claude Code30M cached input');
    expect(screen.getByRole('link', { name: 'Item 0' })).toHaveAttribute('href', '/tickets/runs/wi-0');
    expect(screen.getByTestId('usage-workitem-wi-0')).toHaveTextContent('Nova · completed');
    expect(screen.queryByTestId('usage-workitem-wi-5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }));
    expect(screen.getByTestId('usage-workitem-wi-5')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '/tickets?tab=runs');
  });

  it('shows the "(no work item)" row as plain text, not a link', () => {
    const work = [
      usageRow('wi-1', 'Item 1', 5 * M, { link: '/workitems/wi-1', meta: { agent: 'Nova', status: 'running' } }),
      usageRow('(no-work-item)', '(no work item)', 3 * M),
    ];
    render(
      <MemoryRouter>
        <UsageDetails stats={makeUsageStats({ groups: { ...makeUsageStats().groups, workItem: work } })} open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );
    const row = screen.getByTestId('usage-workitem-(no-work-item)');
    expect(row).toHaveTextContent('(no work item)3M');
    expect(row.tagName).toBe('DIV');
    expect(screen.queryByRole('link', { name: '(no work item)' })).not.toBeInTheDocument();
    expect(screen.getByText(/tokens spent between work items/)).toBeInTheDocument();
  });
});
