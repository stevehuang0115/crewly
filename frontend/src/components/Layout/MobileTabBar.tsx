/**
 * MobileTabBar — phone navigation (< md): a bottom tab bar with Dashboard ·
 * Chat · Tickets · More. "More" opens a sheet with every other page, the
 * pinned favourites, Mobile Access, the cloud sign-in state and the version
 * (with the "Update available" chip), so nothing in the desktop sidebar is
 * out of reach on a phone (specs/2026-10-02-ui-redesign.md §Phone).
 *
 * @module components/Layout/MobileTabBar
 */
import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutGrid, ChevronRight, X } from 'lucide-react';
import clsx from 'clsx';
import { MORE_GROUPS, PHONE_TABS, isNavActive, type NavItem } from './nav-items';
import { NAV_BADGE_LABEL, useNavBadgeCounts } from './NavBadges';
import { PinnedFavoritesSection } from './PinnedFavorites';
import { useCrewlyVersion } from '../../hooks/useCrewlyVersion';
import { QRCodeDisplay } from './QRCodeDisplay';
import { AuthStatusIndicator } from '../Auth/AuthStatusIndicator';
import { UpdateAvailableChip } from '../System/UpdateAvailableChip';
import { usePinnedFavorites } from '../../hooks/usePinnedFavorites';

/** Height of the bar (px, without the safe-area inset) — pages pad by this much. */
export const MOBILE_TAB_BAR_HEIGHT = 64;

/** Marks the More sheet so it does not count as "another dialog is open". */
const MORE_SHEET_ATTR = 'data-more-sheet';

/** An open modal dialog other than the More sheet. */
const OTHER_MODAL_SELECTOR = `[aria-modal="true"]:not([${MORE_SHEET_ATTR}])`;

/**
 * Whether any modal dialog (Drawer, Modal, Popup, …) other than the More
 * sheet is in the document. The bar hides then, so a drawer's footer
 * actions (accept / send back, pause / delete) are never under it.
 *
 * @returns True while another dialog is open
 */
export function useOtherDialogOpen(): boolean {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const check = () => setOpen(document.querySelector(OTHER_MODAL_SELECTOR) !== null);
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
		return () => observer.disconnect();
	}, []);
	return open;
}

/**
 * One bottom tab.
 */
const TabLink: React.FC<{ item: NavItem; count: number | null; onClick: () => void }> = ({ item, count, onClick }) => {
	const { pathname } = useLocation();
	const active = isNavActive(item.href, pathname);
	return (
		<NavLink
			to={item.href}
			end={item.href === '/'}
			onClick={onClick}
			aria-current={active ? 'page' : undefined}
			className={clsx(
				'relative flex flex-col items-center justify-center gap-0.5 text-[11px]',
				active ? 'text-primary-text font-extrabold' : 'text-text-2 font-semibold',
			)}
			data-testid={`mobile-tab-${item.name.toLowerCase()}`}
		>
			<item.icon className="h-[22px] w-[22px]" />
			{item.name}
			{item.badge && !!count && (
				<span
					className={clsx(
						'absolute top-0.5 left-[52%] min-w-[18px] h-4 px-1 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center',
						item.badge === 'waiting' ? 'bg-attention text-bg' : 'bg-primary text-on-primary',
					)}
					aria-label={NAV_BADGE_LABEL[item.badge](count)}
				>
					{count}
				</span>
			)}
		</NavLink>
	);
};

/**
 * The "More" sheet: every page not on a tab, plus the sidebar extras.
 */
