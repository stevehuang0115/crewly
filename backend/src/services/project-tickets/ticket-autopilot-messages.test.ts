/**
 * Tests for the ticket autopilot texts: the triage brief (with the
 * boundaries), the owner's batched questions and the evening digest.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ProjectTicket } from '../../types/project-ticket.types.js';
import {
  MEMBER_AVAILABILITY_LABELS,
  TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE,
  TICKET_AUTOPILOT_BOUNDARIES,
  buildBudgetPausedMessage,
  buildDigestMessage,
  buildReplanBrief,
  buildSelfReviewBrief,
  buildTriageBrief,
  formatAge,
  REPLAN_ASK,
  REPLAN_METRIC_RULE,
  replanMetricRejection,
  STOP_REASON_WORDS,
} from './ticket-autopilot-messages.js';

const NOW = Date.parse('2026-09-30T10:00:00.000Z');

function ticket(id: string, extra: Partial<ProjectTicket> = {}): ProjectTicket {
  return {
    id,
    title: `Title ${id}`,
    status: 'backlog',
    priority: 'P1',
    assignee: null,
    team: null,
    labels: [],
    ownerReview: false,
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    workItemId: 'wi-secret-123',
    requestId: null,
    source: 'owner',
    migratedFrom: null,
    fileName: `${id}.md`,
    filePath: `/x/${id}.md`,
    projectPath: '/x',
    description: 'Write the partner email.\nKeep it short.',
    acceptance: [],
    log: [],
    extra: {},
    ...extra,
  };
}

describe('buildTriageBrief', () => {
  const brief = buildTriageBrief({
    project: { id: 'p-ce', name: 'CE' },
    candidates: [
      { ticket: ticket('CE-1', { labels: ['email'] }), reason: 'backlog', workerCreated: false },
      { ticket: ticket('CE-2', { source: 'agent:ce-dev' }), reason: 'backlog', workerCreated: true },
      { ticket: ticket('CE-3', { status: 'ready' }), reason: 'ready_no_taker', workerCreated: false },
    ],
    more: 2,
    members: [
      { session: 'ce-owen', name: 'Owen', role: 'tech-lead', lead: true, availability: 'idle', inFlight: 0, responsibility: 'Leads the team' },
      { session: 'ce-dev', availability: 'working', inFlight: 1 },
      {
        session: 'ce-nova-a2b1f759',
        name: 'Nova',
        role: 'content-strategist',
        availability: 'stopped',
        inFlight: 0,
        responsibility: 'Plans and writes content: articles, posts, copy and the images or visuals that go with them',
      },
    ],
    maxInFlightPerMember: 1,
    now: NOW,
  });

  it('spells out every boundary that still needs the owner', () => {
    for (const b of TICKET_AUTOPILOT_BOUNDARIES) expect(brief).toContain(b);
    expect(TICKET_AUTOPILOT_BOUNDARIES).toEqual(
      expect.arrayContaining(['sending email or messages to outside people', 'publishing content publicly', 'deploying to production', 'spending money']),
    );
    expect(brief).toMatch(/draft or a PR/);
  });

  it('offers the four decisions with runnable commands for this project', () => {
    expect(brief).toContain('assign --project p-ce --id <ID> --to <member>');
    expect(brief).toContain('ask-owner --project p-ce');
    expect(brief).toContain('--option "<choice>" --option "<choice>" --default "<choice or wait>"');
    expect(brief).toContain('--status cancelled');
    expect(brief).toContain('Split');
  });

  it('lists each ticket with id, priority, labels, age and creator, and flags worker-created ones', () => {
    expect(brief).toContain('### CE-1 · P1 · backlog · 2d old');
    expect(brief).toContain('labels: email');
    expect(brief).toContain('created by ce-dev · **worker-created — review first**');
    expect(brief).toContain('ready, but nobody on the team can take it');
    expect(brief).toContain('> Write the partner email. Keep it short.');
    expect(brief).toContain('2 more tickets will come in the next triage');
  });

  it('shows the team with three states — idle, working, stopped (available) — and in-flight counts', () => {
    expect(brief).toContain('- ce-owen (Owen, tech-lead, lead) — idle; 0 in progress');
    expect(brief).toContain('- ce-dev — working; 1 in progress');
    // The CE incident: an idle-stopped member was listed as "busy".
    expect(brief).toContain('- ce-nova-a2b1f759 (Nova, content-strategist) — stopped: available, will be started when assigned; 0 in progress');
    expect(brief).not.toContain('busy');
    expect(brief).toContain('At most 1 ticket in progress per member');
    expect(MEMBER_AVAILABILITY_LABELS.stopped).toMatch(/available/);
  });

  it('gives each member a role line so the lead assigns by fit', () => {
    expect(brief).toContain('  role: Leads the team');
    expect(brief).toContain('  role: Plans and writes content');
  });

  it('tells the lead to delegate by role and to treat old splits as hints', () => {
    expect(brief).toContain('## Who does what');
    for (const g of TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE) expect(brief).toContain(g);
    expect(brief).toMatch(/Take a ticket yourself only for lead-level work/);
    expect(brief).toMatch(/only a hint/);
  });
});

describe('buildReplanBrief (specs/2026-10-04-autopilot-goal-replan.md)', () => {
  const input = {
    project: { id: 'p-ce', name: 'CE' },
    goal: '(2026-10-03, set by owner) 1,000 /feed visitors a week, 25% returning within a week.',
    closed: [ticket('CE-107', { status: 'done', title: 'Ship the feed publicly', labels: ['feed'], updatedAt: '2026-09-30T08:00:00.000Z' })],
    lookbackDays: 7,
    experiments: [{ id: 'EXP-4', title: 'Goal-only feed', hypothesis: 'A goal alone keeps the team shipping feed cards', status: 'running', dueAt: '2026-11-29T00:00:00Z' }],
    members: [
      { session: 'ce-owen', name: 'Owen', role: 'tech-lead', lead: true, availability: 'idle' as const, inFlight: 0 },
      { session: 'ce-nova', name: 'Nova', role: 'content-strategist', availability: 'idle' as const, inFlight: 0 },
    ],
    maxInFlightPerMember: 1,
    now: NOW,
  };

  it('carries the goal, the closed tickets, the open experiment, the team and the ask', () => {
    const brief = buildReplanBrief(input);
    expect(brief).toContain('# Goal replan — CE');
    expect(brief).toContain(REPLAN_ASK);
    expect(REPLAN_ASK).toBe('Open the next tickets toward this goal, or say why there are none.');
    expect(brief).toContain('1,000 /feed visitors a week');
    expect(brief).toContain('## Closed in the last 7 days');
    expect(brief).toContain('- CE-107 · done 2h ago · Ship the feed publicly · labels: feed');
    expect(brief).toContain('- EXP-4 · running · result due 2026-11-29 · Goal-only feed');
    expect(brief).toContain('hypothesis: A goal alone keeps the team shipping feed cards');
    expect(brief).toContain('- ce-nova (Nova, content-strategist) — idle; 0 in progress');
    expect(brief).toContain('create --project p-ce');
    expect(brief).toContain('never makes your tickets ready or starts the work itself');
    for (const b of TICKET_AUTOPILOT_BOUNDARIES) expect(brief).toContain(b);
    // Harness text is English, with no WorkItem ids.
    expect(brief).not.toMatch(/[\u4e00-\u9fff]/);
    expect(brief).not.toContain('wi-secret-123');
  });

  it('says "(none)" when nothing closed and no experiment is open', () => {
    const brief = buildReplanBrief({ ...input, closed: [], experiments: [] });
    expect(brief.match(/- \(none\)/g)).toHaveLength(2);
  });
});

describe('owner-facing texts', () => {
  it('builds the digest without harness mechanics and skips empty projects', () => {
    const msg = buildDigestMessage([
      {
        name: 'CE',
        doneToday: [ticket('CE-1', { status: 'done' })],
        inProgress: [ticket('CE-2', { status: 'in_progress', assignee: 'ce-dev' })],
        waitingOnOwner: [ticket('CE-4', { labels: ['needs-owner'] })],
      },
      { name: 'Quiet', doneToday: [], inProgress: [], waitingOnOwner: [] },
    ]);
    expect(msg).toContain('Done today (1): CE-1 Title CE-1');
    expect(msg).toContain('In progress (1): CE-2 Title CE-2 (ce-dev)');
    expect(msg).toContain('Waiting on you (1): CE-4');
    expect(msg).not.toContain('Quiet');
    expect(msg).not.toContain('wi-secret-123');
    expect(msg).not.toMatch(/WorkItem|claim/i);
    expect(buildDigestMessage([{ name: 'Quiet', doneToday: [], inProgress: [], waitingOnOwner: [] }])).toBeNull();
  });

  it('appends the team leads block (crewly#1083), even on a day with no ticket rows', () => {
    const block = '*Team leads* (lead share of team tokens)\n- *Think Tank* (Atlas): 94% of 30M today, 92% this week — over half: the lead is doing the work';
    const quiet = [{ name: 'Quiet', doneToday: [], inProgress: [], waitingOnOwner: [] }];
    expect(buildDigestMessage(quiet, block)).toBe(`Tickets today\n\n${block}`);
    const withRows = buildDigestMessage([{ name: 'CE', doneToday: [ticket('CE-1', { status: 'done' })], inProgress: [], waitingOnOwner: [] }], block);
    expect(withRows!.indexOf('*CE*')).toBeLessThan(withRows!.indexOf('*Team leads*'));
    expect(buildDigestMessage(quiet, null)).toBeNull();
  });

  it('links waiting tickets to their decision cards, never repeating the question', () => {
    const msg = buildDigestMessage([
      {
        name: 'CE',
        doneToday: [],
        inProgress: [],
        waitingOnOwner: [ticket('CE-4', { labels: ['needs-owner'], log: ['a · tl · owner question: Send it? (D-1)'] })],
        links: new Map([['CE-4', 'https://slack.com/archives/C0TEAM/p1790000000000100']]),
      },
    ])!;
    expect(msg).toContain('Waiting on you (1): <https://slack.com/archives/C0TEAM/p1790000000000100|CE-4> Title CE-4');
    expect(msg).not.toContain('Send it?');
  });

  it('explains a budget pause in one line', () => {
    expect(buildBudgetPausedMessage('CE', 20_456_000, 20_000_000, 'CE')).toBe(
      'Ticket autopilot paused for today on CE: the team has used 20.5M tokens of its 20M tokens daily budget. It picks up again tomorrow, or reply `boost CE by 20M today` to lift it for today.',
    );
  });

  it('formats ages', () => {
    expect(formatAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(formatAge(new Date(NOW - 5 * 3_600_000).toISOString(), NOW)).toBe('5h');
    expect(formatAge('nope', NOW)).toBe('?');
  });
});

describe('team-leader prompt', () => {
  it.each(['config/roles/team-leader/prompt.md', 'config/roles/team-leader/tl-addon.md'])('%s spells out the same boundaries', (rel) => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(text).toContain('Ticket autopilot / triage');
    for (const b of TICKET_AUTOPILOT_BOUNDARIES) expect(text).toContain(b);
  });

  it.each(['config/roles/team-leader/prompt.md', 'config/roles/team-leader/tl-addon.md'])('%s says role is a preference, not a limit (crewly#1083)', (rel) => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(text).toContain('Role is a preference, not a limit');
    expect(text).toContain('Any member can take any work that needs no special account, tool or permission');
    expect(text).toContain('Prefer an idle member over doing it yourself');
    expect(text).toContain('lead-level work (review, decisions, owner communication, cross-team coordination), when every member is busy, or when the work truly needs your own judgment');
    expect(text).toContain('--no-member-fits');
    expect(text).toMatch(/stopped\* is available/);
    expect(text).toContain('only a hint');
    // The old wording made a lead keep work its "researcher" members could do.
    expect(text).not.toContain('Delegate by role');
    expect(text).not.toContain('whose role fits the work');
  });

  it.each(['config/roles/team-leader/prompt.md', 'config/roles/team-leader/tl-addon.md'])('%s hands owner Slack requests over with --thread (crewly#1083)', (rel) => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(text).toContain('--thread <key>');
    expect(text).toContain('The member answers the owner in that thread itself');
  });

  it('the triage guidance carries the same rule', () => {
    const joined = TICKET_AUTOPILOT_ASSIGNMENT_GUIDANCE.join(' ');
    expect(joined).toContain('Role is a preference, not a limit');
    expect(joined).toContain('--no-member-fits');
    expect(joined).not.toContain('Delegate by role');
  });
});

describe('speed modes texts (specs/2026-10-04-autopilot-speed-modes.md)', () => {
  const review = { at: '2026-10-04T13:00:00.000Z', by: 'ce-owen', gap: '620 of 1,000 weekly visitors', moved: 'feed cards', nextBet: 'two cards a day' };

  it('the replan brief requires a metric per ticket and starts from the last next bet', () => {
    const base = { project: { id: 'p1', name: 'CE' }, goal: 'Reach 1,000 /feed visitors a week', closed: [], lookbackDays: 7, experiments: [], members: [], maxInFlightPerMember: 1, now: NOW };
    const brief = buildReplanBrief({ ...base, lastSelfReview: review });
    expect(brief).toContain(REPLAN_METRIC_RULE);
    expect(brief).toContain('--metric "<goal metric> → <expected effect>"');
    expect(brief).toContain('- Next bet: two cards a day');
    expect(buildReplanBrief(base)).not.toContain('Your last self-review');
  });

  it('the rejection tells the agent exactly how to fix the ticket', () => {
    const msg = replanMetricRejection('Feed card 9', 'CE');
    expect(msg).toContain('"Feed card 9" was not created');
    expect(msg).toContain('--metric "<goal metric> → <expected effect>"');
  });

  it('the self-review brief is short: goal, counts, stop reason, the last next bet and the command', () => {
    const brief = buildSelfReviewBrief({
      project: { id: 'p1', name: 'CE' },
      mode: 'rush',
      cadence: 'hourly',
      goal: 'Reach 1,000 /feed visitors a week',
      closedSince: 3,
      open: { ready: 1, inProgress: 2, backlog: 0, waitingOnOwner: 1 },
      stopReason: 'waiting_on_owner',
      previous: review,
    });
    expect(brief).toContain('Autopilot speed: rush (self-review hourly)');
    expect(brief).toContain('Closed: 3 · ready: 1 · in progress: 2');
    expect(brief).toContain(`Stopped: ${STOP_REASON_WORDS.waiting_on_owner}`);
    expect(brief).toContain('Your last next bet: two cards a day');
    expect(brief).toContain('execute.sh self-review --project p1 --gap');
    expect(brief.split('\n').length).toBeLessThan(25);
  });

  it('the digest names why a project stopped and its self-review', () => {
    const msg = buildDigestMessage([{ name: 'CE', doneToday: [], inProgress: [], waitingOnOwner: [], stopReason: 'no_ideas', selfReview: review }]);
    expect(msg).toContain('Stopped: the last goal replan found nothing to do');
    expect(msg).toContain('Self-review: gap 620 of 1,000 weekly visitors; next bet two cards a day');
    expect(buildDigestMessage([{ name: 'CE', doneToday: [], inProgress: [], waitingOnOwner: [] }])).toBeNull();
  });

  it('every stop reason has words', () => {
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual(['budget_reached', 'no_ideas', 'paused', 'system_error', 'waiting_on_owner']);
  });
});
