import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectTasksTab, toTaskFlowItems } from './ProjectTasksTab';
import type { Project } from '../../types';

const getInProgressTasks = vi.fn();
let failNext = false;
vi.mock('../../services/in-progress-tasks.service', () => ({
  inProgressTasksService: {
    getInProgressTasks: () => {
      if (failNext) return new Promise((_, reject) => setTimeout(() => reject(new Error('service down')), 0));
      return getInProgressTasks();
    },
  },
}));
vi.mock('../Tickets/TicketBoard', () => ({
  TicketBoard: ({ projectId, onCountsChange }: { projectId: string; onCountsChange?: (c: { total: number; toReview: number }) => void }) => (
    <button type="button" onClick={() => onCountsChange?.({ total: 3, toReview: 1 })}>board {projectId}</button>
  ),
}));
vi.mock('../Hierarchy', () => ({
  TaskFlowView: ({ tasks }: { tasks: unknown[] }) => <div data-testid="task-flow">{tasks.length} flows</div>,
}));

const project = { id: 'p1', name: 'CE', path: '/x', teams: {}, status: 'active', createdAt: '', updatedAt: '' } as Project;

describe('ProjectTasksTab (shared board, filtered to the project)', () => {
  beforeEach(() => {
    getInProgressTasks.mockReset();
    failNext = false;
  });

  it('renders the shared board for this project and passes the total through', () => {
    getInProgressTasks.mockResolvedValue([]);
    const onCountChange = vi.fn();
    render(<ProjectTasksTab project={project} teams={[]} onCountChange={onCountChange} />);
    fireEvent.click(screen.getByText('board p1'));
    expect(onCountChange).toHaveBeenCalledWith(3);
  });

  it('shows the Task Flow collapsed when tasks are in flight', async () => {
    getInProgressTasks.mockResolvedValue([{ id: 't1', taskPath: 'a/b/do-it.md' }]);
    render(<ProjectTasksTab project={project} teams={[]} />);
    const toggle = await screen.findByRole('button', { name: /Task Flow \(1 active\)/ });
    expect(screen.queryByTestId('task-flow')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId('task-flow')).toHaveTextContent('1 flows');
  });

  it('hides the Task Flow when the service fails', async () => {
    failNext = true;
    render(<ProjectTasksTab project={project} teams={[]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('board p1')).toBeInTheDocument();
    expect(screen.queryByText(/Task Flow/)).not.toBeInTheDocument();
  });

  it('maps in-progress tasks to flow items', () => {
    const [item] = toTaskFlowItems([{ id: 't', taskPath: 'x/y/write-docs.md', assignedMemberId: 'm' }]);
    expect(item).toMatchObject({ id: 't', taskName: 'write-docs', status: 'assigned', assignedTeamMemberId: 'm', assignedAt: '' });
  });
});
