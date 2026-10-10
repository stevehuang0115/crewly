/**
 * Tests for the pure half of ticket hygiene: staleness thresholds, what counts
 * as activity, orphan detection, and the stale selection / batching / cooldown.
 */
import { TICKET_HYGIENE_CONSTANTS as C } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import {
  buildReviewBrief,
  looksLikeAgentSession,
  orphanReason,
  selectReviewBatches,
  staleThresholdDays,
  ticketKey,
  ticketLastActivityMs,
  ticketStaleness,
  type HygieneTicket,
} from './ticket-hygiene.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

function team(id: string, members: TeamMember[], extra: Partial<Team> = {}): Team {
  return { id, name: id.toUpperCase(), members, projectIds: ['p1'], createdAt: '', updatedAt: '', ...extra } as Team;
}

function ticket(over: Partial<HygieneTicket> = {}): HygieneTicket {
  return {
    id: 'T-1',
    title: 'A ticket',
    status: 'in_progress',
    labels: [],
    assignee: null,
    team: null,
    createdAt: ago(40),
    updatedAt: ago(10),
    log: [],
    projectId: 'p1',
    projectName: 'Proj',
    projectPath: '/proj',
    ...over,
  };
}

describe('thresholds', () => {
  it('uses 3 days for in_progress / review and 14 for ready / backlog', () => {
    expect(C.STALE_ACTIVE_DAYS).toBe(3);
    expect(C.STALE_IDLE_DAYS).toBe(14);
    expect(staleThresholdDays('in_progress')).toBe(3);
    expect(staleThresholdDays('review')).toBe(3);
    expect(staleThresholdDays('ready')).toBe(14);
    expect(staleThresholdDays('backlog')).toBe(14);
    expect(staleThresholdDays('done')).toBeNull();
    expect(staleThresholdDays('cancelled')).toBeNull();
  });

  it('flags a ticket only at its threshold', () => {
    expect(ticketStaleness(ticket({ status: 'in_progress', updatedAt: ago(2.9) }), NOW).stale).toBe(false);
    expect(ticketStaleness(ticket({ status: 'in_progress', updatedAt: ago(3) }), NOW).stale).toBe(true);
    expect(ticketStaleness(ticket({ status: 'ready', updatedAt: ago(13) }), NOW).stale).toBe(false);
    expect(ticketStaleness(ticket({ status: 'backlog', updatedAt: ago(14) }), NOW)).toMatchObject({ stale: true, idleDays: 14, thresholdDays: 14 });
  });

  it('never flags closed tickets', () => {
    expect(ticketStaleness(ticket({ status: 'done', updatedAt: ago(90) }), NOW).stale).toBe(false);
    expect(ticketStaleness(ticket({ status: 'cancelled', updatedAt: ago(90) }), NOW).stale).toBe(false);
  });

  it('leaves parked, deferred, needs-owner, deferred-until and owner-review tickets alone', () => {
    for (const label of ['parked', 'deferred', 'needs-owner']) {
      expect(ticketStaleness(ticket({ status: 'backlog', updatedAt: ago(60), labels: [label] }), NOW).stale).toBe(false);
    }
    expect(ticketStaleness(ticket({ status: 'backlog', updatedAt: ago(60), deferUntil: new Date(NOW + DAY).toISOString() }), NOW).stale).toBe(false);
    expect(ticketStaleness(ticket({ status: 'backlog', updatedAt: ago(60), deferUntil: new Date(NOW - DAY).toISOString() }), NOW).stale).toBe(true);
    expect(ticketStaleness(ticket({ status: 'review', updatedAt: ago(9), ownerReview: true }), NOW).stale).toBe(false);
    expect(ticketStaleness(ticket({ status: 'review', updatedAt: ago(9), ownerReview: false }), NOW).stale).toBe(true);
  });
});

