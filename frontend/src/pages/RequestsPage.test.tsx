// @vitest-environment jsdom
/**
 * Tests for Tickets › Requests.
 *
 * @module pages/RequestsPage.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequestsPage } from './RequestsPage';
import { apiService } from '../services/api.service';

vi.mock('../services/api.service', () => ({
  apiService: {
    getRequests: vi.fn(),
    getTeams: vi.fn(),
  },
}));

const mockRequests = [
  {
    id: 'req-1', title: '[Fix] Fix billing issue', status: 'open', priority: 'high', intentCategory: 'code_change',
    ownerAgent: 'crewly-ops-ivy-1', workItemIds: ['w1', 'w2'], tags: ['slack'], totalCost: 0.5,
    openItems: [{ status: 'open' }], createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:01:00Z',
  },
  {
    id: 'req-2', title: 'Deploy staging', status: 'done', priority: 'medium', totalCost: 0.25,
    createdAt: '2026-04-01T09:00:00Z', updatedAt: '2026-04-01T09:30:00Z',
  },
  {
    id: 'req-3', title: 'Waiting on you', status: 'waiting_confirmation', priority: 'normal',
    createdAt: '2026-04-01T09:00:00Z', updatedAt: '2026-04-01T09:40:00Z',
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/tickets?tab=requests']}>
      <Routes>
        <Route path="/tickets" element={<RequestsPage />} />
        <Route path="/tickets/requests/:id" element={<div>Request detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequestsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getRequests).mockResolvedValue(mockRequests);
    vi.mocked(apiService.getTeams).mockResolvedValue([
      { id: 't', name: 'Ops', members: [{ sessionName: 'crewly-ops-ivy-1', name: 'Ivy' }] },
    ] as never);
  });

  it('shows active requests by default as compact rows with a quiet meta line', async () => {
    renderPage();
    const row = await screen.findByTestId('request-row-req-1');
    expect(within(row).getByText('Fix billing issue')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('1 open item ·')).toBeInTheDocument();
    await waitFor(() => expect(row).toHaveTextContent('code change · via Ivy · Urgent · 2 runs'));
    expect(screen.queryByText('Deploy staging')).toBeNull();
    expect(screen.getByTestId('filter-chip')).toHaveTextContent('Status: Active');
    expect(screen.getByTestId('requests-total')).toHaveTextContent('3 requests · total cost $0.75');
  });

  it('switches status behind the Filter button (counts in the options)', async () => {
    renderPage();
    await screen.findByTestId('request-list');
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByRole('radio', { name: /Waiting/ }));
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.queryByText('Fix billing issue')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Waiting/ }));
    // No status = all.
    expect(screen.getByText('Deploy staging')).toBeInTheDocument();
  });

  it('filters Urgent and searches', async () => {
    renderPage();
    await screen.findByTestId('request-list');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Status: Active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search requests…' }));
    fireEvent.change(screen.getByTestId('request-search-input'), { target: { value: 'deploy' } });
    await waitFor(() => expect(screen.queryByText('Fix billing issue')).toBeNull());
    expect(screen.getByText('Deploy staging')).toBeInTheDocument();
  });

  it('opens the request detail', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Fix billing issue/ }));
    expect(screen.getByText('Request detail page')).toBeInTheDocument();
  });

  it('shows errors with Retry', async () => {
    vi.mocked(apiService.getRequests).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Fix billing issue')).toBeInTheDocument();
  });
});
