/**
 * The interim tab containers: every old page stays reachable under its new
 * tab, and the tab lives in ?tab=.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TicketsHub } from './TicketsHub';
import { TeamsHub } from './TeamsHub';
import { MarketplaceHub } from './MarketplaceHub';

vi.mock('../Tickets', () => ({ Tickets: () => <div>Old board</div> }));
vi.mock('../RequestsPage', () => ({ RequestsPage: () => <div>Old requests</div> }));
vi.mock('../WorkItems', () => ({ WorkItems: () => <div>Old work items</div> }));
vi.mock('../Teams', () => ({ Teams: () => <div>Old teams</div> }));
vi.mock('../Missions', () => ({ Missions: () => <div>Old missions</div> }));
vi.mock('../Marketplace', () => ({ default: () => <div>Old marketplace</div> }));
vi.mock('../../components/Settings/SkillsTab', () => ({ SkillsTab: () => <div>Old skills tab</div> }));

const Search: React.FC = () => <div data-testid="search">{useLocation().search}</div>;

function renderAt(el: React.ReactElement, url: string) {
	return render(
		<MemoryRouter initialEntries={[url]}>
			{el}
			<Search />
		</MemoryRouter>,
	);
}

describe('TicketsHub', () => {
	it('shows Board / Requests / Runs and switches via ?tab=', () => {
		renderAt(<TicketsHub />, '/tickets');
		expect(screen.getByRole('heading', { name: 'Tickets' })).toBeInTheDocument();
		expect(screen.getByText('Old board')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
		expect(screen.getByText('Old requests')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent('?tab=requests');
		fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
		expect(screen.getByText('Old work items')).toBeInTheDocument();
	});
});

describe('TeamsHub', () => {
	it('opens Goals from ?tab=goals', () => {
		renderAt(<TeamsHub />, '/teams?tab=goals');
		expect(screen.getByText('Old missions')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: 'Teams' }));
		expect(screen.getByText('Old teams')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent(/^$/);
	});
});

describe('MarketplaceHub', () => {
	it('shows Installed (former Settings › Skills) from ?tab=installed', () => {
		renderAt(<MarketplaceHub />, '/marketplace?tab=installed');
		expect(screen.getByText('Old skills tab')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
		expect(screen.getByText('Old marketplace')).toBeInTheDocument();
	});
});
