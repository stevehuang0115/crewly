/**
 * Tests for the ticket autopilot's pure decisions: which tickets need triage,
 * when to wake the driver, and when to message the owner.
 */
import { TICKET_AUTOPILOT_CONSTANTS as C } from '../../constants.js';
import type { ProjectTicket } from '../../types/project-ticket.types.js';
import type { Team, TeamMember } from '../../types/index.js';
import {
  closedTicketsSince,
  decideDigest,
  decideReplan,
  decideTriage,
  nextReplanBackoff,
  replanBackoffDays,
  replanBackoffState,
  hasPossibleTaker,
  inFlightByAssignee,
  isMemberIdle,
  isWorkerCreated,
  localDateKey,
  localMidnight,
  memberAvailability,
  memberResponsibility,
  readOwnerQuestion,
  selectTriageCandidates,
  type ReplanDecisionInput,
  type TriageDecisionInput,
} from './ticket-autopilot-decision.js';

const NOW = new Date(2026, 8, 30, 10, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function member(id: string, sessionName: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, name: id, sessionName, role: 'developer', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '', ...extra } as TeamMember;
}

const teams: Team[] = [
  {
    id: 't1',
    name: 'CE',
    members: [member('m-lead', 'ce-owen', { role: 'team-leader' }), member('m-dev', 'ce-dev')],
    projectIds: ['p1'],
    createdAt: '',
    updatedAt: '',
  },
  { id: 't-solo-lead', name: 'Ops', members: [member('m-ops', 'ops-lead', { role: 'team-leader' }), member('m-ops2', 'ops-2', { role: 'team-leader' })], projectIds: ['p1'], createdAt: '', updatedAt: '' },
];

function ticket(id: string, extra: Partial<ProjectTicket> = {}): ProjectTicket {
  const at = new Date(NOW - 2 * HOUR).toISOString();
  return {
    id,
    title: `Ticket ${id}`,
    status: 'backlog',
    priority: 'P2',
    assignee: null,
    team: null,
    labels: [],
    ownerReview: false,
    createdAt: at,
    updatedAt: at,
    workItemId: null,
    requestId: null,
    source: 'owner',
    migratedFrom: null,
    fileName: `${id}.md`,
    filePath: `/x/${id}.md`,
    projectPath: '/x',
    description: '',
    acceptance: [],
    log: [],
    extra: {},
    ...extra,
  };
}

function base(extra: Partial<TriageDecisionInput> = {}): TriageDecisionInput {
  return {
    enabled: true,
    driver: 'ce-owen',
    trigger: 'tick',
    now: NOW,
    candidateCount: 3,
    liveTriage: false,
    anyoneIdle: true,
    usedTodayTokens: 1_000_000,
    dailyBudgetTokens: 20_000_000,
    ...extra,
  };
}