export const MoreSheet: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
	const { pinnedItems } = usePinnedFavorites();
	const { version, latestVersion, updateAvailable } = useCrewlyVersion();
	const badges = useNavBadgeCounts();

	useEffect(() => {
		if (!isOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	return (
		<div className="md:hidden fixed inset-0 z-50" data-testid="more-sheet">
			<div className="absolute inset-0 bg-bg/80 backdrop-blur-sm" onClick={onClose} aria-hidden="true" data-testid="more-sheet-backdrop" />
			<div
				role="dialog"
				aria-modal="true"
				data-more-sheet=""
				aria-label="More"
				className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl bg-bg border-t border-border px-4 pt-4"
				style={{ paddingBottom: `calc(${MOBILE_TAB_BAR_HEIGHT + 16}px + env(safe-area-inset-bottom))` }}
			>
				<header className="flex items-center justify-between gap-3 mb-4">
					<div className="min-w-0">
						<h2 className="text-2xl font-extrabold leading-8">More</h2>
						<p className="text-[13px] text-text-2">Everything else in Crewly</p>
					</div>
					<div className="flex items-center gap-2">
						<div className="text-right leading-none">
							<span className="block text-[13px] font-extrabold">CREWLY</span>
							{version && <span className="block mt-0.5 text-[10px] text-text-3 tabular-nums">v{version}</span>}
							{version && updateAvailable && <UpdateAvailableChip latestVersion={latestVersion} onNavigate={onClose} className="mt-1" />}
						</div>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close menu"
							className="inline-flex h-9 w-9 items-center justify-center rounded-2xl text-text-2 hover:bg-surface"
						>
							<X className="h-5 w-5" />
						</button>
					</div>
				</header>

				{pinnedItems.length > 0 && (
					<section className="mb-4 rounded-2xl bg-surface py-2">
						<PinnedFavoritesSection pinnedItems={pinnedItems} isCollapsed={false} onClick={onClose} />
					</section>
				)}

				{MORE_GROUPS.map((group) => (
					<section key={group.label} className="mb-4">
						<h3 className="mb-1.5 px-1 text-[11px] font-extrabold uppercase tracking-wider text-text-3">{group.label}</h3>
						<ul className="rounded-2xl bg-surface overflow-hidden">
							{group.items.map((item, i) => {
								const count = item.badge ? badges[item.badge] : null;
								return (
									<li key={item.href} className={clsx(i > 0 && 'border-t border-border-soft')}>
										<NavLink to={item.href} onClick={onClose} className="flex items-center gap-3 px-3.5 py-2.5 text-text">
											<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-text-2">
												<item.icon className="h-[18px] w-[18px]" />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block text-[15px] font-bold">{item.name}</span>
												{item.hint && <span className="block truncate text-xs text-text-3">{item.hint}</span>}
											</span>
											{item.badge && !!count && (
												<span className="min-w-[22px] h-5 px-1.5 rounded-full bg-primary-soft text-primary-text text-[11px] font-extrabold inline-flex items-center justify-center" aria-label={NAV_BADGE_LABEL[item.badge](count)}>
													{count}
												</span>
											)}
											<ChevronRight className="h-4 w-4 shrink-0 text-text-3" />
										</NavLink>
									</li>
								);
							})}
						</ul>
					</section>
				))}

				<section className="rounded-2xl bg-surface p-1 space-y-1">
					<QRCodeDisplay isCollapsed={false} />
					<AuthStatusIndicator isCollapsed={false} />
				</section>
			</div>
		</div>
	);
};

/**
 * Bottom tab bar for phones.
 *
 * @returns The bar and its More sheet (hidden from md up)
 */
export const MobileTabBar: React.FC = () => {
	const [moreOpen, setMoreOpen] = useState(false);
	const badges = useNavBadgeCounts();
	const { pathname } = useLocation();

	// Navigating anywhere closes the sheet.
	useEffect(() => {
		setMoreOpen(false);
	}, [pathname]);

	const onTab = PHONE_TABS.some((t) => isNavActive(t.href, pathname));
	const otherDialogOpen = useOtherDialogOpen();

	return (
		<>
			<MoreSheet isOpen={moreOpen} onClose={() => setMoreOpen(false)} />
			{/* z-40: dialogs (z-50) cover the bar, and it hides while one is open. */}
			<nav
				aria-label="Main tabs"
				className={clsx(
					'md:hidden fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 bg-surface border-t border-border px-2 pt-1.5',
					otherDialogOpen && 'hidden',
				)}
				aria-hidden={otherDialogOpen || undefined}
				style={{ height: `calc(${MOBILE_TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`, paddingBottom: 'env(safe-area-inset-bottom)' }}
				data-testid="mobile-tab-bar"
			>
				{PHONE_TABS.map((item) => (
					<TabLink key={item.href} item={item} count={item.badge ? badges[item.badge] : null} onClick={() => setMoreOpen(false)} />
				))}
				<button
					type="button"
					onClick={() => setMoreOpen((v) => !v)}
					aria-expanded={moreOpen}
					aria-haspopup="dialog"
					className={clsx(
						'flex flex-col items-center justify-center gap-0.5 text-[11px]',
						moreOpen || !onTab ? 'text-primary-text font-extrabold' : 'text-text-2 font-semibold',
					)}
					data-testid="mobile-tab-more"
				>
					<LayoutGrid className="h-[22px] w-[22px]" />
					More
				</button>
			</nav>
		</>
	);
};

export default MobileTabBar;
