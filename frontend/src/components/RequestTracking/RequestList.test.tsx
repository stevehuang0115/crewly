// @vitest-environment jsdom
/**
 * Tests for RequestList component
 *
 * Mocks apiService.getRequests to return sample Request objects,
 * then verifies filtering, search, stats callback, and empty-state rendering.
 *
 * @module components/RequestTracking/RequestList.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestList } from './RequestList';

// Mock the API service
vi.mock('../../services/api.service', () => ({
  apiService: {
    getRequests: vi.fn(),
  },
}));

import { apiService } from '../../services/api.service';

/** Sample requests returned by the mocked API */
const MOCK_REQUESTS = [
  {
    id: 'req-001',
    title: 'Implement authentication flow',
    status: 'open',
    priority: 'high',
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    missionId: 'mission-1',
    workItemIds: ['wi-001'],
    intentLevel: 'L1',
  },
  {
    id: 'req-002',
    title: 'Deploy staging environment',
    status: 'blocked',
    priority: 'normal',
    createdAt: '2026-04-02T12:00:00Z',
    updatedAt: '2026-04-02T14:00:00Z',
    workItemIds: ['wi-002'],
    intentLevel: 'L1',
  },
  {
    id: 'req-003',
    title: 'Write unit tests for auth module',
    status: 'done',
    priority: 'low',
    createdAt: '2026-04-03T08:00:00Z',
    updatedAt: '2026-04-03T10:00:00Z',
    workItemIds: ['wi-003'],
    intentLevel: 'L0',
  },
];

describe('RequestList', () => {
  const defaultProps = {
    activeFilter: 'all' as const,
    searchQuery: '',
    onStatsLoaded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_REQUESTS);
  });

  it('renders request list after loading from API', async () => {
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    // Initially shows loading
    expect(screen.getByTestId('request-list-loading')).toBeDefined();
    // After API resolves, shows list
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
  });

  it('calls onStatsLoaded with statistics', async () => {
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    // After data loads, onStatsLoaded is called with updated stats
    const lastCall = defaultProps.onStatsLoaded.mock.calls[defaultProps.onStatsLoaded.mock.calls.length - 1];
    expect(lastCall[0].total).toBe(3);
  });

  it('filters by status when activeFilter is set', async () => {
    render(<MemoryRouter><RequestList {...defaultProps} activeFilter="blocked" /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    const list = screen.getByTestId('request-list');
    const rows = list.querySelectorAll('[data-testid^="request-row-"]');
    expect(rows.length).toBe(1);
  });

  it('shows empty state with icon (no emoji) when search matches nothing', async () => {
    render(<MemoryRouter><RequestList {...defaultProps} searchQuery="zzzznonexistent" /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list-empty')).toBeDefined();
    });
    const empty = screen.getByTestId('request-list-empty');
    // Verify no emoji — should have SVG icon instead
    const svg = empty.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('filters by search query', async () => {
    render(<MemoryRouter><RequestList {...defaultProps} searchQuery="authentication" /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    const list = screen.getByTestId('request-list');
    const rows = list.querySelectorAll('[data-testid^="request-row-"]');
    expect(rows.length).toBe(1);
  });

  it('maps backend status correctly', async () => {
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'r1', title: 'Open request', status: 'open', priority: 'normal', createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:00:00Z' },
      { id: 'r2', title: 'Done request', status: 'done', priority: 'normal', createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:00:00Z' },
    ]);
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    // open → active, done → completed; both render as rows
    const list = screen.getByTestId('request-list');
    const rows = list.querySelectorAll('[data-testid^="request-row-"]');
    expect(rows.length).toBe(2);
  });

  it('maps backend "ready" and "running" to frontend "active" (Steve 2026-04-29 mapper fix)', async () => {
    // Pre-fix bug: the mapper used a stale literal 'in_progress'; backend
    // statuses 'ready'/'running' fell through to the default→'active' branch.
    // Same display result, but the missing explicit cases meant any future
    // backend status would silently render as Active. Now both are listed
    // explicitly + a default-branch console.warn surfaces unknown statuses
    // during dev.
    const baseRow = {
      priority: 'normal',
      createdAt: '2026-04-01T10:00:00Z',
      updatedAt: '2026-04-01T10:00:00Z',
    };
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'r-ready', title: 'Ready request', status: 'ready', ...baseRow },
      { id: 'r-running', title: 'Running request', status: 'running', ...baseRow },
      { id: 'r-cancelled', title: 'Cancelled request', status: 'cancelled', ...baseRow },
    ]);
    render(
      <MemoryRouter>
        <RequestList {...defaultProps} activeFilter="active" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    const list = screen.getByTestId('request-list');
    const rows = list.querySelectorAll('[data-testid^="request-row-"]');
    // Filter activeFilter="active" → only ready + running render; cancelled
    // maps to 'done' (via the same explicit case) and is filtered out.
    expect(rows.length).toBe(2);
  });

  it('warns on an unknown backend status and falls back to "active"', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'r-future',
        title: 'Future-status request',
        status: 'totally_unknown_future_status',
        priority: 'normal',
        createdAt: '2026-04-01T10:00:00Z',
        updatedAt: '2026-04-01T10:00:00Z',
      },
    ]);
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[RequestList] Unknown backend Request status:',
      'totally_unknown_future_status',
    );
    consoleSpy.mockRestore();
  });

  it('shows error state when API fails', async () => {
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list-error')).toBeDefined();
    });
  });

  it('shows empty state when API returns empty array', async () => {
    (apiService.getRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<MemoryRouter><RequestList {...defaultProps} /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByTestId('request-list-empty')).toBeDefined();
    });
  });
});
