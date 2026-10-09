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
  countReplans,
  replanCeilingReached,
  effectiveReplanGapMs,
  decideTriage,
  nextReplanBackoff,
  classifyStopReason,
  findStalledWork,
  decideSelfReview,
  replanBackoffHolds,
  ticketMetricRef,
  type SelfReviewDecisionInput,
  type StopReasonInput,
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
  isParkedTicket,
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

  it('idle and empty: the mode gap is dropped, only the 10 min debounce applies; the cap still does', () => {
    const idle = { maxReplansPerDay: 4, minGapMs: 3 * HOUR, now: NOW, idleAndEmpty: true, idleReplanDebounceMs: 10 * MIN, replansToday: 1 };
    expect(decideReplan(replan({ ...idle, lastReplanAt: NOW - 2 * HOUR }))).toEqual({ action: 'replan' });
    expect(decideReplan(replan({ ...idle, lastReplanAt: NOW - 5 * MIN }))).toEqual({ action: 'skip', reason: 'replan_too_soon' });
    expect(decideReplan(replan({ ...idle, replansToday: 4, lastReplanAt: NOW - 2 * HOUR }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    expect(decideReplan(replan({ ...idle, backedOff: true, lastReplanAt: NOW - 2 * HOUR }))).toEqual({ action: 'skip', reason: 'backed_off' });
    // Work in flight: the gap holds.
    expect(decideReplan(replan({ ...idle, idleAndEmpty: false, lastReplanAt: NOW - 2 * HOUR }))).toEqual({ action: 'skip', reason: 'replan_too_soon' });
    expect(effectiveReplanGapMs(0, true, 10 * MIN)).toBe(0);
  });

  it('caps all replans of the day at the hard ceiling, never below the daily cap (CREW-265)', () => {
    expect(decideReplan(replan({ maxReplansPerDay: 4, replansToday: 1, replansTotalToday: 15, hardCeilingPerDay: 16 }))).toEqual({ action: 'replan' });
    expect(decideReplan(replan({ maxReplansPerDay: 4, replansToday: 1, replansTotalToday: 16, hardCeilingPerDay: 16 }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    // A cap above the ceiling wins.
    expect(replanCeilingReached(16, 20, 16)).toBe(false);
    expect(replanCeilingReached(20, 20, 16)).toBe(true);
    // No ceiling, no total: only the cap applies.
    expect(replanCeilingReached(99, 4, 0)).toBe(false);
    expect(replanCeilingReached(undefined, 4, 16)).toBe(false);
  });

  it('counts only replans that opened no tickets toward the daily cap (CREW-265)', () => {
    expect(countReplans(undefined, '2026-10-05')).toEqual({ total: 0, productive: 0, counted: 0 });
    expect(countReplans({ day: '2026-10-04', count: 4, productive: 3 }, '2026-10-05')).toEqual({ total: 0, productive: 0, counted: 0 });
    expect(countReplans({ day: '2026-10-05', count: 4 }, '2026-10-05')).toEqual({ total: 4, productive: 0, counted: 4 });
    expect(countReplans({ day: '2026-10-05', count: 4, productive: 4 }, '2026-10-05')).toEqual({ total: 4, productive: 4, counted: 0 });
    // Never more productive than total.
    expect(countReplans({ day: '2026-10-05', count: 2, productive: 5 }, '2026-10-05')).toEqual({ total: 2, productive: 2, counted: 0 });
  });

  it('honours a configurable daily limit, and an unlimited-today budget', () => {
    expect(decideReplan(replan({ maxReplansPerDay: 3, replansToday: 2 }))).toEqual({ action: 'replan' });
    expect(decideReplan(replan({ maxReplansPerDay: 3, replansToday: 3 }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    expect(decideReplan(replan({ usedTodayTokens: 900_000_000, dailyBudgetTokens: Infinity }))).toEqual({ action: 'replan' });
  });

  it('waits the speed mode\'s gap after the last replan (across days), after the daily cap', () => {
    const gap = { maxReplansPerDay: 4, minGapMs: 3 * HOUR, now: NOW };
    expect(decideReplan(replan({ ...gap, replansToday: 1, lastReplanAt: NOW - 2 * HOUR }))).toEqual({ action: 'skip', reason: 'replan_too_soon' });
    expect(decideReplan(replan({ ...gap, replansToday: 1, lastReplanAt: NOW - 3 * HOUR }))).toEqual({ action: 'replan' });
    // Yesterday's 23:30 replan still counts for today's 00:30 (0 replans today).
    expect(decideReplan(replan({ ...gap, replansToday: 0, lastReplanAt: NOW - HOUR }))).toEqual({ action: 'skip', reason: 'replan_too_soon' });
    expect(decideReplan(replan({ ...gap, replansToday: 4, lastReplanAt: NOW - HOUR }))).toEqual({ action: 'skip', reason: 'replanned_today' });
    // No gap (Chill) or no previous replan.
    expect(decideReplan(replan({ maxReplansPerDay: 1, minGapMs: 0, now: NOW, lastReplanAt: NOW - MIN }))).toEqual({ action: 'replan' });
    expect(decideReplan(replan({ ...gap }))).toEqual({ action: 'replan' });
  });
});

describe('replan backoff (review fix: no daily drip once the goal is met)', () => {
  const day = '2026-09-30';
  const replanAt = NOW;

  it('waits for the speed mode\'s retry after a replan that opened no tickets: 1 h / next day / next week', () => {
    const old = [ticket('OLD', { createdAt: new Date(NOW - HOUR).toISOString() })];
    const rush = nextReplanBackoff({ replanAt, replanDay: day, tickets: old, retry: { unit: 'hours', amount: 1 }, now: NOW + HOUR });
    expect(rush).toEqual({ streak: 1, since: NOW + HOUR, resumeAt: NOW + 2 * HOUR, resumeDay: day });
    const normal = nextReplanBackoff({ replanAt, replanDay: day, tickets: old, previous: rush, retry: { unit: 'days', amount: 1 }, now: NOW + HOUR });
    expect(normal).toEqual({ streak: 2, since: NOW + HOUR, resumeAt: new Date(2026, 9, 1, 0, 0).getTime(), resumeDay: '2026-10-01' });
    const chill = nextReplanBackoff({ replanAt, replanDay: day, tickets: old, retry: { unit: 'days', amount: 7 }, now: NOW });
    expect(chill).toMatchObject({ streak: 1, resumeDay: '2026-10-07' });
    // Default (no retry given): the next day.
    expect(nextReplanBackoff({ replanAt, replanDay: day, tickets: [], now: NOW })?.resumeDay).toBe('2026-10-01');
    expect(nextReplanBackoff({ replanAt, replanDay: day, tickets: [ticket('NEW', { createdAt: new Date(NOW + MIN).toISOString() })], previous: chill, now: NOW })).toBeNull();
  });

  it('a backoff with a resume time holds until that moment', () => {
    const b = { streak: 1, since: NOW, resumeDay: day, resumeAt: NOW + HOUR };
    expect(replanBackoffState(b, { today: day, tickets: [], now: NOW + 59 * MIN })).toBe('holds');
    expect(replanBackoffState(b, { today: day, tickets: [], now: NOW + HOUR })).toBe('elapsed');
    expect(replanBackoffHolds(b, NOW + 59 * MIN, day)).toBe(true);
    expect(replanBackoffHolds(b, NOW + HOUR, day)).toBe(false);
    // A backoff stored before speed modes (day only) still works.
    expect(replanBackoffHolds({ streak: 1, since: NOW, resumeDay: '2026-10-03' }, NOW, '2026-10-02')).toBe(true);
    expect(replanBackoffHolds(undefined, NOW, day)).toBe(false);
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

describe('selectTriageCandidates: parked / deferred tickets (#1029)', () => {
  const ids = (tickets: ProjectTicket[], extra: Record<string, unknown> = {}) =>
    selectTriageCandidates({ tickets, teams, now: NOW, ...extra }).candidates.map((c) => c.ticket.id);

  it('skips parked and deferred labels by default, in any case, in backlog and ready', () => {
    expect(
      ids([
        ticket('CE-1'),
        ticket('CE-2', { labels: ['parked'] }),
        ticket('CE-3', { labels: ['Deferred', 'ui'] }),
        ticket('CE-4', { status: 'ready', team: 't-solo-lead', labels: ['parked'] }),
      ]),
    ).toEqual(['CE-1']);
  });

  it('honours a per-project skip-label list (and an empty list skips nothing)', () => {
    const tickets = [ticket('CE-1', { labels: ['parked'] }), ticket('CE-2', { labels: ['later'] })];
    expect(ids(tickets, { skipLabels: ['later'] })).toEqual(['CE-1']);
    expect(ids(tickets, { skipLabels: [] })).toEqual(['CE-1', 'CE-2']);
  });

  it('skips a ticket until its deferUntil date, then offers it again', () => {
    const until = new Date(NOW + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const t = ticket('CE-1', { deferUntil: until });
    expect(selectTriageCandidates({ tickets: [t], teams, now: NOW }).candidates).toHaveLength(0);
    expect(selectTriageCandidates({ tickets: [t], teams, now: Date.parse(until) }).candidates).toHaveLength(1);
    expect(selectTriageCandidates({ tickets: [t], teams, now: Date.parse(until) + 1000 }).candidates).toHaveLength(1);
  });

  it('ignores an unreadable deferUntil and a null one', () => {
    expect(ids([ticket('CE-1', { deferUntil: 'soon' }), ticket('CE-2', { deferUntil: null })])).toEqual(['CE-1', 'CE-2']);
  });

  it('isParkedTicket reports the same rule', () => {
    expect(isParkedTicket({ labels: ['parked'], deferUntil: null }, NOW)).toBe(true);
    expect(isParkedTicket({ labels: [], deferUntil: '2999-01-01' }, NOW)).toBe(true);
    expect(isParkedTicket({ labels: [], deferUntil: '2000-01-01' }, NOW)).toBe(false);
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

describe('classifyStopReason (specs/2026-10-04-autopilot-speed-modes.md)', () => {
  function input(extra: Partial<StopReasonInput> = {}): StopReasonInput {
    return {
      teamsTotal: 1,
      teamsActive: 1,
      usedTodayTokens: 0,
      dailyBudgetTokens: 1000,
      inProgress: 0,
      ready: 0,
      toTriage: 0,
      liveAutopilotItem: false,
      failedRecently: 0,
      stuckDelivery: false,
      waitingOnOwner: 0,
      emptyReplanBackoff: false,
      ...extra,
    };
  }

  it('is running (no reason) while work moves', () => {
    for (const extra of [{ inProgress: 1 }, { ready: 2 }, { toTriage: 1 }, { liveAutopilotItem: true }]) {
      expect(classifyStopReason(input({ ...extra, waitingOnOwner: 3, emptyReplanBackoff: true, failedRecently: 1 }))).toEqual({ running: true, reason: null });
    }
  });

  it.each([
    [{ teamsActive: 0 }, 'paused'],
    [{ usedTodayTokens: 1000 }, 'budget_reached'],
    [{ stuckDelivery: true, liveAutopilotItem: true }, 'system_error'],
    [{ failedRecently: 2 }, 'system_error'],
    [{ waitingOnOwner: 1 }, 'waiting_on_owner'],
    [{ emptyReplanBackoff: true }, 'no_ideas'],
    [{ replanCapReached: true }, 'daily_replan_cap'],
    [{ replanWaitUntil: 123 }, 'waiting_for_replan'],
  ] as Array<[Partial<StopReasonInput>, string]>)('%j → %s', (extra, reason) => {
    const got = classifyStopReason(input(extra));
    expect(got).toMatchObject({ running: false, reason });
    if (reason === 'waiting_for_replan') expect(got.until).toBe(123);
  });

  it('the replan cap outranks waiting; no_ideas outranks both', () => {
    expect(classifyStopReason(input({ replanCapReached: true, replanWaitUntil: 5 })).reason).toBe('daily_replan_cap');
    expect(classifyStopReason(input({ emptyReplanBackoff: true, replanCapReached: true })).reason).toBe('no_ideas');
  });

  it('most decisive first: paused > budget > system error > waiting on the owner > no ideas', () => {
    const all = { teamsActive: 0, usedTodayTokens: 5000, failedRecently: 1, waitingOnOwner: 1, emptyReplanBackoff: true };
    expect(classifyStopReason(input(all)).reason).toBe('paused');
    expect(classifyStopReason(input({ ...all, teamsActive: 1 })).reason).toBe('budget_reached');
    expect(classifyStopReason(input({ ...all, teamsActive: 1, usedTodayTokens: 0 })).reason).toBe('system_error');
    expect(classifyStopReason(input({ waitingOnOwner: 1, emptyReplanBackoff: true })).reason).toBe('waiting_on_owner');
    // A paused project with work in flight is still "paused"; no teams at all is not.
    expect(classifyStopReason(input({ teamsActive: 0, inProgress: 2 })).reason).toBe('paused');
    expect(classifyStopReason(input({ teamsTotal: 0, teamsActive: 0 }))).toEqual({ running: false, reason: null });
    // Stopped for none of the named reasons (between replans).
    expect(classifyStopReason(input())).toEqual({ running: false, reason: null });
  });
});

describe('decideSelfReview', () => {
  function input(extra: Partial<SelfReviewDecisionInput> = {}): SelfReviewDecisionInput {
    return { enabled: true, driver: 'ce-owen', now: NOW, everyMs: HOUR, live: false, usedTodayTokens: 0, dailyBudgetTokens: 1000, changed: true, anyoneIdle: false, ...extra };
  }

  it('asks at the cadence when something changed or someone is idle', () => {
    expect(decideSelfReview(input())).toEqual({ action: 'review' });
    expect(decideSelfReview(input({ lastAskedAt: NOW - HOUR }))).toEqual({ action: 'review' });
    expect(decideSelfReview(input({ changed: false, anyoneIdle: true, lastAskedAt: NOW - HOUR }))).toEqual({ action: 'review' });
  });

  it.each([
    [{ enabled: false }, 'off'],
    [{ driver: null }, 'no_driver'],
    [{ usedTodayTokens: 1000 }, 'budget_reached'],
    [{ lastAskedAt: NOW - 59 * MIN }, 'not_due'],
    [{ live: true }, 'in_flight'],
    [{ changed: false, anyoneIdle: false, lastAskedAt: NOW - 2 * HOUR }, 'unchanged'],
  ] as Array<[Partial<SelfReviewDecisionInput>, string]>)('skips %j → %s', (extra, reason) => {
    expect(decideSelfReview(input(extra))).toEqual({ action: 'skip', reason });
  });
});

describe('ticketMetricRef', () => {
  it('reads --metric or a "Metric:" line in the description', () => {
    expect(ticketMetricRef({ metric: '  weekly visitors → +150 ' })).toBe('weekly visitors → +150');
    expect(ticketMetricRef({ description: 'Why.\n\n**Metric:** returning visitors → +5%' })).toBe('returning visitors → +5%');
    expect(ticketMetricRef({ description: '- metric: signups +10/week' })).toBe('signups +10/week');
    expect(ticketMetricRef({ description: 'Metric：周访客 +150' })).toBe('周访客 +150');
  });

  it('is null without one, or when it is too short to name anything', () => {
    expect(ticketMetricRef({})).toBeNull();
    expect(ticketMetricRef({ description: 'Improves metrics a lot' })).toBeNull();
    expect(ticketMetricRef({ metric: 'x' })).toBeNull();
    expect(ticketMetricRef({ description: 'Metric: ?' })).toBeNull();
  });
});

describe('findStalledWork (CE 2026-10-05: in progress, assignee idle, nothing moving)', () => {
  const now = Date.UTC(2026, 9, 5, 16, 50);
  const ticket = (extra: Partial<ProjectTicket> = {}) =>
    ({ id: 'CE-128', status: 'in_progress', assignee: 'ce-vera', workItemId: 'wi-1', updatedAt: '2026-10-05T15:36:52.121Z', labels: [], ...extra }) as ProjectTicket;
  const vera = (extra: Partial<TeamMember> = {}) => ({ sessionName: 'ce-vera', agentStatus: 'active', workingStatus: 'idle', ...extra }) as TeamMember;
  const items = new Map([['wi-1', { status: 'queued', target: 'ce-vera', createdAt: '2026-10-05T15:36:41.288Z' }]]);
  const base = { now, stallAfterMs: 20 * 60_000, maxRedeliveries: 2 };

  it('finds the incident ticket and re-delivers first, releases once re-deliveries are used up', () => {
    expect(findStalledWork({ ...base, tickets: [ticket()], members: [vera()], items })).toEqual([
      expect.objectContaining({ ticketId: 'CE-128', session: 'ce-vera', workItemId: 'wi-1', action: 'redeliver' }),
    ]);
    const stalls = { 'CE-128': { count: 2, lastAt: now - 21 * 60_000 } };
    expect(findStalledWork({ ...base, tickets: [ticket()], members: [vera()], items, stalls })[0].action).toBe('release');
  });

  it('CREW-394: releases on consecutive failed pushes with the delivery cause, not the stall cause', () => {
    const t0 = now - 21 * 60_000;
    const run = (stall: { count: number; lastAt: number; failures?: number }) =>
      findStalledWork({ ...base, tickets: [ticket()], members: [vera()], items, stalls: { 'CE-128': stall } })[0];
    expect(run({ count: 0, lastAt: t0, failures: 1 })).toMatchObject({ action: 'redeliver' });
    expect(run({ count: 0, lastAt: t0, failures: 2 })).toMatchObject({ action: 'release', releaseCause: 'delivery', deliveryFailures: 2 });
    expect(run({ count: 2, lastAt: t0 })).toMatchObject({ action: 'release', releaseCause: 'stalled' });
    // a delivered push resets failures to 0 (the service drops the field): back to counting stalls only
    expect(run({ count: 1, lastAt: t0 })).toMatchObject({ action: 'redeliver' });
    // failures recorded before the ticket last moved do not count
    expect(run({ count: 0, lastAt: Date.parse('2026-10-05T15:30:00Z'), failures: 5 })).toMatchObject({ action: 'redeliver' });
  });

  it('CREW-394: a brief that keeps waiting on the queue is released as busy, not endless and not a stall', () => {
    const t0 = now - 21 * 60_000;
    const run = (stall: { count: number; lastAt: number; failures?: number; waiting?: number }) =>
      findStalledWork({ ...base, tickets: [ticket()], members: [vera()], items, stalls: { 'CE-128': stall } })[0];
    expect(run({ count: 0, lastAt: t0, waiting: 1 })).toMatchObject({ action: 'redeliver' });
    expect(run({ count: 0, lastAt: t0, waiting: 2 })).toMatchObject({ action: 'release', releaseCause: 'busy', waitingPushes: 2 });
    // waiting recorded before the ticket last moved does not count
    expect(run({ count: 0, lastAt: Date.parse('2026-10-05T15:30:00Z'), waiting: 5 })).toMatchObject({ action: 'redeliver' });
  });

  it('skips a busy, registering or stopped assignee, a finished WorkItem and a parked ticket', () => {
    for (const m of [vera({ workingStatus: 'in_progress' }), vera({ agentStatus: 'started' }), vera({ agentStatus: 'inactive' })]) {
      expect(findStalledWork({ ...base, tickets: [ticket()], members: [m], items })).toEqual([]);
    }
    expect(findStalledWork({ ...base, tickets: [ticket()], members: [vera()], items: new Map([['wi-1', { status: 'done' }]]) })).toEqual([]);
    expect(findStalledWork({ ...base, tickets: [ticket({ labels: ['parked'] })], members: [vera()], items, skipLabels: ['parked'] })).toEqual([]);
  });

  it('stalled work stops "in progress" from counting as running', () => {
    const r = classifyStopReason({
      teamsTotal: 1, teamsActive: 1, usedTodayTokens: 0, dailyBudgetTokens: 1000, inProgress: 2, ready: 1, toTriage: 0,
      liveAutopilotItem: false, failedRecently: 0, stuckDelivery: false, waitingOnOwner: 0, emptyReplanBackoff: false, stalledWork: 2,
    });
    expect(r).toEqual({ running: false, reason: 'stalled_work' });
  });
});
