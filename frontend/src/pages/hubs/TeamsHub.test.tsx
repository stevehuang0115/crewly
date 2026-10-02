/**
 * Teams page (hub): header actions per tab, tab pills from the panels'
 * counts, and the Goals tab in ?tab=goals (old /missions links redirect
 * there, see routes.constants).
 */
import React, { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TeamsHub } from './TeamsHub';
import type { TeamsProps } from '../Teams';
import type { MissionsProps } from '../Missions';

vi.mock('../Teams', () => ({
	Teams: ({ createOpen, onCount }: TeamsProps) => {
		useEffect(() => onCount?.(10), [onCount]);
		return <div>Teams panel {createOpen ? '(creating)' : ''}</div>;
	},
}));
vi.mock('../Missions', () => ({
	Missions: ({ createOpen, refreshKey, onCounts }: MissionsProps) => {
		useEffect(() => onCounts?.({ total: 4, pending: 2 }), [onCounts]);
		return <div>Goals panel {createOpen ? '(creating)' : ''} refresh {refreshKey}</div>;
	},
}));

const Search: React.FC = () => <div data-testid="search">{useLocation().search}</div>;

const renderAt = (url: string) =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<TeamsHub />
			<Search />
		</MemoryRouter>,
	);

describe('TeamsHub', () => {
	it('shows the teams list with New team in the header', () => {
		renderAt('/teams');
		expect(screen.getByRole('heading', { name: 'Teams' })).toBeInTheDocument();
		expect(screen.getByText(/Teams panel/)).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('teams-new'));
		expect(screen.getByText('Teams panel (creating)')).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: /Teams/ })).toHaveTextContent('10');
	});

	it('opens Goals from ?tab=goals with New goal and Refresh', () => {
		renderAt('/teams?tab=goals');
		expect(screen.getByText(/Goals panel/)).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('missions-new'));
		expect(screen.getByText(/Goals panel \(creating\)/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'More goal actions' }));
		fireEvent.click(screen.getByText('Refresh'));
		expect(screen.getByText(/refresh 1/)).toBeInTheDocument();
	});

	it('shows pending proposals on the Goals pill', () => {
		renderAt('/teams?tab=goals');
		expect(screen.getByRole('tab', { name: /Goals/ })).toHaveTextContent('2');
	});

	it('switches tabs through ?tab=', () => {
		renderAt('/teams?tab=goals');
		fireEvent.click(screen.getByRole('tab', { name: /Teams/ }));
		expect(screen.getByText(/Teams panel/)).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent(/^$/);
		fireEvent.click(screen.getByRole('tab', { name: /Goals/ }));
		expect(screen.getByTestId('search')).toHaveTextContent('?tab=goals');
	});
});
