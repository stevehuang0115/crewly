import type { ProjectTicket } from '../../types/project-ticket.types.js';
import { checkDecisionHold, findHolds, findWorktreeHold, listHeldTickets } from './ticket-hold-registry.js';
import { extractWorkRefs } from './ticket-hold.js';

function ticket(over: Partial<ProjectTicket>): ProjectTicket {
  return {
    id: 'CREW-1',
    title: 't',
    status: 'backlog',
    priority: 'P2',
    assignee: null,
    team: null,
    labels: [],
    ownerReview: false,
    createdAt: '',
    updatedAt: '',
    workItemId: null,
    requestId: null,
    source: null,
    migratedFrom: null,
    fileName: 'x.md',
    filePath: '/p/x.md',
    projectPath: '/p',
    description: '',
    acceptance: [],
    log: [],
    extra: {},
    ...over,
  };
}

const CREW_257 = ticket({ id: 'CREW-257', title: 'Gmail approve-then-send', log: ['t · crewly-orc · HOLD: PR #1138: do not merge, do not ask Steve to merge'] });
const CREW_646 = ticket({ id: 'CREW-646', title: 'Decide the fate of OPEN PR #1138', hold: 'held by CREW-257: HOLD: PR #1138: do not merge' });
const FREE = ticket({ id: 'OTHER-1', projectPath: '/q', title: 'PR #5 review' });

const deps = {
  listProjectPaths: async () => ['/p', '/q', '/broken'],
  listTickets: async (p: string) => {
    if (p === '/broken') throw new Error('unreadable');
    return p === '/p' ? [CREW_257, CREW_646] : [FREE];
  },
};

describe('ticket hold registry', () => {
  it('lists held tickets across projects and skips unreadable ones', async () => {
    expect((await listHeldTickets(deps)).map((t) => t.id)).toEqual(['CREW-257', 'CREW-646']);
  });

  it('finds holds by refs; no refs = no lookup', async () => {
    expect((await findHolds(extractWorkRefs('PR #1138'), deps)).map((m) => m.ticketId)).toEqual(['CREW-257', 'CREW-646']);
    const listProjectPaths = jest.fn();
    expect(await findHolds(extractWorkRefs('nothing'), { ...deps, listProjectPaths })).toEqual([]);
    expect(listProjectPaths).not.toHaveBeenCalled();
  });

  it('finds the hold of the janitor worktree wt-crew257', async () => {
    expect((await findWorktreeHold('feat/gmail', '/x/wt-crew257', deps))?.ticketId).toBe('CREW-257');
    expect(await findWorktreeHold('feat/other', '/x/wt-other', deps)).toBeNull();
  });

  it('refuses the D-822 merge card on CREW-646 (its own ticket is held), allows a close card', async () => {
    const refusal = await checkDecisionHold({ text: 'Merge it?\nYes, merge\nNot now', context: 'Decide the fate of OPEN PR #1138', ticketId: 'CREW-646' }, deps);
    expect(refusal).toContain('CREW-257 is on hold');
    expect(refusal).toContain('do not ask Steve to merge');
    expect(await checkDecisionHold({ text: 'Close PR #1138?\nYes, close it\nNot now', ticketId: 'CREW-646' }, deps)).toBeNull();
    expect(await checkDecisionHold({ text: 'Merge PR #5?\nYes\nNo' }, deps)).toBeNull();
  });
});
