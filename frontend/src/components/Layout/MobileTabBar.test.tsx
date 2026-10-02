import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';
import { NavBadgesProvider } from './NavBadges';

vi.mock('./QRCodeDisplay', () => ({ QRCodeDisplay: () => <button type="button">Mobile Access</button> }));
vi.mock('../Auth/AuthStatusIndicator', () => ({ AuthStatusIndicator: () => <div data-testid="auth-status">Signed in</div> }));
vi.mock('../../hooks/useCrewlyVersion', () => ({
	useCrewlyVersion: () => ({ version: '1.20.190', latestVersion: '1.21.0', updateAvailable: true }),
}));
const pinned: Array<{ id: string; name: string; type: 'project' | 'team' }> = [];
vi.mock('../../hooks/usePinnedFavorites', () => ({ usePinnedFavorites: () => ({ pinnedItems: pinned }) }));
let waiting: number | null = 16;
vi.mock('../../hooks/useWaitingOnYouCount', () => ({ useWaitingOnYouCount: () => waiting }));
vi.mock('../../hooks/useChatUnreadCount', () => ({ useChatUnreadCount: () => 3 }));
vi.mock('../../hooks/useScheduleCount', () => ({ useScheduleCount: () => 22 }));

const Where: React.FC = () => <div data-testid="where">{useLocation().pathname}</div>;

function renderAt(url = '/') {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<NavBadgesProvider>
				<Routes>
					<Route path="*" element={<><MobileTabBar /><Where /></>} />
				</Routes>
			</NavBadgesProvider>
		</MemoryRouter>,
	);
}

describe('MobileTabBar', () => {
	beforeEach(() => {
		pinned.length = 0;
		waiting = 16;
	});

	it('shows Dashboard · Chat · Tickets · More, phone only', () => {
		renderAt();
		const bar = screen.getByTestId('mobile-tab-bar');
		expect(bar.className).toContain('md:hidden');
		expect(within(bar).getAllByRole('link').map((a) => [a.textContent?.replace(/\d+$/, ''), a.getAttribute('href')])).toEqual([
			['Dashboard', '/'],
			['Chat', '/team-chat'],
			['Tickets', '/tickets'],
		]);
		expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
		expect(screen.getByTestId('mobile-tab-dashboard')).toHaveAttribute('aria-current', 'page');
	});

	it('badges Dashboard (attention) and Chat (unread)', () => {
		renderAt();
		const d = screen.getByLabelText('16 waiting on you');
		expect(d.className).toContain('bg-attention');
		expect(screen.getByLabelText('3 unread').className).toContain('bg-primary');
	});

	it('More opens a sheet with every other page, Mobile Access, sign-in state and version', () => {
		pinned.push({ id: 'p1', name: 'Pricing site', type: 'project' });
		renderAt();
		fireEvent.click(screen.getByTestId('mobile-tab-more'));
		const sheet = screen.getByRole('dialog', { name: 'More' });
		const names = within(sheet).getAllByRole('link').map((a) => a.getAttribute('href'));
		expect(names).toEqual(expect.arrayContaining(['/projects', '/teams', '/wiki', '/triggers', '/browser', '/marketplace', '/connections', '/usage', '/settings', '/projects/p1']));
		expect(within(sheet).getByRole('button', { name: 'Mobile Access' })).toBeInTheDocument();
		expect(within(sheet).getByTestId('auth-status')).toBeInTheDocument();
		expect(within(sheet).getByText('v1.20.190')).toBeInTheDocument();
		expect(within(sheet).getByTestId('update-available-chip')).toBeInTheDocument();
		expect(within(sheet).getByLabelText('22 active')).toBeInTheDocument();
	});

	it('closes the sheet on navigation, the close button and Escape', () => {
		renderAt();
		fireEvent.click(screen.getByTestId('mobile-tab-more'));
		fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Teams/ }));
		expect(screen.getByTestId('where')).toHaveTextContent('/teams');
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('mobile-tab-more'));
		fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('mobile-tab-more'));
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('highlights More when the current page is not a tab', () => {
		renderAt('/settings');
		expect(screen.getByTestId('mobile-tab-more').className).toContain('text-primary-text');
	});
});
