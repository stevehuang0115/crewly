/**
 * Tests for the lead-share computation and its digest block (crewly#1083).
 */

import type { Team, TeamMember } from '../../types/index.js';
import type { TokenUsageEvent } from '../monitoring/token-usage.service.js';
import {
  buildLeadShareDigest,
  computeLeadShares,
  formatShare,
  formatTokens,
  memberLedgerKeys,
  sharePeriod,
  startOfLocalDay,
  type LedgerVisitor,
} from './lead-share.js';

const NOW = new Date(2026, 9, 4, 20, 0, 0); // 2026-10-04 20:00 local
const HOUR = 60 * 60 * 1000;

function member(over: Partial<TeamMember>): TeamMember {
  return { id: 'm', name: 'M', sessionName: 's', role: 'developer', agentStatus: 'active', workingStatus: 'idle', ...over } as TeamMember;
}

function team(over: Partial<Team> = {}): Team {
  return {
    id: 't-think',
    name: 'Think Tank',
    members: [
      member({ id: 'atlas', name: 'Atlas', sessionName: 'tt-atlas', role: 'team-leader' }),
      member({ id: 'sage', name: 'Sage', sessionName: 'tt-sage', role: 'researcher' as TeamMember['role'] }),
      member({ id: 'kai', name: 'Kai', sessionName: '', agentId: 'tt-kai', role: 'researcher' as TeamMember['role'] } as Partial<TeamMember>),
    ],
    leaderIds: ['atlas'],
    ...over,
  } as Team;
}

function ev(at: Date, cachedInput: number, output = 0): TokenUsageEvent {
  return { timestamp: at.toISOString(), agentId: 'x', input: 0, output, cachedInput, model: 'claude-opus-5-5' } as TokenUsageEvent;
}

function ledger(events: Array<[string, TokenUsageEvent]>): LedgerVisitor {
  return (visit, since) => {
    for (const [s, e] of events) if (!since || Date.parse(e.timestamp) >= since.getTime()) visit(s, e);
  };
}

describe('computeLeadShares', () => {
  it('splits lead vs team tokens today and over the week', () => {
    const today = new Date(NOW.getTime() - HOUR);
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * HOUR);
    const rows = computeLeadShares(
      [team()],
      ledger([
        ['tt-atlas', ev(today, 3_000_000)],
        ['tt-sage', ev(today, 1_000_000)],
        ['tt-atlas', ev(threeDaysAgo, 300_000_000)],
        ['tt-kai', ev(threeDaysAgo, 16_000_000)], // stopped member: matched by agentId
        ['someone-else', ev(today, 9_000_000)],
      ]),
      NOW,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.leads).toEqual(['Atlas']);
    expect(r.today).toEqual({ lead: 3_000_000, team: 4_000_000, share: 0.75, flagged: true });
    expect(r.week.lead).toBe(303_000_000);
    expect(r.week.team).toBe(320_000_000);
    expect(r.week.flagged).toBe(true);
  });

  it('ignores events older than the week', () => {
    const old = new Date(NOW.getTime() - 9 * 24 * HOUR);
    const rows = computeLeadShares([team()], ledger([['tt-atlas', ev(old, 5_000_000)]]), NOW);
    expect(rows[0].week.team).toBe(0);
    expect(rows[0].week.share).toBeNull();
  });

  it('leaves out one-person, lead-less and archived teams', () => {
    const solo = team({ id: 'solo', members: [member({ id: 'a', sessionName: 'a', role: 'team-leader' })], leaderIds: ['a'] });
    const noLead = team({ id: 'nolead', leaderIds: [], members: [member({ id: 'x', sessionName: 'x' }), member({ id: 'y', sessionName: 'y' })] });
    const archived = { ...team({ id: 'arch' }), archived: true } as Team;
    expect(computeLeadShares([solo, noLead, archived], ledger([]), NOW)).toEqual([]);
  });

  it('does not flag a share on too few tokens', () => {
    expect(sharePeriod(900, 1000).flagged).toBe(false);
    expect(sharePeriod(900_000, 1_000_000).flagged).toBe(true);
    expect(sharePeriod(400_000, 1_000_000).flagged).toBe(false);
  });
});

describe('helpers', () => {
  it('memberLedgerKeys uses session name and agent id', () => {
    expect(memberLedgerKeys({ sessionName: 's1', agentId: 'a1' })).toEqual(['s1', 'a1']);
    expect(memberLedgerKeys({ sessionName: '', agentId: 'a1' })).toEqual(['a1']);
    expect(memberLedgerKeys({ sessionName: 's1', agentId: 's1' })).toEqual(['s1']);
  });

  it('startOfLocalDay is local midnight', () => {
    const d = startOfLocalDay(NOW);
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(4);
  });

  it('formats', () => {
    expect(formatShare(0.756)).toBe('76%');
    expect(formatShare(null)).toBe('–');
    expect(formatTokens(306_400_000)).toBe('306M');
    expect(formatTokens(4_250_000)).toBe('4.3M');
    expect(formatTokens(950)).toBe('950');
  });
});

describe('buildLeadShareDigest', () => {
  const row = {
    teamId: 't-think',
    teamName: 'Think Tank',
    leads: ['Atlas'],
    leadSessions: ['tt-atlas'],
    today: sharePeriod(3_000_000, 4_000_000),
    week: sharePeriod(300_000_000, 320_000_000),
  };

  it('one line per team with the flag, nudges and kept-work reasons', () => {
    const text = buildLeadShareDigest([row], new Map([['t-think', { nudges: { count: 2, followed: 1 }, keptReasons: ['no developer account on Vercel'] }]]));
    expect(text).toContain('*Team leads* (lead share of team tokens)');
    expect(text).toContain('*Think Tank* (Atlas): 75% of 4.0M today, 94% this week — over half: the lead is doing the work');
    expect(text).toContain('nudged to delegate 2×, delegated after 1');
    expect(text).toContain('kept work, no member fits: "no developer account on Vercel"');
  });

  it('leaves out a quiet team and returns null when nothing is left', () => {
    const quiet = { ...row, today: sharePeriod(0, 0) };
    expect(buildLeadShareDigest([quiet])).toBeNull();
  });
});