describe('last activity', () => {
  it('is the later of updatedAt and the newest Log line', () => {
    const t = ticket({ updatedAt: ago(10), log: [`${ago(8)} · vera · started`, `${ago(2)} · vera · still on it`] });
    expect(ticketLastActivityMs(t)).toBe(Date.parse(ago(2)));
  });

  it('ignores the hygiene sweep\'s own lines', () => {
    const t = ticket({ updatedAt: ago(10), log: [`${ago(8)} · vera · started`, `${ago(1)} · ${C.ACTOR} · flagged orphaned — ${C.REASON}: x`] });
    expect(ticketLastActivityMs(t)).toBe(Date.parse(ago(8)));
    expect(ticketStaleness(t, NOW).idleDays).toBe(8);
  });

  it('falls back to createdAt when updatedAt is unreadable', () => {
    expect(ticketLastActivityMs({ updatedAt: 'nope', createdAt: ago(5), log: [] })).toBe(Date.parse(ago(5)));
  });
});

describe('orphans', () => {
  const teams = [team('t1', [member('m1', 'app-vera-1a2b3c4d')]), team('gone', [], { archived: true })];

  it('recognises agent-shaped names only', () => {
    expect(looksLikeAgentSession('app-vera-1a2b3c4d')).toBe(true);
    expect(looksLikeAgentSession('Steve')).toBe(false);
    expect(looksLikeAgentSession('crewly-orc')).toBe(false);
  });

  it('flags a removed assignee, an archived or missing team, and not people or the orchestrator', () => {
    expect(orphanReason({ assignee: 'app-vera-1a2b3c4d', team: 't1' }, teams)).toBeNull();
    expect(orphanReason({ assignee: 'think-tank-kai-75d30ac6', team: null }, teams)).toEqual({ assignee: 'think-tank-kai-75d30ac6' });
    expect(orphanReason({ assignee: null, team: 'gone' }, teams)).toEqual({ team: 'gone' });
    expect(orphanReason({ assignee: null, team: 'never-existed' }, teams)).toEqual({ team: 'never-existed' });
    expect(orphanReason({ assignee: 'Steve', team: null }, teams)).toBeNull();
    expect(orphanReason({ assignee: 'crewly-orc', team: null }, teams)).toBeNull();
    expect(orphanReason({ assignee: null, team: null }, teams)).toBeNull();
  });
});

