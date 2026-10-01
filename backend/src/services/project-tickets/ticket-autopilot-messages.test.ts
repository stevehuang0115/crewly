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
  buildTriageBrief,
  formatAge,
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
    expect(buildBudgetPausedMessage('CE', 20.456, 20)).toContain('$20.46 of its $20.00 daily budget');
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

  it.each(['config/roles/team-leader/prompt.md', 'config/roles/team-leader/tl-addon.md'])('%s tells the lead to delegate by role', (rel) => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(text).toContain('Delegate by role');
    expect(text).toContain('lead-level work (review, decisions, owner communication, cross-team coordination)');
    expect(text).toMatch(/stopped\* is available/);
    expect(text).toContain('only a hint');
  });
});
