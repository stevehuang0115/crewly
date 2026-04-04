/**
 * Tests for TasksPage component.
 *
 * @module pages/TasksPage.test
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TasksPage } from './TasksPage';
import type { MessageGroup, TaskStatistics } from '../components/TaskTracking/task-tracking.types';

const mockGroups: MessageGroup[] = [
  {
    messageId: 'msg-1',
    originalMessage: 'Fix login and deploy',
    createdAt: new Date().toISOString(),
    tasks: [
      {
        id: 'task-1',
        messageId: 'msg-1',
        intent: 'Fix login',
        level: 'L1',
        category: 'debugging',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 1,
        totalTokens: 5000,
        totalCost: 0.15,
        assignedSessions: [],
        order: 0,
      },
    ],
    completedCount: 0,
    totalCount: 1,
  },
];

const mockStats: TaskStatistics = {
  totalTasks: 1,
  byStatus: { in_progress: 1 },
  byLevel: { L1: 1 },
  totalTokens: 5000,
  totalCost: 0.15,
  totalMessages: 1,
};

function setupFetchMock(groups = mockGroups, stats = mockStats) {
  (global.fetch as any).mockImplementation((url: string) => {
    if (url.includes('statistics')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: stats }) });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: groups }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
  });
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page header with title and subtitle', async () => {
    setupFetchMock();
    render(<TasksPage />);
    expect(screen.getByTestId('tasks-page-header')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText(/AI-generated action items/)).toBeInTheDocument();
  });

  it('renders the summary bar after data loads', async () => {
    setupFetchMock();
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('task-summary-bar')).toBeInTheDocument();
    });
  });

  it('renders the filter controls', async () => {
    setupFetchMock();
    render(<TasksPage />);
    expect(screen.getByTestId('task-filters')).toBeInTheDocument();
    expect(screen.getByTestId('task-search')).toBeInTheDocument();
    expect(screen.getByTestId('filter-all')).toBeInTheDocument();
    expect(screen.getByTestId('filter-active')).toBeInTheDocument();
  });

  it('renders the task feed with message groups', async () => {
    setupFetchMock();
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('message-group-card')).toHaveLength(1);
  });

  it('renders empty state when no tasks exist', async () => {
    setupFetchMock([], { ...mockStats, totalTasks: 0, totalMessages: 0 });
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });

  it('filters tasks when a filter chip is clicked', async () => {
    setupFetchMock();
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });

    // Click "Completed" filter — no completed tasks in mock, should show filter-empty
    fireEvent.click(screen.getByTestId('filter-completed'));
    expect(screen.getByTestId('tasks-filter-empty')).toBeInTheDocument();
  });

  it('filters tasks when search query is entered', async () => {
    setupFetchMock();
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('task-search'), { target: { value: 'nonexistent' } });
    expect(screen.getByTestId('tasks-filter-empty')).toBeInTheDocument();
  });

  it('shows summary stats after loading', async () => {
    setupFetchMock();
    render(<TasksPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-active')).toHaveTextContent('1');
    });
  });
});
