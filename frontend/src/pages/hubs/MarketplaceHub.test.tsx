/**
 * Marketplace hub: Browse / Installed / Submissions in ?tab=, with the
 * Installed count and pending submissions as tab pills.
 */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceHub } from './MarketplaceHub';

vi.mock('../Marketplace', () => ({
	default: ({ view }: { view: string }) => <div>{view === 'submissions' ? 'Submissions panel' : 'Browse panel'}</div>,
}));
const mockFetchSubmissions = vi.fn();
vi.mock('../../services/marketplace.service', () => ({
	fetchSubmissions: (...args: unknown[]) => mockFetchSubmissions(...args),
}));
vi.mock('../../components/Marketplace/InstalledSkills', () => ({
	InstalledSkills: ({ onCountChange }: { onCountChange?: (n: number) => void }) => {
		useEffect(() => onCountChange?.(123), [onCountChange]);
		return <div>Installed panel</div>;
	},
}));

const Search: React.FC = () => <div data-testid="search">{useLocation().search}</div>;

function renderAt(url: string) {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<MarketplaceHub />
			<Search />
		</MemoryRouter>,
	);
}

describe('MarketplaceHub', () => {
	beforeEach(() => {
		mockFetchSubmissions.mockReset();
		mockFetchSubmissions.mockResolvedValue([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
	});

	it('shows Installed (former Settings › Skills) from ?tab=installed, with its count', () => {
		renderAt('/marketplace?tab=installed');
		expect(screen.getByText('Installed panel')).toBeInTheDocument();
		expect(screen.getByTestId('tab-count-installed')).toHaveTextContent('123');
		fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
		expect(screen.getByText('Browse panel')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent(/^$/);
	});

	it('shows the pending-review count before Submissions is opened, then opens it', async () => {
		renderAt('/marketplace');
		expect(await screen.findByTestId('tab-count-submissions')).toHaveTextContent('2');
		expect(mockFetchSubmissions).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('tab', { name: /Submissions/ }));
		expect(screen.getByText('Submissions panel')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent('?tab=submissions');
	});

	it('shows no pill when nothing is pending or the count cannot be read', async () => {
		mockFetchSubmissions.mockRejectedValue(new Error('offline'));
		renderAt('/marketplace');
		await waitFor(() => expect(mockFetchSubmissions).toHaveBeenCalled());
		expect(screen.queryByTestId('tab-count-submissions')).not.toBeInTheDocument();
	});

	it('falls back to Browse for an unknown tab', () => {
		renderAt('/marketplace?tab=nope');
		expect(screen.getByText('Browse panel')).toBeInTheDocument();
	});
});
