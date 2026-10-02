import { describe, expect, it } from 'vitest';
import { MORE_GROUPS, NAV_GROUPS, PHONE_TABS, isNavActive } from './nav-items';

describe('nav-items', () => {
	it('has 12 sidebar items in Work / Tools / System', () => {
		expect(NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.name)])).toEqual([
			['WORK', ['Dashboard', 'Chat', 'Tickets', 'Projects', 'Teams', 'Wiki']],
			['TOOLS', ['Schedules', 'Browser', 'Marketplace', 'Connections']],
			['SYSTEM', ['Usage', 'Settings']],
		]);
	});

	it('badges Dashboard (waiting), Chat (unread) and Schedules', () => {
		const badges = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.badge).map((i) => [i.name, i.badge]);
		expect(badges).toEqual([
			['Dashboard', 'waiting'],
			['Chat', 'unread'],
			['Schedules', 'schedules'],
		]);
	});

	it('puts Dashboard, Chat and Tickets on the phone tabs and everything else in More', () => {
		expect(PHONE_TABS.map((t) => t.name)).toEqual(['Dashboard', 'Chat', 'Tickets']);
		const more = MORE_GROUPS.flatMap((g) => g.items.map((i) => i.name));
		expect(more).toEqual(['Projects', 'Teams', 'Wiki', 'Schedules', 'Browser', 'Marketplace', 'Connections', 'Usage', 'Settings']);
	});

	it('matches sub-pages, and the dashboard only at /', () => {
		expect(isNavActive('/', '/')).toBe(true);
		expect(isNavActive('/', '/tickets')).toBe(false);
		expect(isNavActive('/tickets', '/tickets/runs/1')).toBe(true);
		expect(isNavActive('/teams', '/team-chat')).toBe(false);
	});
});
