// @vitest-environment jsdom
/**
 * Tests for RequestRow component
 *
 * @module components/RequestTracking/RequestRow.test
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestRow } from './RequestRow';
import type { RequestItem } from './request-tracking.types';

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

describe('RequestRow', () => {
  const baseRequest: RequestItem = {
    id: 'req-test',
    title: 'Test request title',
    status: 'active',
    priority: 'high',
    source: 'slack',
    requester: 'Test User',
    updatedAt: new Date().toISOString(),
    missionLink: 'Mission Link: Test',
  };

  it('renders the request title', () => {
    renderRequestRow(baseRequest);
    expect(screen.getByText('Test request title')).toBeDefined();
  });

  it('renders StatusBadge for status', () => {
    renderRequestRow(baseRequest);
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('renders Badge for priority', () => {
    renderRequestRow(baseRequest);
    expect(screen.getByText('High')).toBeDefined();
  });

  it('renders requester name', () => {
    renderRequestRow(baseRequest);
    expect(screen.getByText('Requester: Test User')).toBeDefined();
  });

  it('renders source label as Badge (no emoji)', () => {
    renderRequestRow(baseRequest);
    expect(screen.getByText('Slack')).toBeDefined();
  });

  it('renders lucide icon for source (no emoji)', () => {
    renderRequestRow(baseRequest);
    const icon = screen.getByLabelText('Slack');
    expect(icon).toBeDefined();
    expect(icon.tagName.toLowerCase()).toBe('svg');
  });

  it('expands child items on click when present', () => {
    const withChildren: RequestItem = {
      ...baseRequest,
      childItems: [
        { id: 'c1', label: 'Child task 1', status: 'pending' },
        { id: 'c2', label: 'Child task 2', status: 'completed' },
      ],
    };
    renderRequestRow(withChildren);

    // Children not visible initially
    expect(screen.queryByTestId('request-children')).toBeNull();

    // Click the expand button (chevron) to expand children
    const expandBtn = screen.getByLabelText('Expand work items');
    fireEvent.click(expandBtn);
    expect(screen.getByTestId('request-children')).toBeDefined();
    expect(screen.getByText('Child task 1')).toBeDefined();
    expect(screen.getByText('Child task 2')).toBeDefined();
  });

  it('does not expand when no child items', () => {
    renderRequestRow(baseRequest);
    fireEvent.click(screen.getByText('Test request title'));
    expect(screen.queryByTestId('request-children')).toBeNull();
  });
});
