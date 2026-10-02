/**
 * Tests for the New ticket form / project ticket editor.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectTicketDialog } from './ProjectTicketDialog';
import * as projectSvc from '../../services/project-tickets.service';
import type { ProjectTicket } from '../../types/project-ticket.types';

vi.mock('../../services/project-tickets.service', () => ({
  createProjectTicket: vi.fn(),
  updateProjectTicket: vi.fn(),
  assignProjectTicket: vi.fn(),
}));

const TICKET: ProjectTicket = {
  id: 'CE-3', title: 'Fix export', status: 'in_progress', priority: 'P1', assignee: null, team: null, labels: ['ui'],
  ownerReview: false, createdAt: '', updatedAt: '', workItemId: 'abcdef1234', requestId: null, source: null, migratedFrom: null,
  fileName: 'CE-3.md', filePath: '', projectPath: '/ce', description: 'd', acceptance: [{ text: 'works', done: true }],
  log: ['claimed by Vera'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectSvc.updateProjectTicket).mockResolvedValue(TICKET);
  vi.mocked(projectSvc.createProjectTicket).mockResolvedValue(TICKET);
});

describe('ProjectTicketDialog', () => {
  it('edits a ticket: allowed status moves, file, run link, log, save', async () => {
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <ProjectTicketDialog open ticket={TICKET} projectId="p1" projects={[]} teams={[]} onClose={() => {}} onSaved={onSaved} />
      </MemoryRouter>,
    );
    expect(screen.getByText('CE-3: Fix export')).toBeInTheDocument();
    expect(screen.getByLabelText('Acceptance criteria')).toHaveValue('[x] works');
    const statuses = Array.from((screen.getByLabelText('Status') as HTMLSelectElement).options).map((o) => o.value);
    expect(statuses).toEqual(['in_progress', 'ready', 'backlog', 'review', 'done', 'cancelled']);
    expect(screen.getByText('CE-3.md')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run abcdef12' })).toHaveAttribute('href', '/tickets/runs/abcdef1234');
    expect(screen.getByText('claimed by Vera')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(projectSvc.updateProjectTicket).toHaveBeenCalledWith('p1', 'CE-3', expect.objectContaining({ status: 'review', labels: ['ui'] })),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('creating in a locked project has no project picker', () => {
    render(
      <MemoryRouter>
        <ProjectTicketDialog open ticket={null} projectId="p1" projects={[{ id: 'p1', name: 'CE' }]} teams={[]} onClose={() => {}} onSaved={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('New ticket')).toBeInTheDocument();
    expect(screen.queryByLabelText('Project')).toBeNull();
  });

  it('shows a server error inline', async () => {
    vi.mocked(projectSvc.createProjectTicket).mockRejectedValue(new Error('Project not found'));
    render(
      <MemoryRouter>
        <ProjectTicketDialog open ticket={null} projects={[{ id: 'p1', name: 'CE' }]} teams={[]} onClose={() => {}} onSaved={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });
});
