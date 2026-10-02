// Layout + ScoreCard consistency
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
    getTeams: vi.fn(),
  },
}));

vi.mock('../services/project-tickets.service', () => ({
  listAllProjectTickets: vi.fn().mockResolvedValue([{ project: { id: 'p1', name: 'CE', path: '/ce' }, tickets: [{ id: 'CE-1' }] }]),
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

describe('WorkItems (Tickets › Runs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiService.getTeams as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 't', name: 'Product', members: [{ sessionName: 'crewly-product-leo', name: 'Leo' }] },
    ]);
  });

  it('shows loading state initially', () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId('workitems-loading')).toBeDefined();
  });

  it('renders runs as compact rows: running first, agent name, status word', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-list')).toBeDefined());
    const rows = screen.getAllByTestId(/^workitem-row-/);
    expect(rows[0]).toHaveTextContent('Implement API endpoint');
    await waitFor(() => expect(rows[0]).toHaveTextContent('Delegate · Leo · Product'));
    expect(rows[0]).toHaveTextContent('Running');
    expect(screen.getByText('Health check')).toBeDefined();
    expect(screen.getByText('Write unit tests')).toBeDefined();
    expect(screen.getByTestId('workitems-total')).toHaveTextContent('3 runs in the pool');
  });

  it('shows the ticket a run belongs to, ignoring look-alikes', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockWorkItems[1], id: 'wi-ce', title: 'CE-69: ship it with GPT-5' },
      { ...mockWorkItems[1], id: 'wi-gpt', title: 'Compare GPT-5 and UTF-8 output' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitem-row-wi-ce')).toHaveTextContent('Check · CE-69'));
    expect(screen.getByTestId('workitem-row-wi-gpt')).not.toHaveTextContent('GPT-5 ·');
  });

  it('shows empty state when no items', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-empty')).toBeDefined());
  });

  it('shows error state on API failure', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-error')).toBeDefined());
    expect(screen.getByText('Server error')).toBeDefined();
  });

  it('filters by status behind the Filter button, with counts', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-list')).toBeDefined());
    fireEvent.click(screen.getByTestId('filter-button'));
    for (const label of ['Running', 'Queued', 'Completed', 'Failed', 'Blocked', 'Cancelled']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeDefined();
    }
    fireEvent.click(screen.getByRole('radio', { name: /Running/ }));
    expect(screen.getByText('Implement API endpoint')).toBeDefined();
    expect(screen.queryByText('Health check')).toBeNull();
    expect(screen.queryByText('Write unit tests')).toBeNull();
    expect(screen.getByTestId('filter-chip')).toHaveTextContent('Status: Running');
  });

  it('filters by search query (title, id, agent)', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-list')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Search by title, ID, agent…' }));
    fireEvent.change(screen.getByTestId('workitems-search'), { target: { value: 'health' } });
    await waitFor(() => expect(screen.queryByText('Implement API endpoint')).toBeNull());
    expect(screen.getByText('Health check')).toBeDefined();
  });

  it('has a refresh button that reloads', async () => {
    (apiService.getWorkItems as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkItems);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('workitems-list')).toBeDefined());
    fireEvent.click(screen.getByTestId('workitems-refresh'));
    await waitFor(() => expect(apiService.getWorkItems).toHaveBeenCalledTimes(2));
  });
});
