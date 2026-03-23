/**
 * Tests for CronJobPanel component
 *
 * @module components/Settings/CronJobPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CronJobPanel } from './CronJobPanel';
import { useCronTasks } from '../../hooks/useCronTasks';
import type { CronTask } from '../../types/cron-task.types';

vi.mock('../../hooks/useCronTasks', () => ({
  useCronTasks: vi.fn(),
}));

const mockTask: CronTask = {
  id: 'cron-0001',
  cronExpression: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  targetAgent: 'crewly-product-sam-217bfbbf',
  targetTeamId: 'team-001',
  taskDescription: 'Daily standup reminder',
  createdBy: 'user',
  createdAt: '2026-03-23T00:00:00.000Z',
  enabled: true,
  lastRunAt: '2026-03-23T01:00:00.000Z',
  nextRunAt: '2026-03-24T01:00:00.000Z',
};

const mockDisabledTask: CronTask = {
  ...mockTask,
  id: 'cron-0002',
  taskDescription: 'Weekly report',
  enabled: false,
  lastRunAt: null,
  nextRunAt: null,
};

const mockRefresh = vi.fn();
const mockUpdateTask = vi.fn();
const mockDeleteTask = vi.fn();
const mockCreateTask = vi.fn();

const defaultHookReturn = {
  tasks: [mockTask, mockDisabledTask],
  isLoading: false,
  error: null,
  refresh: mockRefresh,
  createTask: mockCreateTask,
  updateTask: mockUpdateTask,
  deleteTask: mockDeleteTask,
};

describe('CronJobPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCronTasks).mockReturnValue(defaultHookReturn);
  });

  it('should render loading state', () => {
    vi.mocked(useCronTasks).mockReturnValue({ ...defaultHookReturn, tasks: [], isLoading: true });
    render(<CronJobPanel />);
    expect(screen.getByText('Loading cron jobs...')).toBeInTheDocument();
  });

  it('should render error state', () => {
    vi.mocked(useCronTasks).mockReturnValue({ ...defaultHookReturn, tasks: [], error: 'Server error' });
    render(<CronJobPanel />);
    expect(screen.getByText('Server error')).toBeInTheDocument();
  });

  it('should render empty state', () => {
    vi.mocked(useCronTasks).mockReturnValue({ ...defaultHookReturn, tasks: [] });
    render(<CronJobPanel />);
    expect(screen.getByText('No cron jobs configured')).toBeInTheDocument();
  });

  it('should render task list with correct count', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('should display task description and target agent', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Daily standup reminder')).toBeInTheDocument();
    expect(screen.getByText('crewly-product-sam-217bfbbf')).toBeInTheDocument();
  });

  it('should display cron expression', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('0 9 * * *')).toBeInTheDocument();
  });

  it('should display timezone', () => {
    render(<CronJobPanel />);
    expect(screen.getAllByText('Asia/Shanghai')).toHaveLength(2);
  });

  it('should show Active badge for enabled tasks', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('should show Disabled badge for disabled tasks', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('should call updateTask when toggle is clicked', async () => {
    render(<CronJobPanel />);
    const disableButton = screen.getByLabelText('Disable cron task');
    fireEvent.click(disableButton);

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith('cron-0001', { enabled: false });
    });
  });

  it('should call updateTask to enable when toggle is clicked on disabled task', async () => {
    render(<CronJobPanel />);
    const enableButton = screen.getByLabelText('Enable cron task');
    fireEvent.click(enableButton);

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith('cron-0002', { enabled: true });
    });
  });

  it('should call deleteTask when delete is clicked', async () => {
    render(<CronJobPanel />);
    const deleteButtons = screen.getAllByLabelText('Delete cron task');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('cron-0001');
    });
  });

  it('should call refresh when Refresh button is clicked', () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Refresh'));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('should render table headers', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Task')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByText('Last Run')).toBeInTheDocument();
    expect(screen.getByText('Next Run')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });
});
