// @vitest-environment jsdom
/**
 * Request Detail Page Tests — approve/reject only for waiting_confirmation
 *
 * @module pages/RequestDetail.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequestDetail } from './RequestDetail';

// Mock apiService
vi.mock('../services/api.service', () => ({
  apiService: {
    getRequest: vi.fn(),
    getWorkItemsByRequest: vi.fn(),
    updateRequest: vi.fn(),
  },
}));

// The timeline has its own tests; here only which trace the tab asks for.
vi.mock('../components/TraceTimeline', () => ({
  TraceTimeline: ({ traceId, refParam, refId }: { traceId?: string; refParam?: string; refId?: string }) => (
    <div data-testid="trace-timeline-stub">{`trace=${traceId ?? 'none'} ref=${refParam}:${refId}`}</div>
  ),
}));

import { apiService } from '../services/api.service';

const mockRequest = {
  id: 'req-001',
  title: 'Test Request',
  description: 'A test request description',
  status: 'in_progress',
  priority: 'high',
  requiresConfirmation: false,
  workItemIds: ['wi-001'],
  intentLevel: 'L2',
  intentCategory: 'code_change',
  tags: ['test'],
  createdAt: '2026-04-08T10:00:00.000Z',
  updatedAt: '2026-04-08T11:00:00.000Z',
  totalInputTokens: 1500,
  totalOutputTokens: 500,
  totalCost: 0.005,
  sourceConversationItemId: 'conv-001',
};

const mockWorkItem = {
  id: 'wi-001',
  requestId: 'req-001',
  type: 'delegate',
  owner: 'orchestrator',
  target: 'agent-1',
  title: 'Test Work Item',
  description: 'A test work item',
  status: 'running',
  createdAt: '2026-04-08T10:05:00.000Z',
  startedAt: '2026-04-08T10:06:00.000Z',
  retryCount: 0,
  maxRetries: 2,
  inputTokens: 1000,
  outputTokens: 300,
  cost: 0.003,
};

/**
 * Renders the RequestDetail page with a given route ID.
 *
 * @param id - Request ID to pass via route params
 */
function renderWithRouter(id = 'req-001') {
  return render(
    <MemoryRouter initialEntries={[`/requests/${id}`]}>
      <Routes>
        <Route path="/requests/:id" element={<RequestDetail />} />
        <Route path="/requests" element={<div>Request List</div>} />
        <Route path="/workitems/:id" element={<div>WorkItem Detail</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RequestDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading spinner initially', () => {
    vi.mocked(apiService.getRequest).mockReturnValue(new Promise(() => {}));
    vi.mocked(apiService.getWorkItemsByRequest).mockReturnValue(new Promise(() => {}));

    renderWithRouter();

    expect(screen.getByTestId('request-detail-loading')).toBeInTheDocument();
  });

  it('renders request detail after loading', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([mockWorkItem]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-detail')).toBeInTheDocument();
    });

    // Title
    expect(screen.getByText('Test Request')).toBeInTheDocument();
    // Description
    expect(screen.getByText('A test request description')).toBeInTheDocument();
    // Status badge — may appear in both status badge and progress rail
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    // Category badge
    expect(screen.getByText(/code change/)).toBeInTheDocument();
    // Back button
    expect(screen.getByTestId('request-detail-back')).toBeInTheDocument();
  });

  it('renders work items section', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([mockWorkItem]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-detail-workitems')).toBeInTheDocument();
    });

    expect(screen.getByText('Test Work Item')).toBeInTheDocument();
    expect(screen.getByTestId(`request-workitem-${mockWorkItem.id}`)).toBeInTheDocument();
  });

  it('renders empty work items state', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-workitems-empty')).toBeInTheDocument();
    });
  });

  it('shows error state on API failure', async () => {
    vi.mocked(apiService.getRequest).mockRejectedValue(new Error('Network error'));
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-detail-error')).toBeInTheDocument();
    });

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('renders progress rail', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-progress-rail')).toBeInTheDocument();
    });
  });

  it('renders stats sidebar with token and cost info', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([mockWorkItem]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('Statistics')).toBeInTheDocument();
    });

    // Token display
    expect(screen.getByText('2.0K')).toBeInTheDocument(); // 1500 + 500
    // Cost display
    expect(screen.getByText('$0.0050')).toBeInTheDocument();
  });

  it('renders source conversation reference', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('conv-001')).toBeInTheDocument();
    });
  });

  it('shows approval and rejection buttons for requests awaiting confirmation; Approve completes it', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue({ ...mockRequest, status: 'waiting_confirmation', requiresConfirmation: true });
    vi.mocked(apiService.updateRequest).mockResolvedValue(undefined);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-detail')).toBeInTheDocument();
    });

    expect(screen.getByTestId('request-action-area')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(apiService.updateRequest).toHaveBeenCalledWith('req-001', { status: 'done' }));
  });

  it('hides approval buttons for completed requests', async () => {
    const doneRequest = { ...mockRequest, status: 'done' };
    vi.mocked(apiService.getRequest).mockResolvedValue(doneRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByTestId('request-detail')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('request-action-area')).not.toBeInTheDocument();
  });

  it('renders tags', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);

    renderWithRouter();

    await waitFor(() => {
      expect(screen.getByText('test')).toBeInTheDocument();
    });
  });

  it('has Overview and Timeline tabs; Timeline shows the run trace of the request', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue({ ...mockRequest, traceId: 'tr-20261003-0000abcd' });
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);
    renderWithRouter();
    const timelineTab = await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('request-panel-overview')).toBeInTheDocument();
    fireEvent.click(timelineTab);
    expect(await screen.findByTestId('trace-timeline-stub')).toHaveTextContent('trace=tr-20261003-0000abcd ref=requestId:req-001');
    expect(screen.queryByTestId('request-panel-overview')).not.toBeInTheDocument();
  });

  it('opens on the Timeline tab from ?tab=timeline and looks the trace up by request when it has none', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/tickets/requests/req-001?tab=timeline']}>
        <Routes>
          <Route path="/tickets/requests/:id" element={<RequestDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('trace-timeline-stub')).toHaveTextContent('trace=none ref=requestId:req-001');
  });

  it('expands a run timeline and opens the run detail', async () => {
    vi.mocked(apiService.getRequest).mockResolvedValue(mockRequest);
    vi.mocked(apiService.getWorkItemsByRequest).mockResolvedValue([mockWorkItem]);
    render(
      <MemoryRouter initialEntries={['/tickets/requests/req-001']}>
        <Routes>
          <Route path="/tickets/requests/:id" element={<RequestDetail />} />
          <Route path="/tickets/runs/:id" element={<div>Run detail page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Test Work Item/ }));
    expect(screen.getByTestId('request-workitem-timeline-wi-001')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('request-workitem-detail-link-wi-001'));
    expect(screen.getByText('Run detail page')).toBeInTheDocument();
  });
});
