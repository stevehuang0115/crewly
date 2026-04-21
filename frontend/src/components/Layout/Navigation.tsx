/**
 * Navigation Component
 *
 * Sidebar navigation with grouped sections (Work / Tools / System Operations)
 * following the IA Joint Recommendations "Workplace" model.
 * Includes pinned favorites at the top of the Work group.
 *
 * @module components/Layout/Navigation
 */
import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
	Home,
	FolderOpen,
	Users,
	MessageSquare,
	Settings,
	ChevronLeft,
	ChevronRight,
	X,
	Store,
	Clock,
	Shield,
	DollarSign,
	Pin,
	Star,
	ClipboardList,
	Target,
	Inbox,
	Cloud,
} from 'lucide-react';
import clsx from 'clsx';
import { useSidebar } from '../../contexts/SidebarContext';
import { IconButton } from '../UI';
import { QRCodeDisplay } from './QRCodeDisplay';
import { AuthStatusIndicator } from '../Auth/AuthStatusIndicator';
import { usePinnedFavorites, type PinnedItem } from '../../hooks/usePinnedFavorites';

// =============================================================================
// Navigation Group Definitions
// =============================================================================

/** A single navigation item */
interface NavItem {
	name: string;
	href: string;
	icon: React.ComponentType<{ className?: string }>;
}

/** A group of related navigation items */
interface NavGroup {
	label: string;
	items: NavItem[];
}

/**
 * Navigation groups — streamlined IA with fewer sections:
 * Work (daily use) -> Tools (extensions + automation) -> System (operations + config)
 *
 * Cloud Portal is the single entry point for all Cloud management.
 */
const NAV_GROUPS: NavGroup[] = [
	{
		label: 'WORK',
		items: [
			{ name: 'Dashboard', href: '/', icon: Home },
			{ name: 'Projects', href: '/projects', icon: FolderOpen },
			{ name: 'Teams', href: '/teams', icon: Users },
			{ name: 'Missions', href: '/missions', icon: Target },
			{ name: 'Chat', href: '/chat', icon: MessageSquare },
		],
	},
	{
		label: 'TOOLS',
		items: [
			{ name: 'Marketplace', href: '/marketplace', icon: Store },
			{ name: 'Triggers', href: '/triggers', icon: Clock },
		],
	},
	{
		label: 'SYSTEM',
		items: [
			{ name: 'Work Items', href: '/workitems', icon: ClipboardList },
			{ name: 'Requests', href: '/requests', icon: Inbox },
			{ name: 'Cloud Portal', href: '/cloud', icon: Cloud },
			{ name: 'Usage', href: '/usage', icon: DollarSign },
			{ name: 'Security', href: '/security', icon: Shield },
			{ name: 'Settings', href: '/settings', icon: Settings },
		],
	},
];

// =============================================================================
// Component Props
// =============================================================================

