/**
 * Pinned favourites (projects / teams) at the top of the sidebar's Work
 * group, and in the phone "More" sheet.
 *
 * @module components/Layout/PinnedFavorites
 */
import React from 'react';
import { NavLink } from 'react-router-dom';
import { FolderOpen, Users, Pin, Star } from 'lucide-react';
import clsx from 'clsx';
import type { PinnedItem } from '../../hooks/usePinnedFavorites';

/**
 * Renders the pinned favorites section at the top of the Work group.
 */
export const PinnedFavoritesSection: React.FC<{
	pinnedItems: PinnedItem[];
	isCollapsed: boolean;
	onClick?: () => void;
}> = ({ pinnedItems, isCollapsed, onClick }) => {
	if (pinnedItems.length === 0) return null;

	const showLabel = !isCollapsed;

	return (
		<div className="mb-2" data-testid="pinned-favorites">
			{showLabel && (
				<div className="flex items-center gap-1.5 px-4 py-1 mb-1">
					<Star className="h-3 w-3 text-attention" />
					<span className="text-[10px] font-semibold text-text-2 uppercase tracking-wider">
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
								'group flex items-center px-4 py-1.5 rounded-2xl text-sm transition-colors',
								isCollapsed ? 'justify-center' : '',
								'text-text-2 hover:bg-surface-hover hover:text-text'
							)}
							title={!showLabel ? item.name : undefined}
						>
							<Icon className="h-4 w-4 flex-shrink-0 text-attention/70" />
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
			{showLabel && <div className="mx-4 mt-2 border-b border-border-soft" />}
		</div>
	);
};