describe('decideReplan (specs/2026-10-04-autopilot-goal-replan.md)', () => {
  function replan(extra: Partial<ReplanDecisionInput> = {}): ReplanDecisionInput {
    return {
      enabled: true,
      driver: 'ce-owen',
      hasGoal: true,
      backedOff: false,
      maxReplansPerDay: 1,
      replansToday: 0,
      usedTodayTokens: 0,
      dailyBudgetTokens: 50_000_000,
      liveTriage: false,
      liveReplan: false,
      candidateCount: 0,
      anyoneIdle: true,
      idleWithRoom: true,
      ...extra,
    };
  }

  it('replans when on + goal + nothing to triage + someone idle + not replanned today', () => {
    expect(decideReplan(replan())).toEqual({ action: 'replan' });
  });

  it.each([
    [{ enabled: false }, 'off'],
    [{ driver: null }, 'no_driver'],
    [{ hasGoal: false }, 'no_goal'],
    [{ backedOff: true }, 'backed_off'],
    [{ maxReplansPerDay: 0 }, 'replan_off'],
    [{ usedTodayTokens: 50_000_000 }, 'budget_reached'],
    [{ liveTriage: true }, 'triage_in_flight'],
    [{ liveReplan: true }, 'replan_in_flight'],
    [{ candidateCount: 1 }, 'tickets_to_triage'],
    [{ anyoneIdle: false, idleWithRoom: false }, 'nobody_idle'],
    [{ idleWithRoom: false }, 'at_capacity'],
    [{ replansToday: 1 }, 'replanned_today'],
  ] as Array<[Partial<ReplanDecisionInput>, string]>)('skips %j → %s', (extra, reason) => {
    expect(decideReplan(replan(extra))).toEqual({ action: 'skip', reason });
  });

  it('checks the cheap gates first and the goal last (the only one that reads files)', () => {
    const all: Partial<ReplanDecisionInput> = { hasGoal: false, backedOff: true, usedTodayTokens: 99e9, liveTriage: true, candidateCount: 3, anyoneIdle: false, replansToday: 9 };
    expect(decideReplan(replan({ ...all, enabled: false }))).toEqual({ action: 'skip', reason: 'off' });
    expect(decideReplan(replan({ ...all, maxReplansPerDay: 0 }))).toEqual({ action: 'skip', reason: 'replan_off' });
    expect(decideReplan(replan(all))).toEqual({ action: 'skip', reason: 'budget_reached' });
    expect(decideReplan(replan({ hasGoal: false, backedOff: true, idleWithRoom: false }))).toEqual({ action: 'skip', reason: 'at_capacity' });
    expect(decideReplan(replan({ hasGoal: false, backedOff: true, replansToday: 1 }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    expect(decideReplan(replan({ hasGoal: false, backedOff: true }))).toEqual({ action: 'skip', reason: 'backed_off' });
  });

  it('honours a configurable daily limit, and an unlimited-today budget', () => {
    expect(decideReplan(replan({ maxReplansPerDay: 3, replansToday: 2 }))).toEqual({ action: 'replan' });
    expect(decideReplan(replan({ maxReplansPerDay: 3, replansToday: 3 }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    expect(decideReplan(replan({ usedTodayTokens: 900_000_000, dailyBudgetTokens: Infinity }))).toEqual({ action: 'replan' });
  });
});

describe('replan backoff (review fix: no daily drip once the goal is met)', () => {
  const day = '2026-09-30';
  const replanAt = NOW;

  it('skips 2 days, then 4, then 7 (capped)', () => {
    expect([1, 2, 3, 4, 9].map(replanBackoffDays)).toEqual([2, 4, 7, 7, 7]);
  });

  it('a replan that opened no tickets backs off one step longer; one that opened a ticket clears it', () => {
    const first = nextReplanBackoff({ replanAt, replanDay: day, tickets: [ticket('OLD', { createdAt: new Date(NOW - HOUR).toISOString() })], now: NOW + HOUR });
    expect(first).toEqual({ streak: 1, since: NOW + HOUR, resumeDay: '2026-10-03' }); // skips 10-01, 10-02
    const second = nextReplanBackoff({ replanAt, replanDay: '2026-10-03', tickets: [], previous: first, now: NOW });
    expect(second?.resumeDay).toBe('2026-10-08'); // skips 4 days
    const third = nextReplanBackoff({ replanAt, replanDay: '2026-10-08', tickets: [], previous: second, now: NOW });
    expect(third).toMatchObject({ streak: 3, resumeDay: '2026-10-16' }); // skips 7 days
    expect(nextReplanBackoff({ replanAt, replanDay: day, tickets: [ticket('NEW', { createdAt: new Date(NOW + MIN).toISOString() })], previous: third, now: NOW })).toBeNull();
  });

  it('holds until its day, is lifted by a new ticket or a goal change, and is none without one', () => {
    const b = { streak: 1, since: NOW, resumeDay: '2026-10-03' };
    expect(replanBackoffState(undefined, { today: '2026-10-01', tickets: [] })).toBe('none');
    expect(replanBackoffState(b, { today: '2026-10-02', tickets: [ticket('A', { createdAt: new Date(NOW - MIN).toISOString() })] })).toBe('holds');
    expect(replanBackoffState(b, { today: '2026-10-03', tickets: [] })).toBe('elapsed');
    expect(replanBackoffState(b, { today: '2026-10-01', tickets: [ticket('B', { createdAt: new Date(NOW + MIN).toISOString() })] })).toBe('lifted');
    expect(replanBackoffState(b, { today: '2026-10-01', tickets: [], goalChangedAt: NOW + MIN })).toBe('lifted');
    expect(replanBackoffState(b, { today: '2026-10-01', tickets: [], goalChangedAt: NOW - MIN })).toBe('holds');
  });
});

describe('closedTicketsSince', () => {
  it('lists done and cancelled tickets changed since the bound, newest first, capped', () => {
    const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
    const list = [
      ticket('A', { status: 'done', updatedAt: at(5) }),
      ticket('B', { status: 'cancelled', updatedAt: at(1) }),
      ticket('C', { status: 'done', updatedAt: at(24 * 9) }),
      ticket('D', { status: 'in_progress', updatedAt: at(1) }),
      ticket('E', { status: 'done', updatedAt: at(2) }),
    ];
    expect(closedTicketsSince(list, NOW - 7 * 24 * HOUR, 10).map((t) => t.id)).toEqual(['B', 'E', 'A']);
    expect(closedTicketsSince(list, NOW - 7 * 24 * HOUR, 2).map((t) => t.id)).toEqual(['B', 'E']);
  });
});

describe('decideTriage', () => {
  it('triages when on, someone is idle and there is something to triage', () => {
    expect(decideTriage(base())).toEqual({ action: 'triage' });
  });

  it.each([
    [{ enabled: false }, 'off'],
    [{ driver: null }, 'no_driver'],
    [{ usedTodayTokens: 20_000_000 }, 'budget_reached'],
    [{ liveTriage: true }, 'triage_in_flight'],
    [{ liveReplanAt: NOW - 10 * MIN }, 'replan_in_flight'],
    [{ candidateCount: 0 }, 'nothing_to_triage'],
    [{ anyoneIdle: false }, 'nobody_idle'],
  ] as Array<[Partial<TriageDecisionInput>, string]>)('skips %j → %s', (extra, reason) => {
    expect(decideTriage(base(extra))).toEqual({ action: 'skip', reason });
  });

  it('a live replan holds triage, but yields after an hour once there are tickets to triage', () => {
    expect(decideTriage(base({ liveReplanAt: NOW - 59 * MIN }))).toEqual({ action: 'skip', reason: 'replan_in_flight' });
    expect(decideTriage(base({ liveReplanAt: NOW - C.REPLAN_YIELD_AFTER_MS }))).toEqual({ action: 'triage' });
    expect(decideTriage(base({ liveReplanAt: NOW - 5 * HOUR, candidateCount: 0 }))).toEqual({ action: 'skip', reason: 'replan_in_flight' });
  });

  it('an unlimited-today budget (a boost) never pauses', () => {
    expect(decideTriage(base({ usedTodayTokens: 900_000_000, dailyBudgetTokens: Infinity }))).toEqual({ action: 'triage' });
  });

  it('debounces the periodic tick to 30 minutes', () => {
    expect(decideTriage(base({ lastTriageAt: NOW - 29 * MIN }))).toEqual({ action: 'skip', reason: 'too_soon' });
    expect(decideTriage(base({ lastTriageAt: NOW - 30 * MIN }))).toEqual({ action: 'triage' });
  });

  it('lets a member going idle re-trigger sooner, but not in a loop', () => {
    expect(decideTriage(base({ trigger: 'member_idle', lastTriageAt: NOW - 10 * MIN }))).toEqual({ action: 'triage' });
    expect(decideTriage(base({ trigger: 'member_idle', lastTriageAt: NOW - C.IDLE_TRIGGER_MIN_INTERVAL_MS + 1 }))).toEqual({
      action: 'skip',
      reason: 'too_soon',
    });
  });

  it('checks the budget before anything else that could wake the driver', () => {
    expect(decideTriage(base({ usedTodayTokens: 25_000_000, liveTriage: true }))).toEqual({ action: 'skip', reason: 'budget_reached' });
  });
});

describe('selectTriageCandidates', () => {
  it('lists backlog tickets, skipping those waiting on the owner and closed ones', () => {
    const { candidates } = selectTriageCandidates({
      tickets: [
        ticket('CE-1'),
        ticket('CE-2', { labels: [C.NEEDS_OWNER_LABEL] }),
        ticket('CE-3', { status: 'done' }),
        ticket('CE-4', { status: 'in_progress', assignee: 'ce-dev' }),
      ],
      teams,
      now: NOW,
    });
    expect(candidates.map((c) => [c.ticket.id, c.reason])).toEqual([['CE-1', 'backlog']]);
  });

  it('flags worker-created tickets for review, not lead / orc / owner ones', () => {
    const { candidates } = selectTriageCandidates({
      tickets: [
        ticket('CE-1', { source: 'agent:ce-dev' }),
        ticket('CE-2', { source: 'agent:ce-owen' }),
        ticket('CE-3', { source: 'agent:crewly-orc' }),
        ticket('CE-4', { source: 'request:TKT-7' }),
      ],
      teams,
      now: NOW,
    });
    expect(Object.fromEntries(candidates.map((c) => [c.ticket.id, c.workerCreated]))).toEqual({ 'CE-1': true, 'CE-2': false, 'CE-3': false, 'CE-4': false });
  });

  it('lists ready tickets nobody can take, and ready tickets untouched for a day', () => {
    const { candidates } = selectTriageCandidates({
      tickets: [
        ticket('CE-1', { status: 'ready' }),
        ticket('CE-2', { status: 'ready', team: 't-solo-lead' }),
        ticket('CE-3', { status: 'ready', updatedAt: new Date(NOW - C.READY_STALE_MS).toISOString() }),
      ],
      teams,
      now: NOW,
    });
    expect(candidates.map((c) => [c.ticket.id, c.reason])).toEqual([
      ['CE-2', 'ready_no_taker'],
      ['CE-3', 'ready_stale'],
    ]);
  });

  it('does not re-list an unchanged ticket until the relist window passed', () => {
    const t = ticket('CE-1');
    const listed = { 'CE-1': { updatedAt: t.updatedAt, at: NOW - HOUR } };
    expect(selectTriageCandidates({ tickets: [t], teams, now: NOW, listed }).candidates).toHaveLength(0);
    expect(selectTriageCandidates({ tickets: [t], teams, now: NOW + C.TRIAGE_RELIST_AFTER_MS, listed }).candidates).toHaveLength(1);
    const changed = { ...t, updatedAt: new Date(NOW).toISOString() };
    expect(selectTriageCandidates({ tickets: [changed], teams, now: NOW, listed }).candidates).toHaveLength(1);
  });

  it('orders by priority then age and caps the brief', () => {
    const many = Array.from({ length: C.TRIAGE_MAX_TICKETS + 3 }, (_, i) => ticket(`CE-${i + 1}`, { createdAt: new Date(NOW - i * MIN).toISOString() }));
    many.push(ticket('CE-99', { priority: 'P0' }));
    const { candidates, more } = selectTriageCandidates({ tickets: many, teams, now: NOW });
    expect(candidates).toHaveLength(C.TRIAGE_MAX_TICKETS);
    expect(more).toBe(4);
    expect(candidates[0].ticket.id).toBe('CE-99');
    expect(candidates[1].ticket.id).toBe(`CE-${C.TRIAGE_MAX_TICKETS + 3}`);
  });
});

describe('helpers', () => {
  it('reads the latest owner question from the Log', () => {
    expect(readOwnerQuestion(ticket('CE-1', { log: ['a · tl · owner question: Old?', 'b · tl · owner question: Send it now?'] }))).toBe('Send it now?');
    expect(readOwnerQuestion(ticket('CE-1', { log: ['a · owner · created'] }))).toBeNull();
  });

  it('knows who could take a ready ticket', () => {
    expect(hasPossibleTaker({ team: null }, teams)).toBe(true);
    expect(hasPossibleTaker({ team: 't-solo-lead' }, teams)).toBe(false);
    expect(hasPossibleTaker({ team: 'gone' }, teams)).toBe(false);
  });

  it('tells idle members and counts in-flight tickets', () => {
    expect(isMemberIdle({ agentStatus: 'active', workingStatus: 'idle' })).toBe(true);
    expect(isMemberIdle({ agentStatus: 'inactive', workingStatus: 'idle' })).toBe(false);
    expect(isMemberIdle({ agentStatus: 'active', workingStatus: 'in_progress' })).toBe(false);
    const counts = inFlightByAssignee([ticket('A', { status: 'in_progress', assignee: 'x' }), ticket('B', { status: 'ready', assignee: 'x' })]);
    expect(counts.get('x')).toBe(1);
    expect(isWorkerCreated({ source: null }, teams)).toBe(false);
  });

  it('tells idle, working and stopped apart — stopped is never busy', () => {
    expect(memberAvailability({ agentStatus: 'active', workingStatus: 'idle' })).toBe('idle');
    expect(memberAvailability({ agentStatus: 'started', workingStatus: 'idle' })).toBe('idle');
    expect(memberAvailability({ agentStatus: 'starting', workingStatus: 'idle' })).toBe('idle');
    expect(memberAvailability({ agentStatus: 'active', workingStatus: 'in_progress' })).toBe('working');
    // Nova in the CE incident: idle-stopped, workingStatus left at idle.
    expect(memberAvailability({ agentStatus: 'inactive', workingStatus: 'idle' })).toBe('stopped');
    expect(memberAvailability({ agentStatus: 'inactive', workingStatus: 'in_progress' })).toBe('stopped');
    expect(memberAvailability({ agentStatus: 'suspended', workingStatus: 'idle' })).toBe('stopped');
  });

  it('gives each member a one-line responsibility: own job description, role description, built-in line', () => {
    expect(memberResponsibility({ role: 'developer', jobDescription: 'Owns the visa pages' }, 'Software developer')).toBe('Owns the visa pages');
    expect(memberResponsibility({ role: 'developer' }, 'Software developer')).toBe('Software developer');
    expect(memberResponsibility({ role: 'content-strategist' as TeamMember['role'] })).toMatch(/articles.*images/);
    expect(memberResponsibility({ role: 'tech-lead' })).toMatch(/Leads the team/);
    expect(memberResponsibility({ role: 'mystery' as TeamMember['role'] })).toBeUndefined();
  });

  it('computes local midnight and date keys', () => {
    const d = new Date(2026, 8, 30, 23, 30);
    expect(localMidnight(d).getTime()).toBe(new Date(2026, 8, 30).getTime());
    expect(localDateKey(d)).toBe('2026-09-30');
  });
});

describe('decideDigest', () => {
  const evening = new Date(2026, 8, 30, 21, 5);
  const changed = evening.getTime() - HOUR;

  it('waits for the evening hour', () => {
    expect(decideDigest({ now: new Date(2026, 8, 30, 20, 59), latestTicketChangeAt: changed }).reason).toBe('not_yet');
  });

  it('sends once per day when something changed', () => {
    expect(decideDigest({ now: evening, latestTicketChangeAt: changed })).toEqual({ send: true, reason: 'due' });
    expect(decideDigest({ now: evening, lastSentDate: '2026-09-30', latestTicketChangeAt: changed }).reason).toBe('already_sent');
  });

  it('skips when nothing changed since the last digest', () => {
    const yesterday = new Date(2026, 8, 29, 21, 0).getTime();
    expect(decideDigest({ now: evening, lastSentDate: '2026-09-29', lastSentAt: yesterday, latestTicketChangeAt: yesterday - HOUR }).reason).toBe(
      'nothing_changed',
    );
    expect(decideDigest({ now: evening, lastSentDate: '2026-09-29', lastSentAt: yesterday, latestTicketChangeAt: yesterday + HOUR }).send).toBe(true);
  });
});
