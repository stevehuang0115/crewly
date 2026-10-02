/**
 * Live counts for the navigation badges, fetched once for the whole layout
 * (sidebar + phone tab bar share them):
 * - waiting: open decisions ("Waiting on you"), shown in the attention colour
 * - unread: Chat conversations with new messages
 * - schedules: active recurring schedules
 *
 * @module components/Layout/NavBadges
 */
import React, { createContext, useContext } from 'react';
import clsx from 'clsx';
import { useLocation } from 'react-router-dom';
import { useScheduleCount } from '../../hooks/useScheduleCount';
import { useWaitingOnYouCount } from '../../hooks/useWaitingOnYouCount';
import { useChatUnreadCount } from '../../hooks/useChatUnreadCount';
import { ROUTES } from '../../constants/routes.constants';
import type { NavBadgeKind } from './nav-items';

/** Count per badge kind; null = unknown (hidden). */
export type NavBadgeCounts = Record<NavBadgeKind, number | null>;

const EMPTY: NavBadgeCounts = { waiting: null, unread: null, schedules: null };

const NavBadgesContext = createContext<NavBadgeCounts>(EMPTY);

/**
 * Polls the three counts and provides them to the navigation.
 *
 * @param props.children - The layout
 * @returns Provider
 */
export const NavBadgesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { pathname } = useLocation();
	const waiting = useWaitingOnYouCount();
	const unread = useChatUnreadCount(pathname.startsWith(ROUTES.chat));
	const schedules = useScheduleCount();
	return <NavBadgesContext.Provider value={{ waiting, unread, schedules }}>{children}</NavBadgesContext.Provider>;
};

/**
 * Current badge counts (all null outside a provider).
 *
 * @returns Counts
 */
export function useNavBadgeCounts(): NavBadgeCounts {
	return useContext(NavBadgesContext);
}

/** Accessible wording of each badge. */
export const NAV_BADGE_LABEL: Record<NavBadgeKind, (n: number) => string> = {
	waiting: (n) => `${n} waiting on you`,
	unread: (n) => `${n} unread`,
	schedules: (n) => `${n} active`,
};


/**
 * Count pill beside a nav label. Waiting-on-you uses the attention colour.
 */
export const NavBadge: React.FC<{ kind: NavBadgeKind; count: number; testId: string }> = ({ kind, count, testId }) => (
	<span
		className={clsx(
			'ml-auto min-w-[1.375rem] h-[1.375rem] px-1.5 rounded-full text-[11px] font-semibold tabular-nums inline-flex items-center justify-center',
			kind === 'waiting' ? 'bg-attention-soft text-attention' : 'bg-primary-soft text-primary-text',
		)}
		data-testid={testId}
		aria-label={NAV_BADGE_LABEL[kind](count)}
	>
		{count}
	</span>
);

