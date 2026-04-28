// Layout standardization
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
    sourceConversationItemId: 'slack-C123-1775336540.0000',
    title: 'Fix billing issue',
    status: 'open',
    priority: 'high',
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-01T10:01:00Z',
  },
  {
    id: 'req-2',
    sourceConversationItemId: 'slack-C999-1775336500.0000',
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

  it('renders page title', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByText('Requests')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiService.getRequests).toHaveBeenCalled();
    });
  });

  it('renders subtitle', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByText(/Monitor and triage incoming work from all channels/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(apiService.getRequests).toHaveBeenCalled();
    });
  });

  it('renders summary bar, filters, and list after loading', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(screen.getByTestId('requests-page')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /All/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search requests...')).toBeInTheDocument();
  });

  it('filters requests when clicking a status tab', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Fix billing issue')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: /Done/i }));

    await waitFor(() => {
      expect(screen.getByText('Deploy staging')).toBeInTheDocument();
    });
    expect(screen.queryByText('Fix billing issue')).not.toBeInTheDocument();
  });

  it('filters requests when searching', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText('Fix billing issue')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Search requests...'), {
      target: { value: 'billing' },
    });

    await waitFor(() => {
      expect(screen.getByText('Fix billing issue')).toBeInTheDocument();
    });
    expect(screen.queryByText('Deploy staging')).not.toBeInTheDocument();
  });

  it('groups requests by source conversation', async () => {
    render(<MemoryRouter><RequestsPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByTestId('request-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: /All/i }));

    await waitFor(() => {
      expect(screen.getByText('Deploy staging')).toBeInTheDocument();
    });

    expect(screen.getByTestId('conversation-group-slack-C123-1775336540.0000')).toBeInTheDocument();
    expect(screen.getByTestId('conversation-group-slack-C999-1775336500.0000')).toBeInTheDocument();
  });
});
