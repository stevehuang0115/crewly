import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
  approvalLink,
  leadNameOf,
  leadOfTeam,
  memberLeadReportNote,
  orchestratorNote,
  planTeamLeadReport,
  sameOwnerPlace,
  type LeadReport,
  type PlanTeamLeadReportInput,
} from './team-lead-report.js';

const ORC_DM = { kind: 'owner', receivedBy: 'orchestrator', slackChannelId: 'D0ORC', threadTs: '1792000000.000100' } as const;

function team(id: string, members: Array<Partial<Team['members'][number]> & { id: string }>, over: Partial<Team> = {}): Team {
  return { id, name: id === 'mkt' ? 'Marketing' : id, members: members.map((m) => ({ name: m.id, sessionName: m.id, role: 'developer', ...m })), ...over } as unknown as Team;
}

const MKT = team('mkt', [
  { id: 'ella', name: 'Ella', role: 'team-leader', hierarchyLevel: 1, canDelegate: true },
  { id: 'luna', name: 'Luna' },
]);
const SOLO = team('solo', [{ id: 'sam', name: 'Sam' }]);
const QUIET = team('quiet', [{ id: 'nia', name: 'Nia', role: 'team-leader' }]);

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return { id: 'wi-1', type: 'delegate', owner: 'agent', target: 'luna', title: 'Re-word the tutorial', status: 'queued', createdAt: '2026-10-17T00:00:00Z', metadata: { origin: ORC_DM }, ...over } as WorkItem;
}

function input(over: Partial<PlanTeamLeadReportInput> = {}): PlanTeamLeadReportInput {
  return {
    workItem: wi(),
    creator: 'orchestrator',
    teams: [MKT, SOLO, QUIET],
    isOrchestrator: (n) => n === 'orchestrator',
    channelOf: (id) => (id === 'quiet' ? null : { slackChannelId: `C0${id.toUpperCase()}`, channelName: `#${id}` }),
    ...over,
  };
}

describe('planTeamLeadReport', () => {
  it('orc delegates owner work to a team member → the team lead reports it in the team channel', () => {
    expect(planTeamLeadReport(input())).toEqual({
      lead: 'ella',
      leadName: 'Ella',
      worker: 'luna',
      workerName: 'Luna',
      teamId: 'mkt',
      teamName: 'Marketing',
      slackChannelId: 'C0MKT',
      channelName: 'mkt',
    });
  });

  it('a team with no lead → the worker reports it', () => {
    expect(planTeamLeadReport(input({ workItem: wi({ target: 'sam' }) }))).toMatchObject({ lead: 'sam', leadName: 'Sam', worker: 'sam', teamId: 'solo' });
  });

  it('not stamped: no owner origin, no team, no team channel, the orc as target, no creator', () => {
    expect(planTeamLeadReport(input({ workItem: wi({ metadata: { origin: { kind: 'agent', sessionName: 'orchestrator' } } }) }))).toBeNull();
    expect(planTeamLeadReport(input({ workItem: wi({ target: 'stranger' }) }))).toBeNull();
    expect(planTeamLeadReport(input({ workItem: wi({ target: 'nia' }) }))).toBeNull();
    expect(planTeamLeadReport(input({ workItem: wi({ target: 'orchestrator' }) }))).toBeNull();
    expect(planTeamLeadReport(input({ creator: undefined }))).toBeNull();
  });

  it('archived teams are skipped', () => {
    expect(planTeamLeadReport(input({ teams: [{ ...MKT, archived: true } as Team] }))).toBeNull();
  });

  it('a lead re-delegating stamped work for the same owner place keeps the stamp, with the new worker', () => {
    const held = wi({ id: 'held', target: 'ella', metadata: { origin: ORC_DM, leadReport: { lead: 'ella', worker: 'ella', teamId: 'mkt', teamName: 'Marketing', slackChannelId: 'C0MKT', channelName: 'mkt' } } });
    const out = planTeamLeadReport(input({ creator: 'ella', items: [held] }));
    expect(out).toMatchObject({ lead: 'ella', worker: 'luna', workerName: 'Luna', slackChannelId: 'C0MKT' });
    // A different owner place, or unstamped held work → nothing.
    const other = wi({ metadata: { origin: { ...ORC_DM, threadTs: '1792000000.999999' } } });
    expect(planTeamLeadReport(input({ creator: 'ella', items: [held], workItem: other }))).toBeNull();
    expect(planTeamLeadReport(input({ creator: 'ella', items: [wi({ id: 'h2', target: 'ella' })] }))).toBeNull();
  });
});

describe('team lead report helpers', () => {
  const stamp: LeadReport = { lead: 'ella', leadName: 'Ella', worker: 'luna', teamId: 'mkt', teamName: 'Marketing', slackChannelId: 'C0MKT', channelName: 'marketing' };

  it('leadOfTeam prefers the top of the hierarchy and has no first-member fallback', () => {
    const two = team('two', [
      { id: 'a', role: 'team-leader' },
      { id: 'b', role: 'team-leader', hierarchyLevel: 1, canDelegate: true },
    ]);
    expect(leadOfTeam(two)?.id).toBe('b');
    expect(leadOfTeam(SOLO)).toBeNull();
  });

  it('sameOwnerPlace compares Slack thread or chat thread', () => {
    expect(sameOwnerPlace(ORC_DM, { ...ORC_DM })).toBe(true);
    expect(sameOwnerPlace(ORC_DM, { kind: 'owner', slackChannelId: 'D0ORC' })).toBe(false);
    expect(sameOwnerPlace({ kind: 'owner', conversationId: 'c', chatThreadId: 't' }, { kind: 'owner', conversationId: 'c', chatThreadId: 't' })).toBe(true);
    expect(sameOwnerPlace({ kind: 'owner', conversationId: 'c' }, { kind: 'owner', slackChannelId: 'D0' })).toBe(false);
  });

  it('approvalLink only for a Slack thread', () => {
    expect(approvalLink(ORC_DM)).toBe('https://slack.com/archives/D0ORC/p1792000000000100');
    expect(approvalLink({ kind: 'owner', slackChannelId: 'D0ORC' })).toBeNull();
    expect(approvalLink(null)).toBeNull();
  });

  it('the orc note is informational; member notes say who posts', () => {
    expect(leadNameOf({ ...stamp, leadName: undefined })).toBe('ella');
    expect(orchestratorNote(stamp)).toBe('No owner post needed — Ella reports it in #marketing; do not post it in your thread with the owner.');
    expect(memberLeadReportNote({ id: 'wi-9', target: 'ella' }, stamp)).toContain('you report it to the owner yourself, in #marketing: reply --work-item wi-9');
    const worker = memberLeadReportNote({ id: 'wi-9', target: 'luna' }, stamp);
    expect(worker).toContain('Ella reports it to the owner in #marketing; do not post it to the owner yourself');
    expect(worker).not.toContain('reply --work-item');
  });
});
