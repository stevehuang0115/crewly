/**
 * Tests for the header's New ticket button.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NewTicketButton } from './NewTicketButton';
import * as projectSvc from '../../services/project-tickets.service';

vi.mock('../../services/api.service', () => ({
  apiService: {
    getProjects: vi.fn().mockResolvedValue([{ id: 'p1', name: 'CE' }, { id: 'p2', name: 'Flopost' }]),
    getTeams: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../../services/project-tickets.service', () => ({
  createProjectTicket: vi.fn().mockResolvedValue({}),
  updateProjectTicket: vi.fn(),
  assignProjectTicket: vi.fn(),
}));

describe('NewTicketButton', () => {
  it('loads projects when opened, preselects the first and creates the ticket', async () => {
    const onCreated = vi.fn();
    render(
      <MemoryRouter>
        <NewTicketButton onCreated={onCreated} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('p1'));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Add CSV export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(projectSvc.createProjectTicket).toHaveBeenCalledWith('p1', expect.objectContaining({ title: 'Add CSV export' })));
    expect(onCreated).toHaveBeenCalled();
  });
});
