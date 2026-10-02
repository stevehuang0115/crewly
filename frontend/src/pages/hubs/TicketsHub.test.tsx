/**
 * Tests for the Tickets hub: tabs, the review count on Board, New ticket.
 */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TicketsHub } from './TicketsHub';
import type { TicketBoardProps } from '../../components/Tickets/TicketBoard';

vi.mock('../Tickets', () => ({
	Tickets: ({ onCountsChange, refreshKey, showNewTicket }: TicketBoardProps) => {
		useEffect(() => onCountsChange?.({ toReview: 3, total: 9 }), [onCountsChange]);
		return <div>Board refresh {refreshKey} new {String(showNewTicket)}</div>;
	},
}));
vi.mock('../RequestsPage', () => ({ RequestsPage: () => <div>Requests tab</div> }));
vi.mock('../WorkItems', () => ({ WorkItems: () => <div>Runs tab</div> }));
vi.mock('../../services/api.service', () => ({
	apiService: {
		getProjects: vi.fn().mockResolvedValue([{ id: 'p1', name: 'CE' }]),
		getTeams: vi.fn().mockResolvedValue([]),
	},
}));
vi.mock('../../services/project-tickets.service', () => ({
	createProjectTicket: vi.fn().mockResolvedValue({}),
	updateProjectTicket: vi.fn(),
	assignProjectTicket: vi.fn(),
}));

describe('TicketsHub', () => {
	it('shows the review count on Board and keeps New ticket in the header', async () => {
		render(
			<MemoryRouter initialEntries={['/tickets']}>
				<TicketsHub />
			</MemoryRouter>,
		);
		expect(await screen.findByRole('tab', { name: /Board\s*3/ })).toBeInTheDocument();
		expect(screen.getByText('Board refresh 0 new false')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('tickets-new-ticket'));
		expect(await screen.findByRole('option', { name: 'CE' })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Ship it' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
		// Creating refreshes the board.
		await waitFor(() => expect(screen.getByText('Board refresh 1 new false')).toBeInTheDocument());
	});

	it('keeps New ticket on the Requests and Runs tabs', () => {
		render(
			<MemoryRouter initialEntries={['/tickets?tab=runs']}>
				<TicketsHub />
			</MemoryRouter>,
		);
		expect(screen.getByText('Runs tab')).toBeInTheDocument();
		expect(screen.getByTestId('tickets-new-ticket')).toBeInTheDocument();
	});
});
