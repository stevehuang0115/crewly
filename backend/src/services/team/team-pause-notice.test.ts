/**
 * Tests for the paused-agent Slack notice (specs/2026-10-04-team-pause.md).
 */

import { PausedThreadNotices, pausedSlackNotice } from './team-pause-notice.js';
import type { PausedTeamInfo } from './team-pause.registry.js';

const INFO: PausedTeamInfo = {
	teamId: 'team-crewly',
	teamName: 'Crewly',
	issueRepo: 'stevehuang0115/crewly',
	pause: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' },
	sessions: ['crewly-leo'],
	memberNames: ['Leo'],
};

describe('pausedSlackNotice', () => {
	it('tells a person the team is paused and how to bring it back', () => {
		expect(pausedSlackNotice(INFO, 'Leo')).toBe(
			'Leo is on Crewly, which the owner has paused, so Leo won\'t pick this up. To bring the team back, DM the orc "resume Crewly".',
		);
	});

	it('gives another agent the refusal (file an issue)', () => {
		expect(pausedSlackNotice(INFO, 'Leo', { toAgent: true })).toMatch(/^Crewly is paused by the owner\. File a GitHub issue instead: `gh issue create -R stevehuang0115\/crewly/);
	});
});

describe('PausedThreadNotices', () => {
	it('allows one notice per thread and team', () => {
		const n = new PausedThreadNotices(2);
		expect(n.claim('C1', '1.0', 'team-crewly')).toBe(true);
		expect(n.claim('C1', '1.0', 'team-crewly')).toBe(false);
		expect(n.claim('C1', '2.0', 'team-crewly')).toBe(true);
		expect(n.claim('C1', '1.0', 'team-other')).toBe(true);
		// Capacity 2: the oldest was forgotten.
		expect(n.claim('C1', '1.0', 'team-crewly')).toBe(true);
	});
});
