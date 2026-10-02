/**
 * The redesigned navigation: 12 pages in three groups (sidebar) and the four
 * phone tabs (specs/2026-10-02-ui-redesign.md §Navigation). Shared by the
 * sidebar, the phone tab bar and its "More" sheet so they never disagree.
 *
 * @module components/Layout/nav-items
 */
import type React from 'react';
import {
	Home,
	MessageSquare,
	Ticket,
	FolderOpen,
	Users,
	BookOpen,
	CalendarClock,
	Globe,
	Store,
	Plug,
	DollarSign,
	Settings,
} from 'lucide-react';
import { ROUTES } from '../../constants/routes.constants';
import { SCHEDULES_NAV_LABEL } from '../../constants/schedules.constants';

/** Which live count a nav item shows. */
export type NavBadgeKind = 'waiting' | 'unread' | 'schedules';

/** One navigation entry. */
export interface NavItem {
	name: string;
	href: string;
	icon: React.ComponentType<{ className?: string }>;
	/** Live count badge */
	badge?: NavBadgeKind;
	/** One-line hint for the phone "More" sheet */
	hint?: string;
}

/** A labelled group of entries. */
export interface NavGroup {
	label: 'WORK' | 'TOOLS' | 'SYSTEM';
	items: NavItem[];
}

export const NAV_DASHBOARD: NavItem = { name: 'Dashboard', href: ROUTES.dashboard, icon: Home, badge: 'waiting', hint: 'What needs you, and is your crew OK' };
export const NAV_CHAT: NavItem = { name: 'Chat', href: ROUTES.chat, icon: MessageSquare, badge: 'unread', hint: 'Orchestrator, agents and team channels' };
export const NAV_TICKETS: NavItem = { name: 'Tickets', href: ROUTES.tickets, icon: Ticket, hint: 'Board, requests and runs' };

/** Sidebar groups, in order. */
export const NAV_GROUPS: NavGroup[] = [
	{
		label: 'WORK',
		items: [
			NAV_DASHBOARD,
			NAV_CHAT,
			NAV_TICKETS,
			{ name: 'Projects', href: ROUTES.projects, icon: FolderOpen, hint: 'Code, docs and each project’s board' },
			{ name: 'Teams', href: ROUTES.teams, icon: Users, hint: 'Your crews and their goals' },
			{ name: 'Wiki', href: ROUTES.wiki, icon: BookOpen, hint: 'Knowledge, SOPs and notes' },
		],
	},
	{
		label: 'TOOLS',
		items: [
			// Route stays /triggers; the page is the owner's scheduled work.
			{ name: SCHEDULES_NAV_LABEL, href: ROUTES.schedules, icon: CalendarClock, badge: 'schedules', hint: 'Recurring work and reminders' },
			// Live view of whatever an agent is doing in Chrome.
			{ name: 'Browser', href: ROUTES.browser, icon: Globe, hint: 'Watch or take over agent browsing' },
			{ name: 'Marketplace', href: ROUTES.marketplace, icon: Store, hint: 'Skills, roles and installed items' },
			{ name: 'Connections', href: ROUTES.connections, icon: Plug, hint: 'Slack, WhatsApp, Google and more' },
		],
	},
	{
		label: 'SYSTEM',
		items: [
			{ name: 'Usage', href: ROUTES.usage, icon: DollarSign, hint: 'Tokens by team, agent and runtime' },
			{ name: 'Settings', href: ROUTES.settings, icon: Settings, hint: 'Runtimes, keys, cloud and devices' },
		],
	},
];

/** Phone bottom tabs (the fourth tab, "More", opens a sheet with the rest). */
export const PHONE_TABS: NavItem[] = [NAV_DASHBOARD, NAV_CHAT, NAV_TICKETS];

/** Groups for the phone "More" sheet: everything not on a phone tab. */
export const MORE_GROUPS: NavGroup[] = NAV_GROUPS.map((g) => ({
	label: g.label,
	items: g.items.filter((i) => !PHONE_TABS.includes(i)),
})).filter((g) => g.items.length > 0);

/**
 * Whether a nav entry is the current page (sub-pages count: `/tickets/runs/7`
 * is under Tickets). The dashboard matches `/` only.
 *
 * @param href - Entry path
 * @param pathname - Current location path
 * @returns True when active
 */
export function isNavActive(href: string, pathname: string): boolean {
	if (href === '/') return pathname === '/';
	return pathname === href || pathname.startsWith(`${href}/`);
}
