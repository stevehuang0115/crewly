/**
 * WorkItem Timeline Component — Unit Tests
 *
 * @module components/WorkItemDetail/WorkItemTimeline.test
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkItemTimeline } from './WorkItemTimeline';
import type { TimelineEvent } from './workitem-detail.types';

// =============================================================================
// Fixtures
// =============================================================================

const SAMPLE_EVENTS: TimelineEvent[] = [
  {
    id: 'evt-1',
    kind: 'status_change',
    label: 'RUNNING',
    detail: 'Claimed by agent: crewly-product-leo',
    timestamp: '2026-04-05T10:01:00.000Z',
    status: 'running',
  },
  {
    id: 'evt-2',
    kind: 'status_change',
    label: 'QUEUED',
    detail: 'WorkItem created and added to pool.',
    timestamp: '2026-04-05T10:00:00.000Z',
    status: 'queued',
  },
];

const ERROR_EVENT: TimelineEvent = {
  id: 'evt-3',
  kind: 'error',
  label: 'ERROR',
  detail: 'Connection timeout after 30s',
  timestamp: '2026-04-05T10:02:00.000Z',
  status: 'failed',
};

// =============================================================================
// Tests
// =============================================================================

describe('WorkItemTimeline', () => {
  it('renders empty state when no events', () => {
    render(<WorkItemTimeline events={[]} />);
    expect(screen.getByTestId('timeline-empty')).toBeDefined();
    expect(screen.getByText('No activity recorded yet.')).toBeDefined();
  });

  it('renders timeline events', () => {
    render(<WorkItemTimeline events={SAMPLE_EVENTS} />);
    expect(screen.getByTestId('workitem-timeline')).toBeDefined();
    expect(screen.getByText('RUNNING')).toBeDefined();
    expect(screen.getByText('QUEUED')).toBeDefined();
  });

  it('shows event details', () => {
    render(<WorkItemTimeline events={SAMPLE_EVENTS} />);
    expect(screen.getByText('Claimed by agent: crewly-product-leo')).toBeDefined();
    expect(screen.getByText('WorkItem created and added to pool.')).toBeDefined();
  });

  it('renders error events with error styling', () => {
    render(<WorkItemTimeline events={[ERROR_EVENT]} />);
    expect(screen.getByText('ERROR')).toBeDefined();
    expect(screen.getByText('Connection timeout after 30s')).toBeDefined();
  });

  it('renders correct number of timeline events', () => {
    render(<WorkItemTimeline events={SAMPLE_EVENTS} />);
    expect(screen.getByTestId('timeline-event-evt-1')).toBeDefined();
    expect(screen.getByTestId('timeline-event-evt-2')).toBeDefined();
  });
});
