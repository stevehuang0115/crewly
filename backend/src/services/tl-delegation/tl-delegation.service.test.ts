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
  buildRosterBlock,
  buildShellNudgeText,
  freeMembers,
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

  it('ignores tools that are neither file edits nor shell commands', async () => {
    for (let i = 0; i < 100; i++) expect(await edit('tt-atlas', 'Read')).toBeNull();
    expect(leadContext).not.toHaveBeenCalled();
  });

  describe('shell work (Bash)', () => {
    const T = TL_DELEGATION_CONSTANTS.SHELL_THRESHOLD;
    /** Run `n` shell commands spread over `spanMs`; the last result. */
    const bash = async (n: number, spanMs = 10 * MIN, session = 'tt-atlas'): Promise<string | null> => {
      let last: string | null = null;
      for (let i = 0; i < n; i++) {
        last = await svc.observeToolUse(session, 'Bash');
        now += Math.floor(spanMs / n);
      }
      return last;
    };

    it('needs 40 commands in 20 minutes', () => {
      expect(T).toBe(40);
      expect(TL_DELEGATION_CONSTANTS.WINDOW_MS).toBe(20 * MIN);
    });

    it('nudges at the shell threshold with the command count and the same members and advice', async () => {
      expect(await bash(T - 1)).toBeNull();
      expect(leadContext).not.toHaveBeenCalled();
      const note = await bash(1);
      expect(note).toContain(`${TL_DELEGATION_CONSTANTS.NUDGE_TAG} You have run ${T} commands in the last 20 minutes.`);
      expect(note).toContain('Sage (researcher, idle), Rex (developer, idle), Nova (designer, stopped — starts when assigned)');
      expect(note).toContain('--no-member-fits');
      expect(svc.nudgeCounts(['tt-atlas']).total).toEqual({ count: 1, followed: 0 });
    });

    it('does not count commands outside the window', async () => {
      expect(await bash(T + 20, 60 * MIN)).toBeNull();
    });

    it('does not fire while every other member is working, and fires once one is free', async () => {
      const busy: LeadContext = { ...LEAD, members: LEAD.members.map((m) => ({ ...m, availability: 'working' as const })) };
      leadContext.mockResolvedValue(busy);
      expect(await bash(T + 5)).toBeNull();
      expect(svc.nudgeCounts(['tt-atlas']).total.count).toBe(0);
      leadContext.mockResolvedValue({ ...busy, members: [{ name: 'Nova', role: 'designer', availability: 'stopped' }] });
      expect(await bash(1)).toContain('Nova (designer, stopped — starts when assigned)');
    });

    it('shares the cooldown with the edit nudge, in both directions', async () => {
      for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) await edit();
      expect(svc.nudgeCounts(['tt-atlas']).total.count).toBe(1);
      expect(await bash(T + 5, 10 * MIN)).toBeNull();
      now += TL_DELEGATION_CONSTANTS.NUDGE_COOLDOWN_MS;
      expect(await bash(T, 10 * MIN)).toContain('commands');
      let editNote: string | null = null;
      for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) editNote = await edit();
      expect(editNote).toBeNull();
      expect(svc.nudgeCounts(['tt-atlas']).total.count).toBe(2);
    });

    it('starts the count over when the lead delegates', async () => {
      expect(await bash(T - 1, 5 * MIN)).toBeNull();
      expect(svc.recordDelegation('tt-atlas', 'tt-sage')).toBe(false);
      expect(await bash(T - 1, 5 * MIN)).toBeNull();
      expect(await bash(1)).toContain('commands');
    });

    it('a delegation after a shell nudge counts as following it', async () => {
      await bash(T);
      expect(svc.recordDelegation('tt-atlas', 'tt-sage')).toBe(true);
    });

    it('never nudges a member that leads nothing, and leaves the edit nudge as it was', async () => {
      expect(await bash(T + 5, 10 * MIN, 'tt-sage')).toBeNull();
      await bash(10);
      let note: string | null = null;
      for (let i = 0; i < TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD; i++) note = await edit();
      expect(note).toContain(`edited files ${TL_DELEGATION_CONSTANTS.EDIT_THRESHOLD} times`);
    });
  });

  describe('rosterBlockFor (owner work delivered to a lead)', () => {
    const withLive = (live: string[], ctx: jest.Mock = leadContext) =>
      new TlDelegationService({ leadContext: ctx, liveWorkTargets: async () => new Set(live), statePath: path.join(dir, 'tl-delegation.json'), now: () => now, logger: silent });
    const TEAM: LeadContext = {
      teamId: 'flopost',
      teamName: 'Flopost',
      members: [{ name: 'Dex', role: 'developer', availability: 'stopped', sessions: ['flopost-dex'] }],
    };

    it('names the free member for a lead', async () => {
      leadContext.mockResolvedValue(TEAM);
      expect(await withLive([]).rosterBlockFor('flopost-pia')).toBe(
        '[TEAM] Free now: Dex (developer, stopped — starts when assigned). Hand hands-on work to a member with delegate-task --thread <key>; ' +
          'keep it only for lead-level work, and then record why: delegate-task --no-member-fits "<what is missing>" --task "<the work>".',
      );
    });

    it('is shown at most once per lead per 10 minutes', async () => {
      leadContext.mockResolvedValue(TEAM);
      const s = withLive([]);
      expect(TL_DELEGATION_CONSTANTS.ROSTER_COOLDOWN_MS).toBe(10 * MIN);
      expect(await s.rosterBlockFor('flopost-pia')).not.toBeNull();
      now += 9 * MIN;
      expect(await s.rosterBlockFor('flopost-pia')).toBeNull();
      expect(await s.rosterBlockFor('other-lead')).not.toBeNull();
      now += 2 * MIN;
      expect(await s.rosterBlockFor('flopost-pia')).not.toBeNull();
    });

    it('gives nothing to a non-lead, and nothing when no member is free (no cooldown spent)', async () => {
      expect(await withLive([]).rosterBlockFor('tt-sage')).toBeNull();
      leadContext.mockResolvedValue(TEAM);
      const live = ['flopost-dex'];
      const s = withLive(live);
      expect(await s.rosterBlockFor('flopost-pia')).toBeNull();
      live.length = 0;
      const free = new TlDelegationService({ leadContext, liveWorkTargets: async () => new Set(live), statePath: path.join(dir, 'x.json'), now: () => now, logger: silent });
      expect(await free.rosterBlockFor('flopost-pia')).toContain('Dex');
      leadContext.mockResolvedValue({ ...TEAM, members: [{ ...TEAM.members[0], availability: 'working' }] });
      now += 11 * MIN;
      expect(await free.rosterBlockFor('flopost-pia')).toBeNull();
    });

    it('never throws and never waits long: a failing or hanging lookup means no block', async () => {
      const failing = jest.fn(async () => {
        throw new Error('storage down');
      });
      expect(await withLive([], failing as never).rosterBlockFor('flopost-pia')).toBeNull();
      leadContext.mockResolvedValue(TEAM);
      const broken = new TlDelegationService({
        leadContext,
        liveWorkTargets: async () => {
          throw new Error('pool down');
        },
        statePath: path.join(dir, 'y.json'),
        now: () => now,
        logger: silent,
      });
      expect(await broken.rosterBlockFor('flopost-pia')).toBeNull();
      jest.useFakeTimers();
      try {
        const hanging = new TlDelegationService({ leadContext, liveWorkTargets: () => new Promise(() => undefined), statePath: path.join(dir, 'z.json'), now: () => now, logger: silent });
        const pending = hanging.rosterBlockFor('flopost-pia');
        await jest.advanceTimersByTimeAsync(TL_DELEGATION_CONSTANTS.ROSTER_TIMEOUT_MS + 1);
        expect(await pending).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
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

  it('the shell text differs from the edit text only in its opening sentence', () => {
    const shell = buildShellNudgeText(40, LEAD.members);
    const edits = buildNudgeText(6, LEAD.members);
    expect(shell).toContain('You have run 40 commands in the last 20 minutes.');
    expect(shell.slice(shell.indexOf('As team lead'))).toBe(edits.slice(edits.indexOf('As team lead')));
  });

  it('freeMembers: idle or stopped and holding no live work item, idle first, at most three', () => {
    const members = [
      { name: 'Kai', role: 'researcher', availability: 'working' as const, sessions: ['kai'] },
      { name: 'Nova', role: 'designer', availability: 'stopped' as const, sessions: ['nova', 'agent-nova'] },
      { name: 'Sage', role: 'researcher', availability: 'idle' as const, sessions: ['sage'] },
      { name: 'Rex', role: 'developer', availability: 'idle' as const, sessions: ['rex'] },
      { name: 'Ivy', role: 'writer', availability: 'idle' as const },
      { name: 'Ola', role: 'qa', availability: 'idle' as const, sessions: ['ola'] },
    ];
    expect(freeMembers(members, new Set()).map((m) => m.name)).toEqual(['Sage', 'Rex', 'Ivy']);
    expect(freeMembers(members, new Set(['sage', 'agent-nova', 'rex', 'ola'])).map((m) => m.name)).toEqual(['Ivy']);
    expect(buildRosterBlock(members, new Set(['sage', 'agent-nova', 'rex', 'ola']))).toContain('[TEAM] Free now: Ivy (writer, idle). Hand hands-on work');
    expect(buildRosterBlock([members[0]], new Set())).toBeNull();
    expect(buildRosterBlock([], new Set())).toBeNull();
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
    expect(leadContextFromTeams(teams, 'tt-atlas')).toEqual({ teamId: 't1', teamName: 'Think Tank', members: [{ name: 'Sage', role: 'researcher', availability: 'idle', sessions: ['tt-sage'] }] });
    expect(leadContextFromTeams(teams, 'tt-sage')).toBeNull();
    expect(leadContextFromTeams(teams, 'solo-lead')).toBeNull();
  });
});
