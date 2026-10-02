/**
 * Routes, tab ids and old-URL redirects of the redesigned app
 * (specs/2026-10-02-ui-redesign.md §Routes).
 *
 * Every page links through these helpers, so a route change is one edit.
 * A page with tabs keeps the active tab in `?tab=<id>` (see `useTabParam`);
 * the first id of each `*_TABS` list is the default and is left out of the
 * URL.
 *
 * @module constants/routes.constants
 */

import { SCHEDULES_ROUTE } from './schedules.constants';

/** Top-level pages (the 12 sidebar items). */
export const ROUTES = {
	dashboard: '/',
	chat: '/team-chat',
	tickets: '/tickets',
	projects: '/projects',
	teams: '/teams',
	wiki: '/wiki',
	schedules: SCHEDULES_ROUTE,
	browser: '/browser',
	marketplace: '/marketplace',
	connections: '/connections',
	usage: '/usage',
	settings: '/settings',
} as const;

/** Tickets: the home of all work. */
export const TICKETS_TABS = ['board', 'requests', 'runs'] as const;
export type TicketsTab = (typeof TICKETS_TABS)[number];

/** Teams: the teams list and the company/team goals (former Missions). */
export const TEAMS_TABS = ['teams', 'goals'] as const;
export type TeamsTab = (typeof TEAMS_TABS)[number];

/** Marketplace: browse the registry, what is installed (former Settings › Skills), and skills submitted for review. */
export const MARKETPLACE_TABS = ['browse', 'installed', 'submissions'] as const;
export type MarketplaceTab = (typeof MARKETPLACE_TABS)[number];

/** Settings sections, in tab order. */
export const SETTINGS_TABS = ['general', 'runtimes', 'roles', 'api-keys', 'credentials', 'cloud', 'security', 'system'] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number];

/** Old `?tab=` values a Settings URL may still carry, mapped to the current id. */
export const SETTINGS_TAB_ALIASES: Readonly<Record<string, SettingsTabId>> = {
	harness: 'runtimes',
};

/**
 * A path with `?tab=` set (left out for the default tab).
 *
 * @param path - Page path
 * @param tab - Tab id
 * @param defaultTab - The page's default tab
 * @returns e.g. `/tickets?tab=runs`
 */
export function withTab(path: string, tab: string, defaultTab?: string): string {
	return tab === defaultTab ? path : `${path}?tab=${encodeURIComponent(tab)}`;
}

/** Links into the new structure. */
export const LINKS = {
	ticketsBoard: () => ROUTES.tickets,
	requests: () => withTab(ROUTES.tickets, 'requests'),
	runs: () => withTab(ROUTES.tickets, 'runs'),
	/** Request detail (former `/tasks/:id`). */
	request: (id: string) => `${ROUTES.tickets}/requests/${encodeURIComponent(id)}`,
	/** Run detail (former `/workitems/:id`). */
	run: (id: string) => `${ROUTES.tickets}/runs/${encodeURIComponent(id)}`,
	goals: () => withTab(ROUTES.teams, 'goals'),
	/** Goal detail (former `/missions/:id`). */
	goal: (id: string) => `${ROUTES.teams}/goals/${encodeURIComponent(id)}`,
	installedSkills: () => withTab(ROUTES.marketplace, 'installed'),
	settingsTab: (tab: SettingsTabId) => withTab(ROUTES.settings, tab, SETTINGS_TABS[0]),
} as const;

/**
 * Where an old Settings `?tab=` now lives, or null when it is still a
 * Settings tab. Other query parameters are carried over (OAuth returns put
 * `…=connected` flags next to the tab).
 *
 * @param search - The Settings URL's query string (`?tab=skills&x=1`)
 * @returns The new path, or null to stay on Settings
 */
export function settingsTabRedirect(search: string): string | null {
	const params = new URLSearchParams(search);
	const tab = params.get('tab');
	if (tab === 'skills') {
		params.set('tab', 'installed');
		return `${ROUTES.marketplace}?${params.toString()}`;
	}
	if (tab === 'integrations' || tab === 'slack') {
		// Same mapping the old Integrations tab used: ?tab=slack opens the Slack card.
		if (tab === 'slack' && !params.get('platform')) params.set('platform', 'slack');
		params.delete('tab');
		const qs = params.toString();
		return qs ? `${ROUTES.connections}?${qs}` : ROUTES.connections;
	}
	return null;
}

/** An old URL and where it now lives. `to` gets the route params. */
export interface LegacyRedirect {
	/** Route path under the app layout (react-router syntax, no leading slash) */
	path: string;
	to: (params: Readonly<Record<string, string | undefined>>) => string;
}

/**
 * Old URLs kept alive for bookmarks, Slack links and decision cards
 * (specs/2026-10-02-ui-redesign.md §Routes). The query string and hash of
 * the old URL are carried over (the target's own `?tab=` wins).
 */
export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
	{ path: 'tasks', to: () => LINKS.requests() },
	{ path: 'tasks/:id', to: ({ id }) => LINKS.request(id ?? '') },
	{ path: 'requests', to: () => LINKS.requests() },
	{ path: 'requests/:id', to: ({ id }) => LINKS.request(id ?? '') },
	{ path: 'workitems', to: () => LINKS.runs() },
	{ path: 'workitems/:id', to: ({ id }) => LINKS.run(id ?? '') },
	{ path: 'missions', to: () => LINKS.goals() },
	{ path: 'missions/:id', to: ({ id }) => LINKS.goal(id ?? '') },
	{ path: 'cloud', to: () => LINKS.settingsTab('cloud') },
	{ path: 'security', to: () => LINKS.settingsTab('security') },
	{ path: 'monitoring/costs', to: () => ROUTES.usage },
	{ path: 'chat', to: () => ROUTES.chat },
	{ path: 'agents', to: () => ROUTES.chat },
];

/**
 * Merge an old URL's query string into a redirect target. Parameters the
 * target sets itself (e.g. `tab`) win.
 *
 * @param target - New path, possibly with its own query
 * @param search - Old query string (`?upgraded=true`)
 * @param hash - Old hash (`#section`)
 * @returns The final URL
 */
export function mergeRedirectTarget(target: string, search: string, hash = ''): string {
	const [path, targetQuery = ''] = target.split('?');
	const params = new URLSearchParams(search);
	new URLSearchParams(targetQuery).forEach((value, key) => params.set(key, value));
	const qs = params.toString();
	return `${path}${qs ? `?${qs}` : ''}${hash}`;
}
