import {
  decisionHoldRefusal,
  extractWorkRefs,
  findHeldMatches,
  heldDescriptionNote,
  heldWorktreeNoticeLine,
  isCloseOnlyAsk,
  isHoldLogMessage,
  isLiftLogMessage,
  linkedHoldReason,
  mergeWorkRefs,
  readTicketHold,
  ticketIdOfWorktree,
  ticketWorkRefs,
  worktreeRefs,
  type HoldTicketView,
} from './ticket-hold.js';

/** CREW-257 as it was on 2026-10-14: the hold was only a Log line. */
const CREW_257: HoldTicketView = {
  id: 'CREW-257',
  title: 'Gmail approve-then-send card + wake on reply',
  labels: [],
  description: 'Build the approve-then-send card.',
  log: [
    '2026-10-06T09:00:00.000Z · owner · created (backlog)',
    '2026-10-06T12:00:00.000Z · crewly-orc · PR #1138 opened',
    '2026-10-06T15:00:00.000Z · crewly-orc · HOLD: PR #1138: do not merge, do not ask Steve to merge, no further work. Ella asked Steve whether to close; orc relays.',
  ],
};

function ticket(over: Partial<HoldTicketView>): HoldTicketView {
  return { id: 'CREW-1', title: 'Something', labels: [], description: '', log: [], ...over };
}

describe('readTicketHold', () => {
  it('reads a legacy HOLD log line', () => {
    const hold = readTicketHold(CREW_257);
    expect(hold?.source).toBe('log');
    expect(hold?.reason).toContain('do not merge, do not ask Steve to merge');
  });

  it('prefers the hold field', () => {
    expect(readTicketHold(ticket({ hold: 'owner: no more work' }))).toEqual({ reason: 'owner: no more work', source: 'field' });
  });

  it('reads heldBy from a linked hold', () => {
    expect(readTicketHold(ticket({ hold: 'held by CREW-257: HOLD: do not merge' }))?.heldBy).toBe('CREW-257');
  });

  it('reads a hold label (with the log reason when there is one)', () => {
    expect(readTicketHold(ticket({ labels: ['On-Hold'] }))).toEqual({ reason: 'labelled on-hold', source: 'label' });
    expect(readTicketHold(ticket({ labels: ['hold'], log: ['t · owner · do not merge yet'] }))?.reason).toBe('do not merge yet');
  });

  it('honours a later lift line', () => {
    expect(readTicketHold(ticket({ log: [...CREW_257.log, '2026-10-08T00:00:00Z · owner · hold lifted'] }))).toBeNull();
    expect(readTicketHold(ticket({ log: ['t · owner · hold lifted', 't · owner · HOLD: again'] }))?.reason).toBe('HOLD: again');
  });

  it('is null for ordinary tickets', () => {
    expect(readTicketHold(ticket({ log: ['t · a · merged PR #12', 't · a · household budget done', 't · a · placeholder'] }))).toBeNull();
  });
});

describe('isHoldLogMessage / isLiftLogMessage', () => {
  it.each(['HOLD: PR #1138', 'put on hold by the owner', 'owner said no', 'do not merge until Monday', "don't merge it", '不要合并这个 PR', '先暂停'])('hold: %s', (m) => {
    expect(isHoldLogMessage(m)).toBe(true);
  });
  it.each(['merged PR #12', 'the shareholder report', 'HOLD lifted', 'hold lifted by owner', 'Threshold tuned', 'holding pattern'])('not a hold: %s', (m) => {
    expect(isHoldLogMessage(m)).toBe(false);
  });
  it('lift lines', () => {
    expect(isLiftLogMessage('hold lifted')).toBe(true);
    expect(isLiftLogMessage('unhold: the owner wants it now')).toBe(true);
    expect(isLiftLogMessage('HOLD: do not merge')).toBe(false);
  });
});

describe('extractWorkRefs', () => {
  it('finds PRs, branches and worktrees', () => {
    const refs = extractWorkRefs(
      'Decide the fate of OPEN PR #1138 (https://github.com/o/r/pull/1139). Branch `feat/gmail-approve`; worktree /Users/x/wt-crew257 and fix/thing.',
    );
    expect(refs.prs.sort()).toEqual([1138, 1139]);
    expect(refs.branches).toEqual(expect.arrayContaining(['feat/gmail-approve', 'fix/thing']));
    expect(refs.worktrees).toEqual(['wt-crew257']);
    expect(refs.tickets).toEqual(['CREW-257']);
  });

  it('does not treat a bare #123 or a ticket mention as work refs', () => {
    expect(extractWorkRefs('See issue #123 and CREW-257 for context')).toEqual({ prs: [], branches: [], worktrees: [], tickets: [] });
  });

  it('mergeWorkRefs dedupes', () => {
    expect(mergeWorkRefs(extractWorkRefs('PR #1'), extractWorkRefs('PR 1 PR #2')).prs).toEqual([1, 2]);
  });
});

