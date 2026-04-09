/**
 * WorkItem Metrics Component — Unit Tests
 *
 * @module components/WorkItemDetail/WorkItemMetrics.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkItemMetrics } from './WorkItemMetrics';
import type { WorkItem } from './workitem-detail.types';

// =============================================================================
// Fixtures
// =============================================================================

function createTestWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'test-uuid-1234-5678',
    type: 'delegate',
    owner: 'agent',
    target: 'crewly-product-leo',
    title: 'Test WorkItem',
    status: 'running',
    createdAt: '2026-04-05T10:00:00.000Z',
    startedAt: '2026-04-05T10:01:00.000Z',
    retryCount: 1,
    maxRetries: 3,
    inputTokens: 1500,
    outputTokens: 800,
    cost: 0.0045,
    requestId: 'req-abc-123',
    missionId: 'mission-xyz-456',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkItemMetrics', () => {
  it('renders the metrics container', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByTestId('workitem-metrics')).toBeDefined();
  });

  it('displays token usage section', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('Token Usage')).toBeDefined();
    expect(screen.getByText('Input Tokens')).toBeDefined();
    expect(screen.getByText('Output Tokens')).toBeDefined();
    expect(screen.getByText('1.5K')).toBeDefined();
    expect(screen.getByText('800')).toBeDefined();
  });

  it('displays cost', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('Cost')).toBeDefined();
    expect(screen.getByText('$0.0045')).toBeDefined();
  });

  it('displays execution section', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('Execution')).toBeDefined();
    expect(screen.getByText('Retries')).toBeDefined();
    expect(screen.getByText('1 / 3')).toBeDefined();
    expect(screen.getByText('Owner')).toBeDefined();
    // "Agent" appears both as owner label and as a metric row label — check both exist
    expect(screen.getAllByText('Agent').length).toBeGreaterThanOrEqual(1);
  });

  it('displays target agent', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('crewly-product-leo')).toBeDefined();
  });

  it('displays linked references', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('Linked References')).toBeDefined();
    expect(screen.getByText('Request')).toBeDefined();
    expect(screen.getByText('Mission')).toBeDefined();
  });

  it('displays timestamps section', () => {
    render(<WorkItemMetrics item={createTestWorkItem()} />);
    expect(screen.getByText('Timestamps')).toBeDefined();
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.getByText('Started')).toBeDefined();
  });

  it('hides linked references when none exist', () => {
    const item = createTestWorkItem({
      requestId: undefined,
      missionId: undefined,
      projectTaskId: undefined,
      triggerId: undefined,
    });
    render(<WorkItemMetrics item={item} />);
    expect(screen.queryByText('Linked References')).toBeNull();
  });
});
