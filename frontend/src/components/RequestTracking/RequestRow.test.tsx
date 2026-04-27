// @vitest-environment jsdom
/**
 * Tests for RequestRow component — V3 two-tier scan model.
 *
 * Verifies the hierarchy switch defined in Ava's design report
 * (2026-04-05) and the V3 UI PRD §3.1:
 *   Top tier:    source icon + title + status pill (Dark/Calm palette)
 *   Bottom tier: priority, category, mission link, work item count, updated time
 *   Cost/tokens: REMOVED from the row, lives on the detail page
 *   Source label: moves to the expandable context area
 *   Navigation:  consolidated to `/tasks/:id`
 *
 * @module components/RequestTracking/RequestRow.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestRow } from './RequestRow';
import type { RequestItem } from './request-tracking.types';

// Track navigation calls so we can assert /tasks/:id consolidation.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

/**
 * Wraps RequestRow in a MemoryRouter for tests requiring useNavigate.
 *
 * @param request - Request item data
 * @returns Rendered component
 */
function renderRequestRow(request: RequestItem) {
  return render(
    <MemoryRouter>
      <RequestRow request={request} />
    </MemoryRouter>
  );
}

const baseRequest: RequestItem = {
  id: 'req-test',
  title: 'Test request title',
  status: 'active',
  priority: 'high',
  source: 'slack',
  requester: 'Test User',
  category: 'Engineering',
  workItemCount: 3,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  updatedAt: new Date().toISOString(),
  missionLink: 'Mission Link: Test',
};

describe('RequestRow', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  it('renders the request title in the top tier', () => {
    renderRequestRow(baseRequest);
    const top = screen.getByTestId('request-tier-top');
    expect(within(top).getByText('Test request title')).toBeDefined();
  });

  it('renders the status pill in the top tier (Dark/Calm palette)', () => {
    renderRequestRow(baseRequest);
    const top = screen.getByTestId('request-tier-top');
    const pill = within(top).getByTestId('request-status-pill-active');
    expect(pill).toBeDefined();
    expect(pill.className).toContain('text-amber');
  });

  it('does NOT render the priority badge in the top tier (it moves to the bottom tier)', () => {
    renderRequestRow(baseRequest);
    const top = screen.getByTestId('request-tier-top');
    expect(within(top).queryByText('High')).toBeNull();
  });

  it('renders the bottom tier in the spec order: priority, category, mission, work-item count, updated time', () => {
    renderRequestRow(baseRequest);
    const bottom = screen.getByTestId('request-tier-bottom');

    expect(within(bottom).getByText('High')).toBeDefined();
    expect(within(bottom).getByTestId('request-meta-category').textContent).toBe('Engineering');
    const mission = within(bottom).getByTestId('request-meta-mission');
    expect(mission.textContent).toContain('Mission:');
    expect(mission.textContent).toContain('Mission Link: Test');
    expect(within(bottom).getByTestId('request-meta-workitems').textContent).toContain('3');
    expect(within(bottom).getByTestId('request-meta-updated')).toBeDefined();
  });

  it('does NOT render cost or token totals on the row (those live on the detail page)', () => {
    const withCost: RequestItem = {
      ...baseRequest,
      totalCost: 1.23,
      totalInputTokens: 500,
      totalOutputTokens: 1000,
    };
    renderRequestRow(withCost);
    expect(screen.queryByText(/\$1\.23/)).toBeNull();
    expect(screen.queryByText(/tokens$/)).toBeNull();
  });

  it('renders the source as a lucide icon (no emoji) in the leading position', () => {
    renderRequestRow(baseRequest);
    const icon = screen.getByLabelText('Slack');
    expect(icon).toBeDefined();
    expect(icon.tagName.toLowerCase()).toBe('svg');
  });

  it('navigates to /tasks/:id (canonical V3 route) when the row is clicked', () => {
    renderRequestRow(baseRequest);
    fireEvent.click(screen.getByText('Test request title'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/req-test');
  });

  it('navigates on Enter key press', () => {
    renderRequestRow(baseRequest);
    const row = screen.getByRole('button', { name: /Open request/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/req-test');
  });

  it('expands child items on chevron click without navigating', () => {
    const withChildren: RequestItem = {
      ...baseRequest,
      childItems: [
        { id: 'c1', label: 'Child task 1', status: 'pending' },
        { id: 'c2', label: 'Child task 2', status: 'done' },
      ],
    };
    renderRequestRow(withChildren);

    expect(screen.queryByTestId('request-children')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand work items'));
    expect(screen.getByTestId('request-children')).toBeDefined();
    expect(screen.getByText('Child task 1')).toBeDefined();
    expect(screen.getByText('Child task 2')).toBeDefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders the source label inside the expandable context (not on the baseline scan line)', () => {
    const withChildren: RequestItem = {
      ...baseRequest,
      childItems: [{ id: 'c1', label: 'Child', status: 'pending' }],
    };
    renderRequestRow(withChildren);
    fireEvent.click(screen.getByLabelText('Expand work items'));
    const ctx = screen.getByTestId('request-children');
    expect(within(ctx).getByText('Slack')).toBeDefined();
  });

  it('does not render the chevron when there are no child items', () => {
    renderRequestRow(baseRequest);
    expect(screen.queryByLabelText('Expand work items')).toBeNull();
    expect(screen.queryByTestId('request-children')).toBeNull();
  });

  it('omits the category field when none is provided', () => {
    const noCat: RequestItem = { ...baseRequest, category: undefined };
    renderRequestRow(noCat);
    expect(screen.queryByTestId('request-meta-category')).toBeNull();
  });

  it('shows zero work-item count cleanly when none are linked', () => {
    const zero: RequestItem = { ...baseRequest, workItemCount: 0 };
    renderRequestRow(zero);
    expect(screen.getByTestId('request-meta-workitems').textContent).toContain('0');
  });
});
