/**
 * Tests for TaskRow component — V3
 *
 * @module components/TaskTracking/TaskRow.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { TaskRow } from './TaskRow';
import type { IntentTaskSummary } from './task-tracking.types';

const baseTask: IntentTaskSummary = {
  id: 'task-1',
  messageId: 'msg-1',
  intent: 'Fix the login bug in auth service',
  level: 'L1',
  category: 'debugging',
  status: 'in_progress',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  runCount: 2,
  totalTokens: 15000,
  totalCost: 0.45,
  assignedSessions: ['crewly-orc', 'dev-max'],
  order: 0,
};

describe('TaskRow', () => {
  it('renders the task intent', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-intent')).toHaveTextContent('Fix the login bug');
  });

  it('renders user-facing status label (Running)', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-status')).toHaveTextContent('Running');
  });

  it('renders Ready for classified status', () => {
    render(<TaskRow task={{ ...baseTask, status: 'classified' }} />);
    expect(screen.getByTestId('task-status')).toHaveTextContent('Ready');
  });

  it('renders Done for completed status', () => {
    render(<TaskRow task={{ ...baseTask, status: 'completed' }} />);
    expect(screen.getByTestId('task-status')).toHaveTextContent('Done');
  });

  it('renders Needs attention for failed status', () => {
    render(<TaskRow task={{ ...baseTask, status: 'failed' }} />);
    expect(screen.getByTestId('task-status')).toHaveTextContent('Needs attention');
  });

  it('renders Stopped for cancelled status', () => {
    render(<TaskRow task={{ ...baseTask, status: 'cancelled' }} />);
    expect(screen.getByTestId('task-status')).toHaveTextContent('Stopped');
  });

  it('renders status icon (not a checkbox)', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-status-icon')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders check circle icon for completed tasks', () => {
    render(<TaskRow task={{ ...baseTask, status: 'completed' }} />);
    const icon = screen.getByTestId('task-status-icon');
    expect(icon.querySelector('.task-row-check-icon')).toBeInTheDocument();
  });

  it('renders dot icon for non-completed tasks', () => {
    render(<TaskRow task={baseTask} />);
    const icon = screen.getByTestId('task-status-icon');
    expect(icon.querySelector('.task-row-status-dot')).toBeInTheDocument();
  });

  it('renders the level badge', () => {
    render(<TaskRow task={baseTask} />);
    const level = screen.getByTestId('task-level');
    expect(level).toHaveTextContent('L1');
    expect(level).toHaveTextContent('Standard');
  });

  it('renders L0 Quick level', () => {
    render(<TaskRow task={{ ...baseTask, level: 'L0' }} />);
    const level = screen.getByTestId('task-level');
    expect(level).toHaveTextContent('L0');
    expect(level).toHaveTextContent('Quick');
  });

  it('renders L2 Complex level', () => {
    render(<TaskRow task={{ ...baseTask, level: 'L2' }} />);
    const level = screen.getByTestId('task-level');
    expect(level).toHaveTextContent('L2');
    expect(level).toHaveTextContent('Complex');
  });

  it('renders 2-tier layout with bottom row', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-row-bottom')).toBeInTheDocument();
  });

  it('renders category in bottom row', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-category')).toHaveTextContent('debugging');
  });

  it('renders agent count', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-agents')).toHaveTextContent('2 agents');
  });

  it('hides agents when none assigned', () => {
    render(<TaskRow task={{ ...baseTask, assignedSessions: [] }} />);
    expect(screen.queryByTestId('task-agents')).not.toBeInTheDocument();
  });

  it('renders updated time', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-time')).toBeInTheDocument();
  });

  it('hides tokens/cost/runs by default', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.queryByTestId('task-tokens')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-cost')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-runs')).not.toBeInTheDocument();
  });

  it('shows Details toggle when task has usage data', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.getByTestId('task-details-toggle')).toBeInTheDocument();
  });

  it('expands details on toggle click', () => {
    render(<TaskRow task={baseTask} />);
    fireEvent.click(screen.getByTestId('task-details-toggle'));
    expect(screen.getByTestId('task-details')).toBeInTheDocument();
    expect(screen.getByTestId('task-tokens')).toHaveTextContent('15.0K');
    expect(screen.getByTestId('task-cost')).toHaveTextContent('$0.45');
    expect(screen.getByTestId('task-runs')).toHaveTextContent('2');
  });

  it('hides Details toggle when no usage data', () => {
    const task = { ...baseTask, totalTokens: 0, totalCost: 0, runCount: 0 };
    render(<TaskRow task={task} />);
    expect(screen.queryByTestId('task-details-toggle')).not.toBeInTheDocument();
  });

  it('applies done styling to completed rows', () => {
    render(<TaskRow task={{ ...baseTask, status: 'completed' }} />);
    const row = screen.getByTestId('task-row');
    expect(row.classList.contains('task-row-v3--done')).toBe(true);
  });

  it('applies done styling to intent text', () => {
    render(<TaskRow task={{ ...baseTask, status: 'completed' }} />);
    const intent = screen.getByTestId('task-intent');
    expect(intent.classList.contains('task-row-intent--done')).toBe(true);
  });

  it('calls onToggle when status icon is clicked', () => {
    const onToggle = vi.fn();
    render(<TaskRow task={baseTask} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('task-toggle'));
    expect(onToggle).toHaveBeenCalledWith('task-1');
  });

  it('does not throw if onToggle is not provided', () => {
    render(<TaskRow task={baseTask} />);
    expect(() => fireEvent.click(screen.getByTestId('task-toggle'))).not.toThrow();
  });

  it('shows schedule indicator when scheduleId is present', () => {
    render(<TaskRow task={{ ...baseTask, scheduleId: 'sched-123' }} />);
    expect(screen.getByTestId('task-schedule')).toBeInTheDocument();
  });

  it('hides schedule indicator when no scheduleId', () => {
    render(<TaskRow task={baseTask} />);
    expect(screen.queryByTestId('task-schedule')).not.toBeInTheDocument();
  });
});
