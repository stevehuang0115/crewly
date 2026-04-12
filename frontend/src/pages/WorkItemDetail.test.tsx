/**
 * WorkItem Detail Page — Unit Tests
 *
 * @module pages/WorkItemDetail.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkItemDetail } from './WorkItemDetail';

// =============================================================================
// Mocks
// =============================================================================

const mockWorkItem = {
  id: 'test-uuid-1234-5678-abcd-ef0123456789',
  type: 'delegate',
  owner: 'agent',
  target: 'crewly-product-leo',
  title: 'Implement Feature X',
  description: 'Build the feature according to spec',
  status: 'running',
  createdAt: '2026-04-05T10:00:00.000Z',
  startedAt: '2026-04-05T10:01:00.000Z',
  retryCount: 0,
  maxRetries: 3,
  inputTokens: 1500,
  outputTokens: 800,
  cost: 0.0045,
  requestId: 'req-abc-123',
  missionId: 'mission-xyz',
};

vi.mock('../services/api.service', () => ({
  apiService: {
    getWorkItem: vi.fn(),
    getWorkItems: vi.fn(),
    getTaskPoolStats: vi.fn(),
  },
}));

import { apiService } from '../services/api.service';

/**
 * Renders the WorkItemDetail page with a given ID in the route.
 */
function renderWithRoute(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/workitems/${id}`]}>
      <Routes>
        <Route path="/workitems/:id" element={<WorkItemDetail />} />
        <Route path="/workitems" element={<div>WorkItems List</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkItemDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');
    expect(screen.getByTestId('workitem-detail-loading')).toBeDefined();
  });

  it('displays work item details after loading', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItem);
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');

    await waitFor(() => {
      expect(screen.getByTestId('workitem-detail')).toBeDefined();
    });

    expect(screen.getByText(/Implement Feature X/)).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Delegate')).toBeDefined();
  });

  it('shows error state on API failure', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );
    renderWithRoute('nonexistent-id');

    await waitFor(() => {
      expect(screen.getByTestId('workitem-detail-error')).toBeDefined();
    });

    expect(screen.getByText('Failed to load WorkItem')).toBeDefined();
    expect(screen.getByText('Network error')).toBeDefined();
  });

  it('renders the back button', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItem);
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');

    await waitFor(() => {
      expect(screen.getByTestId('workitem-detail-back')).toBeDefined();
    });

    expect(screen.getByText('Back to WorkItems')).toBeDefined();
  });

  it('renders the refresh button', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItem);
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');

    await waitFor(() => {
      expect(screen.getByTestId('workitem-detail-refresh')).toBeDefined();
    });
  });

  it('displays description when present', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItem);
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');

    await waitFor(() => {
      expect(screen.getByText('Build the feature according to spec')).toBeDefined();
    });
  });

  it('displays timeline and metrics sections', async () => {
    (apiService.getWorkItem as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItem);
    renderWithRoute('test-uuid-1234-5678-abcd-ef0123456789');

    await waitFor(() => {
      expect(screen.getByText('Activity Timeline')).toBeDefined();
      expect(screen.getByTestId('workitem-metrics')).toBeDefined();
    });
  });
});
