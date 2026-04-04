/**
 * Tests for MessageGroupCard component.
 *
 * @module components/TaskTracking/MessageGroupCard.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { MessageGroupCard } from './MessageGroupCard';
import type { MessageGroup } from './task-tracking.types';

const makeGroup = (overrides: Partial<MessageGroup> = {}): MessageGroup => ({
  messageId: 'msg-1',
  originalMessage: 'Fix the login bug, deploy to staging, and verify email flow',
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
      intent: 'Deploy to staging',
      level: 'L2',
      category: 'deployment',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 2,
      totalTokens: 12000,
      totalCost: 0.36,
      assignedSessions: [],
      order: 1,
    },
  ],
  completedCount: 1,
  totalCount: 2,
  ...overrides,
});

describe('MessageGroupCard', () => {
  it('renders the message text', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    expect(screen.getByTestId('message-group-text')).toHaveTextContent('Fix the login bug');
  });

  it('renders the header as a button with aria-expanded', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    const header = screen.getByTestId('message-group-header');
    expect(header.tagName).toBe('BUTTON');
    expect(header).toHaveAttribute('aria-expanded');
  });

  it('renders progress pill (1 of 2 done)', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    expect(screen.getByTestId('message-group-progress')).toHaveTextContent('1 of 2 done');
  });

  it('renders group state badge', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    const badge = screen.getByTestId('group-state-badge');
    expect(badge).toHaveTextContent('Running');
    expect(badge.classList.contains('group-state-badge--running')).toBe(true);
  });

  it('derives Needs attention state when any task is failed', () => {
    const group = makeGroup({
      tasks: [
        { ...makeGroup().tasks[0], status: 'failed' },
        { ...makeGroup().tasks[1], status: 'completed' },
      ],
    });
    render(<MessageGroupCard group={group} />);
    expect(screen.getByTestId('group-state-badge')).toHaveTextContent('Needs attention');
  });

  it('derives Done state when all tasks are completed', () => {
    const group = makeGroup({
      tasks: [
        { ...makeGroup().tasks[0], status: 'completed' },
        { ...makeGroup().tasks[1], status: 'completed' },
      ],
    });
    render(<MessageGroupCard group={group} />);
    expect(screen.getByTestId('group-state-badge')).toHaveTextContent('Done');
  });

  it('derives Stopped state when all tasks are cancelled', () => {
    const group = makeGroup({
      tasks: [
        { ...makeGroup().tasks[0], status: 'cancelled' },
        { ...makeGroup().tasks[1], status: 'cancelled' },
      ],
    });
    render(<MessageGroupCard group={group} />);
    expect(screen.getByTestId('group-state-badge')).toHaveTextContent('Stopped');
  });

  it('derives Paused state when any task is paused (no failures/running)', () => {
    const group = makeGroup({
      tasks: [
        { ...makeGroup().tasks[0], status: 'classified' },
        { ...makeGroup().tasks[1], status: 'paused' },
      ],
    });
    render(<MessageGroupCard group={group} />);
    expect(screen.getByTestId('group-state-badge')).toHaveTextContent('Paused');
  });

  it('is collapsed by default', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    expect(screen.queryByTestId('message-group-body')).not.toBeInTheDocument();
  });

  it('expands when defaultExpanded is true', () => {
    render(<MessageGroupCard group={makeGroup()} defaultExpanded />);
    expect(screen.getByTestId('message-group-body')).toBeInTheDocument();
    expect(screen.getAllByTestId('task-row')).toHaveLength(2);
  });

  it('toggles expansion on header click', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    expect(screen.queryByTestId('message-group-body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-group-header'));
    expect(screen.getByTestId('message-group-body')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-group-header'));
    expect(screen.queryByTestId('message-group-body')).not.toBeInTheDocument();
  });

  it('preserves originalMessage text (never rebuilds from intents)', () => {
    const group = makeGroup({ originalMessage: 'My original message that should be preserved' });
    render(<MessageGroupCard group={group} />);
    expect(screen.getByTestId('message-group-text')).toHaveTextContent('My original message that should be preserved');
  });

  it('shows task count in meta', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    expect(screen.getByTestId('message-group-header')).toHaveTextContent('2 tasks');
  });

  it('shows pulse dot for Running state', () => {
    render(<MessageGroupCard group={makeGroup()} />);
    const badge = screen.getByTestId('group-state-badge');
    const pulse = badge.querySelector('.group-state-pulse');
    expect(pulse).toBeInTheDocument();
  });

  it('does not show pulse dot for Done state', () => {
    const group = makeGroup({
      tasks: [
        { ...makeGroup().tasks[0], status: 'completed' },
        { ...makeGroup().tasks[1], status: 'completed' },
      ],
    });
    render(<MessageGroupCard group={group} />);
    const badge = screen.getByTestId('group-state-badge');
    const pulse = badge.querySelector('.group-state-pulse');
    expect(pulse).not.toBeInTheDocument();
  });

  it('passes onTaskToggle to child TaskRows', () => {
    const onToggle = vi.fn();
    render(<MessageGroupCard group={makeGroup()} defaultExpanded onTaskToggle={onToggle} />);
    const toggles = screen.getAllByTestId('task-toggle');
    fireEvent.click(toggles[0]);
    expect(onToggle).toHaveBeenCalledWith('task-1');
  });
});