describe('selectReviewBatches', () => {
  const lead = member('m-lead', 'app-lead-aaaaaaaa', 'team-leader');
  const dev = member('m-dev', 'app-dev-bbbbbbbb');
  const app = team('t-app', [lead, dev]);
  const noLead = team('t-solo', [member('m-solo', 'solo-dev-cccccccc')]);
  const base = { nowMs: NOW, sentAt: {} as Record<string, number> };

  it('gives each team with something stale one batch addressed to its lead', () => {
    const batches = selectReviewBatches({
      ...base,
      teams: [app, noLead],
      tickets: [
        ticket({ id: 'T-1', team: 't-app', updatedAt: ago(5) }),
        ticket({ id: 'T-2', team: 't-app', status: 'backlog', updatedAt: ago(30) }),
        ticket({ id: 'T-3', team: 't-app', status: 'backlog', updatedAt: ago(2) }), // fresh
      ],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ key: 't-app', target: 'app-lead-aaaaaaaa', fallbackToOrchestrator: false, more: 0 });
    // Longest silence first.
    expect(batches[0].candidates.map((c) => c.ticket.id)).toEqual(['T-2', 'T-1']);
  });

  it('skips teams with nothing stale', () => {
    expect(selectReviewBatches({ ...base, teams: [app], tickets: [ticket({ team: 't-app', updatedAt: ago(1) }), ticket({ id: 'T-9', status: 'done', team: 't-app', updatedAt: ago(99) })] })).toEqual([]);
  });

  it('falls back to the orchestrator for a team without a lead and for tickets with no team', () => {
    const batches = selectReviewBatches({
      ...base,
      teams: [noLead, app],
      tickets: [ticket({ id: 'T-1', team: 't-solo', updatedAt: ago(5) }), ticket({ id: 'T-2', updatedAt: ago(5) })],
    });
    const byKey = Object.fromEntries(batches.map((b) => [b.key, b]));
    expect(byKey['t-solo']).toMatchObject({ target: 'crewly-orc', fallbackToOrchestrator: true });
    expect(byKey['orchestrator']).toMatchObject({ target: 'crewly-orc', teamId: null });
  });

  it('files a ticket under its assignee\'s team when it has no team', () => {
    const [b] = selectReviewBatches({ ...base, teams: [app], tickets: [ticket({ assignee: 'app-dev-bbbbbbbb', updatedAt: ago(5) })] });
    expect(b.key).toBe('t-app');
  });

  it('files an unowned ticket under the only team on its project, but not when several share it', () => {
    const [b] = selectReviewBatches({ ...base, teams: [app], tickets: [ticket({ updatedAt: ago(5) })] });
    expect(b.key).toBe('t-app');
    const second = team('t-two', [member('m-2', 'two-dev-eeeeeeee', 'team-leader')]);
    const [c] = selectReviewBatches({ ...base, teams: [app, second], tickets: [ticket({ updatedAt: ago(5) })] });
    expect(c.key).toBe('orchestrator');
  });

  it('does not re-send a ticket within the cooldown, and does after it', () => {
    const t = ticket({ team: 't-app', updatedAt: ago(10) });
    const key = ticketKey(t.projectPath, t.id);
    const sentRecently = { [key]: NOW - (C.REVIEW_COOLDOWN_DAYS - 0.1) * DAY };
    expect(selectReviewBatches({ ...base, teams: [app], tickets: [t], sentAt: sentRecently })).toEqual([]);
    const sentLongAgo = { [key]: NOW - (C.REVIEW_COOLDOWN_DAYS + 0.1) * DAY };
    expect(selectReviewBatches({ ...base, teams: [app], tickets: [t], sentAt: sentLongAgo })).toHaveLength(1);
  });

  it('caps a batch and reports the rest', () => {
    const many = Array.from({ length: C.MAX_TICKETS_PER_REVIEW + 4 }, (_, i) => ticket({ id: `T-${i + 1}`, team: 't-app', updatedAt: ago(5) }));
    const [b] = selectReviewBatches({ ...base, teams: [app], tickets: many });
    expect(b.candidates).toHaveLength(C.MAX_TICKETS_PER_REVIEW);
    expect(b.more).toBe(4);
  });

  it('lists an orphaned ticket even when it is not stale, and never wakes a paused team', () => {
    const t = ticket({ team: 't-app', updatedAt: ago(0.5) });
    const orphans = new Map([[ticketKey(t.projectPath, t.id), { assignee: 'x-y-12345678' }]]);
    const [b] = selectReviewBatches({ ...base, teams: [app], tickets: [t], orphans });
    expect(b.candidates[0].reasons).toEqual(['orphaned']);
    expect(selectReviewBatches({ ...base, teams: [app], tickets: [t], orphans, skipTeamIds: new Set(['t-app']) })).toEqual([]);
  });

  it('ignores archived teams (their tickets go to the orchestrator)', () => {
    const archived = team('t-old', [member('m-o', 'old-lead-dddddddd', 'team-leader')], { archived: true });
    const [b] = selectReviewBatches({ ...base, teams: [archived], tickets: [ticket({ team: 't-old', updatedAt: ago(5) })] });
    expect(b.key).toBe('orchestrator');
  });
});

describe('buildReviewBrief', () => {
  it('lists the tickets with their age and the four ways to decide, and keeps the owner out', () => {
    const app = team('t-app', [member('m-lead', 'app-lead-aaaaaaaa', 'team-leader')]);
    const [b] = selectReviewBatches({ nowMs: NOW, sentAt: {}, teams: [app], tickets: [ticket({ id: 'CE-7', title: 'Fix the footer', team: 't-app', assignee: 'app-lead-aaaaaaaa', updatedAt: ago(6) })] });
    const brief = buildReviewBrief(b);
    expect(brief).toContain('**CE-7**');
    expect(brief).toContain('no activity for 6 days');
    expect(brief).toContain('--status done');
    expect(brief).toContain('--status cancelled');
    expect(brief).toContain('still valid');
    expect(brief).toContain('do not message the owner');
  });
});
