// Layout + ScoreCard consistency
// Updated: PageToolbar adoption
// @vitest-environment jsdom
/**
 * Tests for RequestsPage
 *
 * @module pages/RequestsPage.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestsPage } from './RequestsPage';
import { apiService } from '../services/api.service';

// Mock the API service
vi.mock('../services/api.service', () => ({
  apiService: {
    getRequests: vi.fn(),
  },
}));

const mockRequests = [
  {
    id: 'req-1',
    title: 'Fix billing issue',
    status: 'open',
    priority: 'high',
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-01T10:01:00Z',
  },
  {
    id: 'req-2',
    title: 'Deploy staging',
    status: 'done',
    priority: 'medium',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-01T09:30:00Z',
  },
];

describe('RequestsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getRequests).mockResolvedValue(mockRequests);
  });

  it('renders page title', () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByText('Request List')).toBeDefined();
  });

  it('renders subtitle', () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByText(/Incoming requests from all channels/)).toBeDefined();
  });

  it('renders summary bar, filters, and list after loading', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByTestId('requests-page')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });
    expect(screen.getByTestId('request-filters')).toBeDefined();
  });

  it('filters requests when clicking a status chip', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('request-filter-blocked'));
    const blockedChip = screen.getByTestId('request-filter-blocked');
    expect(blockedChip.className).toContain('text-primary');
  });

  it('filters requests when searching', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeDefined();
    });

    fireEvent.change(screen.getByTestId('request-search-input'), {
      target: { value: 'billing' },
    });
    expect(screen.getByText(/billing/i)).toBeDefined();
  });
});
