/**
 * Tests for the Tickets › Board page (the board itself is tested in
 * components/Tickets/TicketBoard.test.tsx).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Tickets, TicketBoard } from './Tickets';
import * as svc from '../services/tickets.service';
import * as projectSvc from '../services/project-tickets.service';

vi.mock('../services/tickets.service', () => ({
  fetchTickets: vi.fn(),
  fetchTicket: vi.fn(),
  verifyTicket: vi.fn(),
  rejectTicket: vi.fn(),
  dismissTicket: vi.fn(),
  setTicketAcceptance: vi.fn(),
  patchTicket: vi.fn(),
}));
vi.mock('../services/project-tickets.service', () => ({
  listAllProjectTickets: vi.fn(),
  listProjectTickets: vi.fn(),
  createProjectTicket: vi.fn(),
  updateProjectTicket: vi.fn(),
  assignProjectTicket: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(svc.fetchTickets).mockResolvedValue({
    tickets: [
      {
        id: 'a', tkt: 'TKT-001', title: '写周报', kind: 'feature', column: 'to_review', status: 'waiting_confirmation',
        priority: 'normal', priorityLabel: 'P2', origin: null, assignee: null, workItemIds: [], tags: [], createdAt: '', updatedAt: '',
      },
    ],
    columns: {},
  });
  vi.mocked(projectSvc.listAllProjectTickets).mockResolvedValue([]);
});

describe('Tickets page', () => {
  it('renders the board and re-exports it for Projects › Tasks', async () => {
    render(
      <MemoryRouter>
        <Tickets teams={[]} pollIntervalMs={0} showNewTicket={false} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('写周报')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New ticket' })).toBeNull();
    expect(TicketBoard).toBeTypeOf('function');
  });
});
