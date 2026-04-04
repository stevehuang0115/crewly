/**
 * Tests for TaskList component — V3
 *
 * @module components/TaskTracking/TaskList.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskList } from './TaskList';
import type { MessageGroup, TaskStatistics } from './task-tracking.types';

const mockGroups: MessageGroup[] = [
  {
    messageId: 'msg-1',
    originalMessage: 'Fix the login bug then deploy to staging',
    createdAt: new Date().toISOString(),
    tasks: [
      {
        id: 'task-1',
        messageId: 'msg-1',
        intent: 'Fix the login bug',
        level: 'L1',
        category: 'debugging',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 1,
        totalTokens: 5000,
        totalCost: 0.15,
        assignedSessions: ['agent-1'],
        order: 0,
      },
      {
        id: 'task-2',
        messageId: 'msg-1',
        intent: 'deploy to staging',
        level: 'L2',
        category: 'deployment',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 2,
        totalTokens: 12000,
        totalCost: 0.36,
        assignedSessions: ['agent-1', 'agent-2'],
        order: 1,
      },
    ],
    completedCount: 1,
    totalCount: 2,
  },
];

const mockStats: TaskStatistics = {
  totalTasks: 2,
  byStatus: { in_progress: 1, completed: 1 },
  byLevel: { L1: 1, L2: 1 },
  totalTokens: 17000,
  totalCost: 0.51,
  totalMessages: 1,
};

const defaultProps = {
  activeFilter: 'all' as const,
  searchQuery: '',
  advancedFilter: '',
};

/** Sets up mock fetch that returns groups and stats */
function setupFetchMock(groups = mockGroups, stats = mockStats) {
  (global.fetch as any).mockImplementation((url: string) => {
    if (url.includes('statistics')) {
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, data: stats }),
      });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({
        json: () => Promise.resolve({ success: true, data: groups }),
      });
    }
    return Promise.resolve({
      json: () => Promise.resolve({ success: true, data: [] }),
    });
  });
}

describe('TaskList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows skeleton loading state initially', () => {
    (global.fetch as any).mockImplementation(() => new Promise(() => {}));
    render(<TaskList {...defaultProps} />);
    expect(screen.getByTestId('task-feed-loading')).toBeInTheDocument();
    expect(screen.getAllByTestId('task-skeleton')).toHaveLength(3);
  });

  it('renders message group cards after loading', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('message-group-card')).toHaveLength(1);
  });

  it('shows empty state when no tasks exist', async () => {
    setupFetchMock([], { ...mockStats, totalTasks: 0, totalMessages: 0 });
    render(<TaskList {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByTestId('tasks-empty-cta')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    (global.fetch as any).mockImplementation(() => Promise.reject(new Error('Network error')));
    render(<TaskList {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
  });

  it('shows retry button in error state', async () => {
    (global.fetch as any).mockImplementation(() => Promise.reject(new Error('fail')));
    render(<TaskList {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-error-retry')).toBeInTheDocument();
    });
  });

  it('shows filter-empty state when filter matches nothing', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} activeFilter="needs_attention" />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-filter-empty')).toBeInTheDocument();
    });
  });

  it('filters by active filter', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} activeFilter="completed" />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    // Should still show the group since it has a completed task
    expect(screen.getAllByTestId('message-group-card')).toHaveLength(1);
  });

  it('filters by search query', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} searchQuery="login" />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('message-group-card')).toHaveLength(1);
  });

  it('hides groups that do not match search', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} searchQuery="nonexistent" />);
    await waitFor(() => {
      expect(screen.getByTestId('tasks-filter-empty')).toBeInTheDocument();
    });
  });

  it('calls onStatsLoaded when stats are fetched', async () => {
    const onStatsLoaded = vi.fn();
    setupFetchMock();
    render(<TaskList {...defaultProps} onStatsLoaded={onStatsLoaded} />);
    await waitFor(() => {
      expect(onStatsLoaded).toHaveBeenCalledWith(mockStats);
    });
  });

  it('expands the first 2 groups by default', async () => {
    const manyGroups = [
      ...mockGroups,
      { ...mockGroups[0], messageId: 'msg-2', originalMessage: 'Second group' },
      { ...mockGroups[0], messageId: 'msg-3', originalMessage: 'Third group' },
    ];
    setupFetchMock(manyGroups);
    render(<TaskList {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    // First 2 should be expanded (have body), third should not
    const bodies = screen.getAllByTestId('message-group-body');
    expect(bodies).toHaveLength(2);
  });

  it('preserves originalMessage in filtered mode', async () => {
    setupFetchMock();
    render(<TaskList {...defaultProps} activeFilter="active" />);
    await waitFor(() => {
      expect(screen.getByTestId('task-feed')).toBeInTheDocument();
    });
    expect(screen.getByTestId('message-group-text')).toHaveTextContent('Fix the login bug then deploy to staging');
  });
});
