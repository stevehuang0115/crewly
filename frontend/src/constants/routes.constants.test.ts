import { describe, expect, it } from 'vitest';
import {
	LEGACY_REDIRECTS,
	LINKS,
	PROJECT_TABS,
	ROUTES,
	SETTINGS_TABS,
	mergeRedirectTarget,
	projectTabFromHash,
	settingsTabRedirect,
	withTab,
} from './routes.constants';

describe('routes.constants', () => {
	it('has the 12 top-level pages', () => {
		expect(Object.keys(ROUTES)).toHaveLength(12);
		expect(ROUTES.schedules).toBe('/triggers');
		expect(ROUTES.chat).toBe('/team-chat');
	});

	it('builds tab and detail links', () => {
		expect(withTab('/tickets', 'board', 'board')).toBe('/tickets');
		expect(LINKS.requests()).toBe('/tickets?tab=requests');
		expect(LINKS.runs()).toBe('/tickets?tab=runs');
		expect(LINKS.request('r 1')).toBe('/tickets/requests/r%201');
		expect(LINKS.run('w1')).toBe('/tickets/runs/w1');
		expect(LINKS.goals()).toBe('/teams?tab=goals');
		expect(LINKS.goal('m1')).toBe('/teams/goals/m1');
		expect(LINKS.installedSkills()).toBe('/marketplace?tab=installed');
		expect(LINKS.settingsTab('general')).toBe('/settings');
		expect(LINKS.settingsTab('cloud')).toBe('/settings?tab=cloud');
		expect(SETTINGS_TABS[0]).toBe('general');
	});

	it('maps every old URL', () => {
		const to = Object.fromEntries(LEGACY_REDIRECTS.map((r) => [r.path, r.to({ id: 'X' })]));
		expect(to).toEqual({
			tasks: '/tickets?tab=requests',
			'tasks/:id': '/tickets/requests/X',
			requests: '/tickets?tab=requests',
			'requests/:id': '/tickets/requests/X',
			workitems: '/tickets?tab=runs',
			'workitems/:id': '/tickets/runs/X',
			missions: '/teams?tab=goals',
			'missions/:id': '/teams/goals/X',
			cloud: '/settings?tab=cloud',
			security: '/settings?tab=security',
			'monitoring/costs': '/usage',
			chat: '/team-chat',
			agents: '/team-chat',
		});
	});

	it('merges the old query and hash into the target, the target winning', () => {
		expect(mergeRedirectTarget('/settings?tab=cloud', '?upgraded=true', '#x')).toBe('/settings?upgraded=true&tab=cloud#x');
		expect(mergeRedirectTarget('/tickets?tab=runs', '?tab=old')).toBe('/tickets?tab=runs');
		expect(mergeRedirectTarget('/usage', '')).toBe('/usage');
	});

	it('redirects the Settings tabs that moved out', () => {
		expect(settingsTabRedirect('?tab=skills')).toBe('/marketplace?tab=installed');
		expect(settingsTabRedirect('?tab=integrations')).toBe('/connections');
		expect(settingsTabRedirect('?tab=integrations&google=connected')).toBe('/connections?google=connected');
		expect(settingsTabRedirect('?tab=slack')).toBe('/connections?platform=slack');
		expect(settingsTabRedirect('?tab=cloud')).toBeNull();
		expect(settingsTabRedirect('')).toBeNull();
	});

	it('links project and team pages', () => {
		expect(PROJECT_TABS[0]).toBe('detail');
		expect(LINKS.project('p1')).toBe('/projects/p1');
		expect(LINKS.project('p1', 'tasks')).toBe('/projects/p1?tab=tasks');
		expect(LINKS.team('t 1')).toBe('/teams/t%201');
	});

	it('maps old project hash links to tabs', () => {
		expect(projectTabFromHash('#editor')).toBe('editor');
		expect(projectTabFromHash('teams')).toBe('teams');
		expect(projectTabFromHash('#nope')).toBeNull();
		expect(projectTabFromHash('')).toBeNull();
	});
});
