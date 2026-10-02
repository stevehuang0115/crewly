/**
 * Tests for the Tickets board helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  agentDisplayName,
  buildAgentNames,
  cardMatchesSearch,
  displayTitle,
  formatAcceptance,
  groupCards,
  parseAcceptance,
  parseLabels,
  projectStatusColumn,
  projectTicketToCard,
  runTicketRef,
  ticketFlag,
  ticketToCard,
} from './board.utils';
import type { TicketListItem } from '../../types/ticket.types';
import type { ProjectTicket } from '../../types/project-ticket.types';
import type { Team } from '../../types';

const NOW = Date.parse('2026-09-24T00:00:00Z');

function ask(over: Partial<TicketListItem>): TicketListItem {
  return {
    id: 'a', tkt: 'TKT-001', title: 't', kind: 'feature', column: 'todo', status: 'open', priority: 'normal',
    priorityLabel: 'P2', origin: null, assignee: null, workItemIds: [], tags: [], createdAt: '', updatedAt: '', ...over,
  };
}

function pt(over: Partial<ProjectTicket>): ProjectTicket {
  return {
    id: 'CE-1', title: 'Fix it', status: 'ready', priority: 'P2', assignee: null, team: null, labels: [], ownerReview: false,
    createdAt: '', updatedAt: '', workItemId: null, requestId: null, source: null, migratedFrom: null, fileName: 'CE-1.md',
    filePath: '', projectPath: '', description: '', acceptance: [], log: [], ...over,
  };
}

describe('displayTitle', () => {
  it('drops a leading tag and a pasted Slack image path', () => {
    expect(displayTitle('[Deploy] 分享一下 [Slack Image: /Users/x/.')).toBe('分享一下');
    expect(displayTitle('[Request] 可以发pdf吗')).toBe('可以发pdf吗');
  });
  it('keeps titles without noise, and never returns an empty string', () => {
    expect(displayTitle('Plain title')).toBe('Plain title');
    expect(displayTitle('[Only]')).toBe('[Only]');
  });
});

describe('projectStatusColumn', () => {
  it('maps project statuses onto board columns', () => {
    expect(projectStatusColumn('backlog')).toBe('todo');
    expect(projectStatusColumn('ready')).toBe('todo');
    expect(projectStatusColumn('in_progress')).toBe('in_progress');
    expect(projectStatusColumn('review')).toBe('to_review');
    expect(projectStatusColumn('done')).toBe('done');
    expect(projectStatusColumn('cancelled')).toBe('cancelled');
  });
});

describe('ticketFlag', () => {
  it('shows the auto-accept countdown in review, sent-back count in its tooltip', () => {
    const f = ticketFlag(ask({ column: 'to_review', autoAcceptAt: '2026-09-27T00:00:00Z', rejectCount: 2 }), NOW);
    expect(f).toEqual({ text: 'Auto-accepts in 3 days', tone: 'attention', title: 'Sent back ×2' });
  });
  it('falls back to "Sent back ×N" without a deadline', () => {
    expect(ticketFlag(ask({ column: 'to_review', rejectCount: 1 }), NOW)).toEqual({ text: 'Sent back ×1', tone: 'danger' });
  });
  it('says how a done ticket was accepted', () => {
    expect(ticketFlag(ask({ column: 'done', acceptedBy: 'owner' }))?.text).toBe('Accepted');
    expect(ticketFlag(ask({ column: 'done', acceptedBy: 'silence' }))?.text).toBe('Auto-accepted · not reviewed');
  });
  it('is quiet otherwise', () => {
    expect(ticketFlag(ask({ column: 'todo' }))).toBeNull();
  });
});

describe('cards', () => {
  it('builds an ask card and a project ticket card', () => {
    const a = ticketToCard(ask({ id: 'x', title: '[Fix] Login' }));
    expect(a).toMatchObject({ key: 't:x', source: 'ticket', title: 'Login', fullTitle: '[Fix] Login', projectId: null });
    const p = projectTicketToCard(pt({ status: 'backlog' }), { id: 'p1', name: 'CE' });
    expect(p).toMatchObject({ key: 'p:p1:CE-1', source: 'project', column: 'todo', projectName: 'CE', flag: { text: 'Backlog' } });
  });

  it('groups by column, most urgent then most recent first', () => {
    const cards = [
      projectTicketToCard(pt({ id: 'A', priority: 'P2', updatedAt: '2026-01-02' }), { id: 'p', name: 'P' }),
      projectTicketToCard(pt({ id: 'B', priority: 'P0', updatedAt: '2026-01-01' }), { id: 'p', name: 'P' }),
      projectTicketToCard(pt({ id: 'C', priority: 'P2', updatedAt: '2026-01-03' }), { id: 'p', name: 'P' }),
    ];
    expect(groupCards(cards).todo.map((c) => c.ref)).toEqual(['B', 'C', 'A']);
    expect(groupCards(cards).done).toEqual([]);
  });

  it('searches project tickets client-side and lets asks through (searched server-side)', () => {
    const p = projectTicketToCard(pt({ labels: ['export'] }), { id: 'p', name: 'P' });
    expect(cardMatchesSearch(p, 'EXPORT')).toBe(true);
    expect(cardMatchesSearch(p, 'nope')).toBe(false);
    expect(cardMatchesSearch(ticketToCard(ask({})), 'nope')).toBe(true);
  });
});

describe('agent names', () => {
  const teams = [{ id: 't', name: 'Think Tank', members: [{ sessionName: 'think-tank-atlas-b4', name: 'Atlas' }] }] as unknown as Team[];
  const names = buildAgentNames(teams);
  it('turns a session name into a person name', () => {
    expect(agentDisplayName('think-tank-atlas-b4', names)).toBe('Atlas');
    expect(agentDisplayName('think-tank-atlas-b4', names, true)).toBe('Atlas · Think Tank');
    expect(agentDisplayName('crewly-orc', names)).toBe('Orc');
    expect(agentDisplayName('Steve', names)).toBe('Steve');
    expect(agentDisplayName(null, names)).toBeNull();
  });
});

describe('form helpers', () => {
  it('parses labels and acceptance lines, keeping done flags', () => {
    expect(parseLabels(' a, ,b ')).toEqual(['a', 'b']);
    expect(parseAcceptance('[x] one\ntwo\n', [{ text: 'two', done: true }])).toEqual([
      { text: 'one', done: true },
      { text: 'two', done: true },
    ]);
    expect(formatAcceptance([{ text: 'one', done: true }, { text: 'two', done: false }])).toBe('[x] one\ntwo');
  });
});

describe('runTicketRef', () => {
  it('reads the ticket from a run title', () => {
    expect(runTicketRef('Follow-up for the owner (TKT-191): x')).toBe('TKT-191');
    expect(runTicketRef('CE-69: CE-68 follow-up')).toBe('CE-69');
    expect(runTicketRef('Ticket triage: CE (2 tickets)')).toBeNull();
  });
});
