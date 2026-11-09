import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { extractWorkRefs, findHeldMatches, type HoldTicketView } from '../project-tickets/ticket-hold.js';
import { buildUnmergedNotice, pruneUnmergedState, shouldNotifyUnmerged, type UnmergedWorktreeFacts } from './worktree-unmerged-notice.js';

const FACTS: UnmergedWorktreeFacts = {
	path: '/w/wt-crew257',
	branch: 'feat/gmail-approve',
	commitsNotOnMain: 3,
	defaultRef: 'origin/main',
	pushed: true,
	sizeBytes: null,
};

const HELD: HoldTicketView = {
	id: 'CREW-257',
	title: 'Gmail approve card',
	labels: [],
	description: '',
	log: ['t · orc · HOLD: PR #1138: do not merge'],
};

describe('buildUnmergedNotice', () => {
	it('asks to merge when nothing is held', () => {
		const text = buildUnmergedNotice(FACTS);
		expect(text).toContain('3 commits not on origin/main, pushed');
		expect(text).toContain('Please merge it to main');
	});

	it('names the hold and never asks to merge held work', () => {
		const hold = findHeldMatches(extractWorkRefs('PR #1138'), [HELD])[0];
		const text = buildUnmergedNotice(FACTS, hold);
		expect(text).toContain('CREW-257');
		expect(text).not.toContain('Please merge it to main');
	});
});

describe('notice state', () => {
	const { UNMERGED_NOTICE_MIN_AGE_MS: AGE, UNMERGED_NOTICE_INTERVAL_MS: INTERVAL } = WORKTREE_JANITOR_CONSTANTS;
	const now = 10 * INTERVAL + 10 * AGE;

	it('waits for old enough commits and the interval', () => {
		expect(shouldNotifyUnmerged({}, 'p', null, now)).toBe(false);
		expect(shouldNotifyUnmerged({}, 'p', now, now)).toBe(false);
		expect(shouldNotifyUnmerged({}, 'p', now - AGE, now)).toBe(true);
		expect(shouldNotifyUnmerged({ p: now - 1 }, 'p', now - AGE, now)).toBe(false);
		expect(shouldNotifyUnmerged({ p: now - INTERVAL }, 'p', now - AGE, now)).toBe(true);
	});

	it('prunes entries older than the interval', () => {
		expect(pruneUnmergedState({ old: now - INTERVAL, fresh: now - 1 }, now)).toEqual({ fresh: now - 1 });
	});
});