describe('worktree refs', () => {
  it('maps a worktree folder to a ticket id', () => {
    expect(ticketIdOfWorktree('wt-crew257')).toBe('CREW-257');
    expect(ticketIdOfWorktree('wt-crew-12')).toBe('CREW-12');
    expect(ticketIdOfWorktree('wt-hold-honored')).toBeNull();
  });

  it('builds refs from a branch and path', () => {
    expect(worktreeRefs('feat/X', '/a/b/wt-crew257/')).toEqual({ prs: [], branches: ['feat/x'], worktrees: ['wt-crew257'], tickets: ['CREW-257'] });
    expect(worktreeRefs(null, '/a/b/other')).toEqual({ prs: [], branches: [], worktrees: ['other'], tickets: [] });
  });

  it('reads pr / branch frontmatter keys', () => {
    const refs = ticketWorkRefs(ticket({ extra: { pr: 77, branch: 'my-branch', worktree: '/x/wt-foo' } }));
    expect(refs.prs).toEqual([77]);
    expect(refs.branches).toEqual(['my-branch']);
    expect(refs.worktrees).toEqual(['wt-foo']);
  });
});

describe('findHeldMatches', () => {
  it('matches the janitor worktree of CREW-257 by its ticket id, and CREW-646 by PR', () => {
    expect(findHeldMatches(worktreeRefs(null, '/w/wt-crew257'), [CREW_257])[0]).toMatchObject({ ticketId: 'CREW-257', matchedOn: ['ticket CREW-257'] });
    expect(findHeldMatches(extractWorkRefs('Decide the fate of OPEN PR #1138'), [CREW_257])[0].matchedOn).toEqual(['PR #1138']);
  });

  it('ignores tickets that are not held, other PRs, and the excluded id', () => {
    const notHeld = ticket({ id: 'CREW-2', log: ['t · a · PR #1138 opened'] });
    expect(findHeldMatches(extractWorkRefs('PR #1138'), [notHeld])).toEqual([]);
    expect(findHeldMatches(extractWorkRefs('PR #9'), [CREW_257])).toEqual([]);
    expect(findHeldMatches(extractWorkRefs('PR #1138'), [CREW_257], { excludeId: 'crew-257' })).toEqual([]);
  });

  it('lists tickets held in their own right first', () => {
    const linked = ticket({ id: 'CREW-646', title: 'Decide the fate of OPEN PR #1138', hold: 'held by CREW-257: HOLD: do not merge' });
    const out = findHeldMatches(extractWorkRefs('PR #1138'), [linked, CREW_257]);
    expect(out.map((m) => m.ticketId)).toEqual(['CREW-257', 'CREW-646']);
  });
});

describe('texts', () => {
  const match = findHeldMatches(extractWorkRefs('PR #1138'), [CREW_257])[0];

  it('linked reason and description note name the root ticket and the allowed actions', () => {
    expect(linkedHoldReason(match)).toMatch(/^held by CREW-257: HOLD: PR #1138/);
    expect(linkedHoldReason({ ...match, ticketId: 'CREW-646', hold: { reason: 'held by CREW-257: x', source: 'field', heldBy: 'CREW-257' } })).toBe('held by CREW-257: x');
    expect(heldDescriptionNote(match)).toContain('ON HOLD (CREW-257');
    expect(heldDescriptionNote(match)).toContain('close the PR and remove the worktree only');
    expect(heldWorktreeNoticeLine(match)).toContain('do not open a new ticket');
  });
});

describe('decision cards', () => {
  const matches = findHeldMatches(extractWorkRefs('PR #1138'), [CREW_257]);

  it('refuses the D-822 merge card, quoting the hold', () => {
    const refusal = decisionHoldRefusal('Merge PR #1138? Sam reviewed it, tests pass\nYes, merge\nNot now\nRemind me tomorrow', matches);
    expect(refusal).toContain('CREW-257 is on hold');
    expect(refusal).toContain('do not ask Steve to merge');
  });

  it('refuses a card that is not about closing (continue / anything else)', () => {
    expect(decisionHoldRefusal('Should Sam keep working on PR #1138?\nYes\nNo', matches)).not.toBeNull();
  });

  it('allows a close-only card, even one quoting "do not merge"', () => {
    expect(decisionHoldRefusal('Close PR #1138? You said do not merge it.\nYes, close it\nNot now', matches)).toBeNull();
    expect(isCloseOnlyAsk('要不要关闭 PR #1138？你说过不要合并')).toBe(true);
    expect(isCloseOnlyAsk('Close or merge PR #1138?')).toBe(false);
  });

  it('allows anything when nothing is held', () => {
    expect(decisionHoldRefusal('Merge PR #1?', [])).toBeNull();
  });
});
