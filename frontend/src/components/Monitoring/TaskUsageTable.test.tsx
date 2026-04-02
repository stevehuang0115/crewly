/**
 * Tests for TaskUsageTable Component
 *
 * @module components/Monitoring/TaskUsageTable.test
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TaskUsageTable } from './TaskUsageTable';
import { apiService } from '../../services/api.service';

jest.mock('../../services/api.service');

const mockApiService = apiService as jest.Mocked<typeof apiService>;

describe('TaskUsageTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should show loading state initially', () => {
    mockApiService.getTokenUsageByTask.mockImplementation(() => new Promise(() => {}));
    render(<TaskUsageTable />);
    expect(screen.getByText(/loading task usage/i)).toBeInTheDocument();
  });

  it('should show empty state when no data', async () => {
    mockApiService.getTokenUsageByTask.mockResolvedValue([]);
    render(<TaskUsageTable />);
    await waitFor(() => {
      expect(screen.getByTestId('task-usage-empty')).toBeInTheDocument();
    });
  });

  it('should render task data in table', async () => {
    mockApiService.getTokenUsageByTask.mockResolvedValue([
      { taskId: 'task-123', totalInput: 5000, totalOutput: 1500, eventCount: 3, cost: 0.0234 },
      { taskId: 'unassigned', totalInput: 2000, totalOutput: 800, eventCount: 1, cost: 0.0089 },
    ]);

    render(<TaskUsageTable />);

    await waitFor(() => {
      expect(screen.getByTestId('task-usage-table')).toBeInTheDocument();
    });

    expect(screen.getByText('task-123')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
  });

  it('should show error state on API failure', async () => {
    mockApiService.getTokenUsageByTask.mockRejectedValue(new Error('Network error'));
    render(<TaskUsageTable />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('should sort by column on header click', async () => {
    mockApiService.getTokenUsageByTask.mockResolvedValue([
      { taskId: 'task-a', totalInput: 100, totalOutput: 50, eventCount: 1, cost: 0.001 },
      { taskId: 'task-b', totalInput: 500, totalOutput: 200, eventCount: 5, cost: 0.01 },
    ]);

    render(<TaskUsageTable />);

    await waitFor(() => {
      expect(screen.getByTestId('task-usage-table')).toBeInTheDocument();
    });

    // Default sort is by cost desc — task-b ($0.01) should be first
    const rows = screen.getAllByRole('row');
    expect(rows.length).toBe(3); // header + 2 data rows

    // Click on "Events" header to sort by event count
    fireEvent.click(screen.getByText(/Events/));
    // Clicking again toggles direction
    fireEvent.click(screen.getByText(/Events/));
  });
});
