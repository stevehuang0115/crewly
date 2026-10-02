/**
 * Navigation Component
 *
 * The desktop sidebar: 12 pages in three groups (Work / Tools / System),
 * pinned favourites at the top of Work, badges (Dashboard = waiting on you
 * in the attention colour, Chat = unread, Schedules = active), then Mobile
 * Access, the cloud auth indicator and the collapse toggle. The version and
 * "Update available" chip sit under the wordmark.
 *
 * Phones (< md) do not use this sidebar: `MobileTabBar` shows Dashboard ·
 * Chat · Tickets · More instead (specs/2026-10-02-ui-redesign.md
 * §Navigation).
 *
 * @module components/Layout/Navigation
 */
import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { useSidebar } from '../../contexts/SidebarContext';
import { QRCodeDisplay } from './QRCodeDisplay';
import { UpdateAvailableChip } from '../System/UpdateAvailableChip';
import { AuthStatusIndicator } from '../Auth/AuthStatusIndicator';
import { usePinnedFavorites } from '../../hooks/usePinnedFavorites';
import { useCrewlyVersion } from '../../hooks/useCrewlyVersion';
import { NAV_GROUPS, isNavActive, type NavItem } from './nav-items';
import { NAV_BADGE_LABEL, NavBadge, useNavBadgeCounts } from './NavBadges';
import { PinnedFavoritesSection } from './PinnedFavorites';

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Renders a single navigation link item.
 */
const NavLinkItem: React.FC<{
	item: NavItem;
	isCollapsed: boolean;
	/** Badge count (hidden when null or 0) */
	badgeCount?: number | null;
}> = ({ item, isCollapsed, badgeCount }) => {
	const location = useLocation();
	const isActive = isNavActive(item.href, location.pathname);
	const showLabel = !isCollapsed;

	return (
		<NavLink
			to={item.href}
			end={item.href === '/'}
			className={clsx(
				'group relative flex items-center px-4 py-2 rounded-2xl text-sm transition-colors',
				isCollapsed ? 'justify-center' : '',
				isActive
					? 'bg-primary-soft text-primary-text font-semibold'
					: 'text-text-2 hover:bg-surface-hover hover:text-text'
			)}
			title={!showLabel ? item.name : undefined}
			aria-current={isActive ? 'page' : undefined}
		>
			<item.icon className="h-5 w-5 flex-shrink-0" />
			{showLabel && <span className="ml-3">{item.name}</span>}
			{showLabel && item.badge && !!badgeCount && (
				<NavBadge kind={item.badge} count={badgeCount} testId={`nav-badge-${item.href.replace(/\//g, '') || 'dashboard'}`} />
			)}
			{!showLabel && item.badge && !!badgeCount && (
				<span
					className={clsx('absolute top-1 right-2 h-2 w-2 rounded-full', item.badge === 'waiting' ? 'bg-attention' : 'bg-primary')}
					aria-label={NAV_BADGE_LABEL[item.badge](badgeCount)}
				/>
			)}
		</NavLink>
	);
};

// =============================================================================
// Main Navigation Component
// =============================================================================

/**
 * Desktop sidebar (hidden below md; phones use `MobileTabBar`).
 *
 * Project pages: the Detail / Editor / Tasks / Teams sub-links still show
 * under Projects while a project is open. They move into the project page
 * header as tabs in the Projects page work; remove them here then.
 */
