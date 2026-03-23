/**
 * Tests for CronJobPanel component
 *
 * Covers: loading/error/empty states, task display, human-readable schedule,
 * toggle/delete actions, delete confirmation, create modal, summary stats,
 * responsive layout, and cronToHuman utility.
 *
 * @module components/Settings/CronJobPanel.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CronJobPanel, cronToHuman } from './CronJobPanel';
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
  cronExpression: '0 0 * * MON',
  targetAgent: 'crewly-product-leo-member-n',
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

  // ========================= States =========================

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

  it('should render empty state with create button', () => {
    vi.mocked(useCronTasks).mockReturnValue({ ...defaultHookReturn, tasks: [] });
    render(<CronJobPanel />);
    expect(screen.getByText('No cron jobs configured')).toBeInTheDocument();
    expect(screen.getByText('Create Cron Job')).toBeInTheDocument();
  });

  // ========================= Task Display =========================

  it('should render task list with correct count', () => {
    render(<CronJobPanel />);
    expect(screen.getByText('Cron Jobs')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('should display task description and target agent', () => {
    render(<CronJobPanel />);
    // Both mobile card and desktop table render the same text — use getAllBy
    expect(screen.getAllByText('Daily standup reminder').length).toBeGreaterThan(0);
    expect(screen.getAllByText('crewly-product-sam-217bfbbf').length).toBeGreaterThan(0);
  });

  it('should display human-readable schedule alongside cron expression', () => {
    render(<CronJobPanel />);
    // Human-readable
    expect(screen.getAllByText('Daily at 09:00').length).toBeGreaterThan(0);
    // Raw cron expression still shown
    expect(screen.getAllByText('0 9 * * *').length).toBeGreaterThan(0);
  });

  it('should display timezone', () => {
    render(<CronJobPanel />);
    expect(screen.getAllByText('Asia/Shanghai').length).toBeGreaterThan(0);
  });

  it('should show Active badge for enabled tasks', () => {
    render(<CronJobPanel />);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });

  it('should show Disabled badge for disabled tasks', () => {
    render(<CronJobPanel />);
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0);
  });

  // ========================= Summary Stats =========================

  it('should show summary stats when tasks exist', () => {
    render(<CronJobPanel />);
    expect(screen.getByText(/active of/)).toBeInTheDocument();
  });

  it('should not show summary stats when no tasks', () => {
    vi.mocked(useCronTasks).mockReturnValue({ ...defaultHookReturn, tasks: [] });
    render(<CronJobPanel />);
    expect(screen.queryByText(/active of/)).not.toBeInTheDocument();
  });

  // ========================= Actions =========================

  it('should call updateTask when toggle is clicked', async () => {
    render(<CronJobPanel />);
    const disableButton = screen.getAllByLabelText('Disable cron task')[0];
    fireEvent.click(disableButton);

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith('cron-0001', { enabled: false });
    });
  });

  it('should call updateTask to enable when toggle is clicked on disabled task', async () => {
    render(<CronJobPanel />);
    const enableButton = screen.getAllByLabelText('Enable cron task')[0];
    fireEvent.click(enableButton);

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith('cron-0002', { enabled: true });
    });
  });

  it('should call refresh when Refresh button is clicked', () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Refresh'));
    expect(mockRefresh).toHaveBeenCalled();
  });

  // ========================= Delete Confirmation =========================

  it('should show delete confirmation modal when delete is clicked', () => {
    render(<CronJobPanel />);
    const deleteButtons = screen.getAllByLabelText('Delete cron task');
    fireEvent.click(deleteButtons[0]);

    expect(screen.getByText('Delete Cron Job')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure/)).toBeInTheDocument();
    // Task details shown in confirmation dialog — multiple instances due to responsive layout
    expect(screen.getAllByText(/Daily at 09:00/).length).toBeGreaterThan(0);
  });

  it('should call deleteTask when delete is confirmed', async () => {
    render(<CronJobPanel />);
    const deleteButtons = screen.getAllByLabelText('Delete cron task');
    fireEvent.click(deleteButtons[0]);

    // Click confirm in modal
    const modal = screen.getByRole('dialog');
    const confirmButton = within(modal).getByText('Delete');
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('cron-0001');
    });
  });

  it('should close delete modal when cancel is clicked', () => {
    render(<CronJobPanel />);
    const deleteButtons = screen.getAllByLabelText('Delete cron task');
    fireEvent.click(deleteButtons[0]);

    expect(screen.getByText('Delete Cron Job')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText(/Are you sure/)).not.toBeInTheDocument();
  });

  // ========================= Create Modal =========================

  it('should open create modal when Create button is clicked', () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Create'));

    expect(screen.getByText('Create Cron Job')).toBeInTheDocument();
    expect(screen.getByLabelText('Task Description')).toBeInTheDocument();
  });

  it('should show preset schedule options by default in create modal', () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Create'));

    expect(screen.getByText('Presets')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('should switch to custom cron input', () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Create'));
    fireEvent.click(screen.getByText('Custom'));

    expect(screen.getByPlaceholderText('e.g., 0 9 * * 1-5')).toBeInTheDocument();
  });

  it('should show validation error when target agent is empty', async () => {
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Create'));

    // Fill description but leave target agent empty
    fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'New task' } });

    // Submit form
    const form = screen.getByLabelText('Task Description').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('Target agent is required')).toBeInTheDocument();
    });
  });

  it('should call createTask with form data on submit', async () => {
    mockCreateTask.mockResolvedValue({ id: 'cron-new' });
    render(<CronJobPanel />);
    fireEvent.click(screen.getByText('Create'));

    // Fill in the form
    fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'New task' } });
    fireEvent.change(screen.getByLabelText('Target Agent'), { target: { value: 'my-agent' } });

    // Submit
    const form = screen.getByLabelText('Task Description').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
        taskDescription: 'New task',
        targetAgent: 'my-agent',
        cronExpression: '0 9 * * *',
        createdBy: 'user',
      }));
    });
  });

  // ========================= Table Headers =========================

  it('should render table headers on desktop', () => {
    render(<CronJobPanel />);
    // Table headers — use getAllBy since "Timezone" also appears in card details
    expect(screen.getAllByText('Task').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Schedule').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Timezone').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Last Run').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Next Run').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Status').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Actions').length).toBeGreaterThan(0);
  });
});

// ========================= cronToHuman Utility Tests =========================

describe('cronToHuman', () => {
  it('should parse every minute', () => {
    expect(cronToHuman('* * * * *')).toBe('Every minute');
  });

  it('should parse every N minutes', () => {
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
  });

  it('should parse every N hours', () => {
    expect(cronToHuman('0 */6 * * *')).toBe('Every 6 hours');
    expect(cronToHuman('0 */1 * * *')).toBe('Every hour');
  });

  it('should parse hourly', () => {
    expect(cronToHuman('0 * * * *')).toBe('Every hour');
  });

  it('should parse hourly at specific minute', () => {
    expect(cronToHuman('30 * * * *')).toBe('Every hour at :30');
  });

  it('should parse daily at specific time', () => {
    expect(cronToHuman('0 9 * * *')).toBe('Daily at 09:00');
    expect(cronToHuman('30 14 * * *')).toBe('Daily at 14:30');
    expect(cronToHuman('0 0 * * *')).toBe('Daily at 00:00');
  });

  it('should parse weekdays', () => {
    expect(cronToHuman('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(cronToHuman('0 9 * * MON-FRI')).toBe('Weekdays at 09:00');
  });

  it('should parse specific day of week', () => {
    expect(cronToHuman('0 9 * * 1')).toBe('Every Mon at 09:00');
    expect(cronToHuman('0 9 * * MON')).toBe('Every Mon at 09:00');
  });

  it('should parse monthly', () => {
    expect(cronToHuman('0 0 1 * *')).toBe('Monthly on the 1st at 00:00');
    expect(cronToHuman('0 9 15 * *')).toBe('Monthly on the 15th at 09:00');
  });

  it('should fall back to raw expression for complex patterns', () => {
    expect(cronToHuman('0 9 1,15 * *')).toBe('0 9 1,15 * *');
  });

  it('should handle invalid expressions gracefully', () => {
    expect(cronToHuman('invalid')).toBe('invalid');
    expect(cronToHuman('')).toBe('');
  });
});