interface NavigationProps {
	isMobileOpen?: boolean;
	onMobileClose?: () => void;
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Renders a single navigation link item.
 */
const NavLinkItem: React.FC<{
	item: NavItem;
	isCollapsed: boolean;
	isMobileOpen: boolean;
	onClick: () => void;
}> = ({ item, isCollapsed, isMobileOpen, onClick }) => {
	const location = useLocation();
	const isActive =
		location.pathname === item.href ||
		(item.href !== '/' && location.pathname.startsWith(item.href));

	const showLabel = !isCollapsed || isMobileOpen;

	return (
		<NavLink
			to={item.href}
			onClick={onClick}
			className={clsx(
				'group flex items-center px-4 py-2 rounded-lg text-sm transition-colors',
				isCollapsed && !isMobileOpen ? 'md:justify-center' : '',
				isActive
					? 'bg-primary/10 text-primary font-semibold'
					: 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
			)}
			title={!showLabel ? item.name : undefined}
		>
			<item.icon className={clsx('h-5 w-5 flex-shrink-0', isActive ? 'text-primary' : '')} />
			{showLabel && <span className="ml-3">{item.name}</span>}
		</NavLink>
	);
};

/**
 * Renders the pinned favorites section at the top of the Work group.
 */
const PinnedFavoritesSection: React.FC<{
	pinnedItems: PinnedItem[];
	isCollapsed: boolean;
	isMobileOpen: boolean;
	onClick: () => void;
}> = ({ pinnedItems, isCollapsed, isMobileOpen, onClick }) => {
	if (pinnedItems.length === 0) return null;

	const showLabel = !isCollapsed || isMobileOpen;

	return (
		<div className="mb-2" data-testid="pinned-favorites">
			{showLabel && (
				<div className="flex items-center gap-1.5 px-4 py-1 mb-1">
					<Star className="h-3 w-3 text-yellow-400" />
					<span className="text-[10px] font-semibold text-text-secondary-dark uppercase tracking-wider">
						Favorites
					</span>
				</div>
			)}
			<div className="space-y-0.5">
				{pinnedItems.map((item) => {
					const href = item.type === 'project' ? `/projects/${item.id}` : `/teams/${item.id}`;
					const Icon = item.type === 'project' ? FolderOpen : Users;

					return (
						<NavLink
							key={item.id}
							to={href}
							onClick={onClick}
							className={clsx(
								'group flex items-center px-4 py-1.5 rounded-lg text-sm transition-colors',
								isCollapsed && !isMobileOpen ? 'md:justify-center' : '',
								'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
							)}
							title={!showLabel ? item.name : undefined}
						>
							<Icon className="h-4 w-4 flex-shrink-0 text-yellow-400/70" />
							{showLabel && (
								<span className="ml-3 truncate">{item.name}</span>
							)}
							{showLabel && (
								<Pin className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-50 flex-shrink-0" />
							)}
						</NavLink>
					);
				})}
			</div>
			{showLabel && <div className="mx-4 mt-2 border-b border-border-dark" />}
		</div>
	);
};

// =============================================================================
// Main Navigation Component
// =============================================================================

/**
 * Main sidebar navigation component.
 *
 * Renders grouped navigation sections (Work, Tools, System Operations)
 * with pinned favorites at the top of the Work group. Includes logo,
 * cloud auth status, QR code display, and collapse toggle.
 *
 * @param props.isMobileOpen - Whether mobile drawer is open
 * @param props.onMobileClose - Callback to close mobile drawer
 */
export const Navigation: React.FC<NavigationProps> = ({ isMobileOpen, onMobileClose }) => {
	const { isCollapsed, toggleSidebar } = useSidebar();
	const { pinnedItems } = usePinnedFavorites();

	const handleLinkClick = () => {
		if (onMobileClose) {
			onMobileClose();
		}
	};

	// Detect when viewing a specific project to show contextual sub-navigation
	const location = useLocation();
	const projectMatch = location.pathname.match(/\/projects\/([^/]+)/);
	const activeProjectId = projectMatch ? projectMatch[1] : null;
	const activeHash = (location.hash || '#detail').replace('#', '') as 'detail' | 'editor' | 'tasks' | 'teams';

	const showLabels = !isCollapsed || !!isMobileOpen;

	return (
		<div className={clsx(
			'flex flex-col h-screen max-h-screen bg-surface-dark/95 border-r border-border-dark overflow-hidden w-full'
		)}>
			{/* Logo Section */}
			<div className="flex items-center justify-between p-4 border-b border-border-dark">
				<div className="flex items-center">
					<div className="p-1">
						<img src="/logo/crewly-icon.svg" alt="Crewly" className="h-8 w-8 invert" />
					</div>
					{showLabels && (
						<span className="ml-3 text-2xl font-extrabold text-text-primary-dark font-logo">
							CREWLY
						</span>
					)}
				</div>
				{onMobileClose && (
					<IconButton
						variant="ghost"
						icon={X}
						onClick={onMobileClose}
						className="md:hidden -mr-2"
						aria-label="Close menu"
					/>
				)}
			</div>

			{/* Main Navigation — Grouped */}
			<nav className="flex-1 px-2 py-3 overflow-y-auto" aria-label="Main navigation">
				{NAV_GROUPS.map((group, groupIndex) => (
					<div key={group.label} className={clsx(groupIndex > 0 && 'mt-4')}>
						{/* Group header */}
						{showLabels && (
							<div className="px-4 py-1 mb-1">
								<span
									className="text-[10px] font-semibold text-text-secondary-dark uppercase tracking-wider"
									data-testid={`nav-group-${group.label.toLowerCase().replace(/\s+/g, '-')}`}
								>
									{group.label}
								</span>
							</div>
						)}

						{/* Pinned Favorites — shown at the top of Work group */}
						{group.label === 'WORK' && (
							<PinnedFavoritesSection
								pinnedItems={pinnedItems}
								isCollapsed={isCollapsed}
								isMobileOpen={!!isMobileOpen}
								onClick={handleLinkClick}
							/>
						)}

						{/* Group items */}
						<div className="space-y-0.5">
							{group.items.map((item) => (
								<div key={item.name}>
									<NavLinkItem
										item={item}
										isCollapsed={isCollapsed}
										isMobileOpen={!!isMobileOpen}
										onClick={handleLinkClick}
									/>

									{/* Contextual project sub-nav under Projects */}
									{showLabels && item.href === '/projects' && activeProjectId && (
										<div className="mt-1 ml-4 space-y-0.5 border-l border-border-dark pl-4">
											{(['detail', 'editor', 'tasks', 'teams'] as const).map((tab) => (
												<NavLink
													key={tab}
													to={`/projects/${activeProjectId}#${tab}`}
													onClick={handleLinkClick}
													className={() =>
														clsx(
															'block px-4 py-1.5 text-sm rounded-lg transition-colors',
															activeHash === tab
																? 'text-primary font-medium bg-primary/10'
																: 'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
														)
													}
												>
													{tab.charAt(0).toUpperCase() + tab.slice(1)}
												</NavLink>
											))}
											<NavLink
												to={`/knowledge?project=${activeProjectId}`}
												onClick={handleLinkClick}
												className={() =>
													clsx(
														'block px-4 py-1.5 text-sm rounded-lg transition-colors',
														'text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark'
													)
												}
											>
												Knowledge
											</NavLink>
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				))}
			</nav>

			{/* Bottom Section */}
			<div className="p-2 border-t border-border-dark space-y-1">
				{/* Cloud Auth Status */}
				<AuthStatusIndicator isCollapsed={isCollapsed && !isMobileOpen} />

				{/* QR Code for Mobile Access */}
				<QRCodeDisplay isCollapsed={isCollapsed && !isMobileOpen} />

				{/* Collapse/Expand Button */}
				<button
					className="flex items-center justify-center w-full p-2 text-text-secondary-dark hover:bg-background-dark/60 hover:text-text-primary-dark rounded-lg transition-colors"
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