export const Navigation: React.FC = () => {
	const { version, latestVersion, updateAvailable } = useCrewlyVersion();
	const { isCollapsed, toggleSidebar } = useSidebar();
	const { pinnedItems } = usePinnedFavorites();
	const badges = useNavBadgeCounts();

	// Detect when viewing a specific project to show contextual sub-navigation
	const location = useLocation();
	const projectMatch = location.pathname.match(/\/projects\/([^/]+)/);
	const activeProjectId = projectMatch ? projectMatch[1] : null;
	const activeHash = (location.hash || '#detail').replace('#', '') as 'detail' | 'editor' | 'tasks' | 'teams';

	const showLabels = !isCollapsed;

	return (
		<div className="flex flex-col h-screen max-h-screen bg-surface border-r border-border overflow-hidden w-full">
			{/* Logo Section */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border">
				<div className="flex items-center">
					<div className="p-1">
						<img src="/logo/crewly-icon.svg" alt="Crewly" className="h-6 w-6 invert" />
					</div>
					{showLabels && (
						<div className="ml-2.5 leading-none">
							<span className="text-lg font-extrabold text-text font-logo">
								CREWLY
							</span>
							{version && (
								<div
									className="mt-1 text-[10px] text-text-2 tabular-nums"
									title={updateAvailable && latestVersion ? `${latestVersion} is available` : undefined}
								>
									v{version}
								</div>
							)}
							{version && updateAvailable && (
								<UpdateAvailableChip latestVersion={latestVersion} className="mt-1" />
							)}
						</div>
					)}
				</div>
			</div>

			{/* Main Navigation — Grouped */}
			<nav className="flex-1 px-2 py-3 overflow-y-auto" aria-label="Main navigation">
				{NAV_GROUPS.map((group, groupIndex) => (
					<div key={group.label} className={clsx(groupIndex > 0 && 'mt-4')}>
						{/* Group header */}
						{showLabels && (
							<div className="px-4 py-1 mb-1">
								<span
									className="text-[10px] font-semibold text-text-2 uppercase tracking-wider"
									data-testid={`nav-group-${group.label.toLowerCase().replace(/\s+/g, '-')}`}
								>
									{group.label}
								</span>
							</div>
						)}

						{/* Pinned Favorites — shown at the top of Work group */}
						{group.label === 'WORK' && (
							<PinnedFavoritesSection pinnedItems={pinnedItems} isCollapsed={isCollapsed} />
						)}

						{/* Group items */}
						<div className="space-y-0.5">
							{group.items.map((item) => (
								<div key={item.name}>
									<NavLinkItem
										item={item}
										isCollapsed={isCollapsed}
										badgeCount={item.badge ? badges[item.badge] : null}
									/>

									{/* Contextual project sub-nav under Projects (moves to the project header tabs later) */}
									{showLabels && item.href === '/projects' && activeProjectId && (
										<div className="mt-1 ml-4 space-y-0.5 border-l border-border-soft pl-4" data-testid="project-subnav">
											{(['detail', 'editor', 'tasks', 'teams'] as const).map((tab) => (
												<NavLink
													key={tab}
													to={`/projects/${activeProjectId}#${tab}`}
													className={() =>
														clsx(
															'block px-4 py-1.5 text-sm rounded-2xl transition-colors',
															activeHash === tab
																? 'text-primary-text font-medium bg-primary-soft'
																: 'text-text-2 hover:bg-surface-hover hover:text-text'
														)
													}
												>
													{tab.charAt(0).toUpperCase() + tab.slice(1)}
												</NavLink>
											))}
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				))}
			</nav>

			{/* Bottom Section */}
			<div className="p-2 border-t border-border space-y-1">
				{/* Cloud Auth Status */}
				<AuthStatusIndicator isCollapsed={isCollapsed} />

				{/* QR Code for Mobile Access */}
				<QRCodeDisplay isCollapsed={isCollapsed} />

				{/* Collapse/Expand Button */}
				<button
					className="flex items-center justify-center w-full p-2 text-text-2 hover:bg-surface-hover hover:text-text rounded-2xl transition-colors"
					onClick={toggleSidebar}
					aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				>
					{isCollapsed ? (
						<ChevronRight className="h-5 w-5" />
					) : (
						<>
							<ChevronLeft className="h-5 w-5 mr-3" />
							<span className="text-sm">Collapse</span>
						</>
					)}
				</button>
			</div>
		</div>
	);
};
