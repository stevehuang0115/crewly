/**
 * Marketplace hub: Browse / Installed / Submissions in ?tab=, with the
 * Installed count and pending submissions as tab pills.
 */
import React, { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceHub } from './MarketplaceHub';

vi.mock('../Marketplace', () => ({
	default: ({ view, onPendingCount }: { view: string; onPendingCount?: (n: number) => void }) => {
		useEffect(() => onPendingCount?.(2), [onPendingCount]);
		return <div>{view === 'submissions' ? 'Submissions panel' : 'Browse panel'}</div>;
	},
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
	it('shows Installed (former Settings › Skills) from ?tab=installed, with its count', () => {
		renderAt('/marketplace?tab=installed');
		expect(screen.getByText('Installed panel')).toBeInTheDocument();
		expect(screen.getByTestId('tab-count-installed')).toHaveTextContent('123');
		fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
		expect(screen.getByText('Browse panel')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent(/^$/);
	});

	it('opens Submissions from its tab and flags pending reviews', () => {
		renderAt('/marketplace');
		fireEvent.click(screen.getByRole('tab', { name: /Submissions/ }));
		expect(screen.getByText('Submissions panel')).toBeInTheDocument();
		expect(screen.getByTestId('search')).toHaveTextContent('?tab=submissions');
		expect(screen.getByTestId('tab-count-submissions')).toHaveTextContent('2');
	});

	it('falls back to Browse for an unknown tab', () => {
		renderAt('/marketplace?tab=nope');
		expect(screen.getByText('Browse panel')).toBeInTheDocument();
	});
});
