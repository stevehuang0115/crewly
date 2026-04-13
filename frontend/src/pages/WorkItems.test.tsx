// Updated: PageToolbar adoption
/**
 * WorkItems List Page — Unit Tests
 *
 * @module pages/WorkItems.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkItems } from './WorkItems';

// =============================================================================
// Mocks
// =============================================================================

const mockWorkItems = [
  {
    id: 'wi-001',
    type: 'delegate',
    owner: 'agent',
    target: 'crewly-product-leo',
    title: 'Implement API endpoint',
    status: 'running',
    createdAt: '2026-04-05T10:00:00.000Z',
    startedAt: '2026-04-05T10:01:00.000Z',
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 500,
    outputTokens: 200,
    cost: 0.002,
  },
  {
    id: 'wi-002',
    type: 'check',
    owner: 'system',
    title: 'Health check',
    status: 'done',
    createdAt: '2026-04-05T09:00:00.000Z',
    completedAt: '2026-04-05T09:02:00.000Z',
    retryCount: 0,
    maxRetries: 1,
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.0005,
  },
  {
    id: 'wi-003',
    type: 'delegate',
    owner: 'agent',
    target: 'crewly-product-sam',
    title: 'Write unit tests',
    status: 'queued',
    createdAt: '2026-04-05T11:00:00.000Z',
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  },
];

vi.mock('../services/api.service', () => ({
  apiService: {
    getWorkItems: vi.fn(),
    getWorkItem: vi.fn(),
    getTaskPoolStats: vi.fn(),
  },
}));

import { apiService } from '../services/api.service';

/**
 * Renders the WorkItems page inside a MemoryRouter.
 */
function renderPage() {
  return render(
    <MemoryRouter>
      <WorkItems />
    </MemoryRouter>
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId('workitems-loading')).toBeDefined();
  });

  it('renders work items after loading', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('workitems-list')).toBeDefined();
    });

    expect(screen.getByText('Implement API endpoint')).toBeDefined();
    expect(screen.getByText('Health check')).toBeDefined();
    expect(screen.getByText('Write unit tests')).toBeDefined();
  });

  it('shows empty state when no items', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('workitems-empty')).toBeDefined();
    });
  });

  it('shows error state on API failure', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Server error')
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('workitems-error')).toBeDefined();
    });

    expect(screen.getByText('Server error')).toBeDefined();
  });

  it('renders filter buttons', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('filter-all')).toBeDefined();
      expect(screen.getByTestId('filter-running')).toBeDefined();
      expect(screen.getByTestId('filter-queued')).toBeDefined();
      expect(screen.getByTestId('filter-done')).toBeDefined();
    });
  });

  it('filters by status when filter button clicked', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('workitems-list')).toBeDefined();
    });

    // Click "Running" filter
    fireEvent.click(screen.getByTestId('filter-running'));

    // Should only show running items
    expect(screen.getByText('Implement API endpoint')).toBeDefined();
    expect(screen.queryByText('Health check')).toBeNull();
    expect(screen.queryByText('Write unit tests')).toBeNull();
  });

  it('filters by search query', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('workitems-list')).toBeDefined();
    });

    const searchInput = screen.getByTestId('workitems-search');
    fireEvent.change(searchInput, { target: { value: 'health' } });

    expect(screen.getByText('Health check')).toBeDefined();
    expect(screen.queryByText('Implement API endpoint')).toBeNull();
  });

  it('renders page title and description', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage();

    expect(screen.getByText('WorkItems')).toBeDefined();
    expect(
      screen.getByText('Execution-level view of all system WorkItems in the task pool.')
    ).toBeDefined();
  });

  it('has a refresh button', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();

    expect(screen.getByTestId('workitems-refresh')).toBeDefined();
  });
});
