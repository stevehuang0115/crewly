/**
 * TeamAssignmentModal tests — choose which teams work on a project.
 *
 * @module components/Modals/TeamAssignmentModal.test
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamAssignmentModal } from './TeamAssignmentModal';
import { apiService } from '@/services/api.service';
import type { Project, Team } from '@/types';

vi.mock('@/services/api.service', () => ({
  apiService: {
    getTeams: vi.fn(),
    assignTeamsToProject: vi.fn(),
  },
}));

const project: Project = {
  id: 'p1',
  name: 'Website',
  path: '/w',
  teams: {},
  status: 'active',
  createdAt: '',
  updatedAt: '',
};

const teams: Team[] = [
  { id: 't1', name: 'Alpha', members: [], projectIds: ['p1'], createdAt: '', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 't2', name: 'Beta', members: [], projectIds: [], createdAt: '', updatedAt: '2026-01-01T00:00:00Z' },
];

describe('TeamAssignmentModal', () => {
  beforeEach(() => {
    vi.mocked(apiService.getTeams).mockResolvedValue(teams);
    vi.mocked(apiService.assignTeamsToProject).mockResolvedValue(undefined);
  });

  it('pre-selects teams already assigned to the project', async () => {
    render(<TeamAssignmentModal project={project} onClose={vi.fn()} onAssignmentComplete={vi.fn()} />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Alpha/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: /Beta/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Currently assigned to this project')).toBeInTheDocument();
  });

  it('toggles a team and saves the selection', async () => {
    const onClose = vi.fn();
    const onAssignmentComplete = vi.fn();
    render(<TeamAssignmentModal project={project} onClose={onClose} onAssignmentComplete={onAssignmentComplete} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Beta/ }));
    fireEvent.click(screen.getByRole('button', { name: /Assign 2 Teams/ }));
    await waitFor(() => expect(apiService.assignTeamsToProject).toHaveBeenCalledWith('p1', ['t1', 't2']));
    expect(onAssignmentComplete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an empty state when there are no teams', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue([]);
    render(<TeamAssignmentModal project={project} onClose={vi.fn()} onAssignmentComplete={vi.fn()} />);
    expect(await screen.findByText('No Teams Available')).toBeInTheDocument();
  });

  it('shows a retry when loading fails', async () => {
    vi.mocked(apiService.getTeams).mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<TeamAssignmentModal project={project} onClose={vi.fn()} onAssignmentComplete={vi.fn()} />);
    expect(await screen.findByText('Error: Failed to load teams')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
