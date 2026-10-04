/**
 * Tests for the team-lead execution nudge, its counts and kept-work records
 * (crewly#1083).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TL_DELEGATION_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import {
  buildNudgeText,
  leadContextFromTeams,
  localDayKey,
  memberAvailability,
  rankMembersForNudge,
  TlDelegationService,
  type LeadContext,
} from './tl-delegation.service.js';

const MIN = 60 * 1000;
const silent = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as never;

const LEAD: LeadContext = {
  teamId: 't-think',
  teamName: 'Think Tank',
  members: [
    { name: 'Kai', role: 'researcher', availability: 'working' },
    { name: 'Sage', role: 'researcher', availability: 'idle' },
    { name: 'Nova', role: 'designer', availability: 'stopped' },
    { name: 'Rex', role: 'developer', availability: 'idle' },
  ],
};

describe('TlDelegationService', () => {
  let dir: string;
  let now: number;
  let leadContext: jest.Mock;
  let svc: TlDelegationService;

  const make = () =>
    new TlDelegationService({ leadContext, statePath: path.join(dir, 'tl-delegation.json'), now: () => now, logger: silent });

  const edit = (session = 'tt-atlas', tool = 'Edit') => svc.observeToolUse(session, tool);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-deleg-'));
    now = new Date(2026, 9, 4, 12, 0, 0).getTime();
    leadContext = jest.fn(async (s: string) => (s === 'tt-atlas' ? LEAD : null));
    svc = make();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('nudges a lead at the edit threshold, naming idle members first', async () => {
    for (let i = 1; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) {
      expect(await edit()).toBeNull();
      now += MIN;
    }
    const note = await edit();
    expect(note).toContain(TL_DELEGATION_CONSTANTS.NUDGE_TAG);
    expect(note).toContain(`edited files ${TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD} times`);
    expect(note).toContain('Sage (researcher, idle), Rex (developer, idle), Nova (designer, stopped — starts when assigned)');
    expect(note).not.toContain('Kai');
    expect(svc.nudgeCounts(['tt-atlas']).total).toEqual({ count: 1, followed: 0 });
  });

  it('ignores tools that are not file edits', async () => {
    for (let i = 0; i < 20; i++) expect(await edit('tt-atlas', 'Bash')).toBeNull();
    expect(leadContext).not.toHaveBeenCalled();
  });

  it('only counts edits inside the window', async () => {
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD - 1; i++) await edit();
    now += TL_DELEGATION_CONSTANTS.WINDOW_MS + MIN;
    expect(await edit()).toBeNull();
  });

  it('nudges at most once per cooldown', async () => {
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) await edit();
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD * 2; i++) {
      now += MIN;
      expect(await edit()).toBeNull();
    }
    now += TL_DELEGATION_CONSTANTS.NUDGE_COOLDOWN_MS;
    let second: string | null = null;
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD && !second; i++) second = await edit();
    expect(second).toContain(TL_DELEGATION_CONSTANTS.NUDGE_TAG);
    expect(svc.nudgeCounts(['tt-atlas']).total.count).toBe(2);
  });

  it('never nudges a member that leads nothing', async () => {
    for (let i = 0; i < 20; i++) expect(await edit('tt-sage')).toBeNull();
  });

  it('never throws: a failing lookup means no nudge', async () => {
    leadContext.mockRejectedValue(new Error('storage down'));
    for (let i = 0; i < 10; i++) expect(await edit()).toBeNull();
  });

  it('counts a delegation soon after a nudge as following it, once', async () => {
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) await edit();
    now += 5 * MIN;
    expect(svc.recordDelegation('tt-atlas', 'tt-sage')).toBe(true);
    expect(svc.recordDelegation('tt-atlas', 'tt-sage')).toBe(false);
    expect(svc.nudgeCounts(['tt-atlas'])).toEqual({ total: { count: 1, followed: 1 }, day: { count: 1, followed: 1 } });
  });

  it('does not count a late delegation or one to itself', async () => {
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) await edit();
    expect(svc.recordDelegation('tt-atlas', 'tt-atlas')).toBe(false);
    now += TL_DELEGATION_CONSTANTS.FOLLOW_WINDOW_MS + MIN;
    expect(svc.recordDelegation('tt-atlas', 'tt-sage')).toBe(false);
    expect(svc.nudgeCounts(['tt-atlas']).total.followed).toBe(0);
  });

  it('records kept work and filters it by team or session', () => {
    svc.recordKeptWork({ session: 'tt-atlas', teamId: 't-think', reason: '  needs the\nVercel  login ', work: 'Deploy preview', workItemId: 'wi-1' });
    now += MIN;
    svc.recordKeptWork({ session: 'mk-ella', teamId: 't-mkt', reason: 'everyone busy', work: 'Post' });
    const mine = svc.keptWorkSince(0, { teamId: 't-think' });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ session: 'tt-atlas', reason: 'needs the Vercel login', work: 'Deploy preview', workItemId: 'wi-1' });
    expect(svc.keptWorkSince(0, { sessions: ['mk-ella'] })).toHaveLength(1);
    expect(svc.keptWorkSince(now + 1)).toHaveLength(0);
  });

  it('persists counts and records across instances', async () => {
    for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) await edit();
    svc.recordKeptWork({ session: 'tt-atlas', reason: 'r', work: 'w' });
    await svc.flush();
    const again = make();
    expect(again.nudgeCounts(['tt-atlas']).total.count).toBe(1);
    expect(again.keptWorkSince(0)).toHaveLength(1);
  });

  it('starts empty on a broken state file', () => {
    fs.writeFileSync(path.join(dir, 'tl-delegation.json'), '{not json');
    expect(make().keptWorkSince(0)).toEqual([]);
  });
});

describe('nudge helpers', () => {
  it('ranks idle, then stopped, then working, capped', () => {
    expect(rankMembersForNudge(LEAD.members).map((m) => m.name)).toEqual(['Sage', 'Rex', 'Nova']);
  });

  it('the text names the delegate-task commands', () => {
    const text = buildNudgeText(6, LEAD.members);
    expect(text).toContain('--thread <key>');
    expect(text).toContain('--no-member-fits');
    expect(text).toContain('role is a preference, not a limit');
  });

  it('memberAvailability', () => {
    expect(memberAvailability({ agentStatus: 'inactive', workingStatus: 'idle' })).toBe('stopped');
    expect(memberAvailability({ agentStatus: 'active', workingStatus: 'in_progress' })).toBe('working');
    expect(memberAvailability({ agentStatus: 'started', workingStatus: 'idle' })).toBe('idle');
  });

  it('localDayKey', () => {
    expect(localDayKey(new Date(2026, 9, 4, 23, 59).getTime())).toBe('2026-10-04');
  });

  it('leadContextFromTeams finds the team the session leads', () => {
    const m = (over: Partial<TeamMember>) => ({ id: 'x', name: 'X', sessionName: 'x', role: 'developer', agentStatus: 'active', workingStatus: 'idle', ...over }) as TeamMember;
    const teams = [
      { id: 't1', name: 'Think Tank', leaderIds: ['a'], members: [m({ id: 'a', name: 'Atlas', sessionName: 'tt-atlas', role: 'team-leader' }), m({ id: 's', name: 'Sage', sessionName: 'tt-sage', role: 'researcher' as TeamMember['role'] })] },
      { id: 't2', name: 'Solo', leaderIds: ['b'], members: [m({ id: 'b', sessionName: 'solo-lead', role: 'team-leader' })] },
    ] as Team[];
    expect(leadContextFromTeams(teams, 'tt-atlas')).toEqual({ teamId: 't1', teamName: 'Think Tank', members: [{ name: 'Sage', role: 'researcher', availability: 'idle' }] });
    expect(leadContextFromTeams(teams, 'tt-sage')).toBeNull();
    expect(leadContextFromTeams(teams, 'solo-lead')).toBeNull();
  });
});
