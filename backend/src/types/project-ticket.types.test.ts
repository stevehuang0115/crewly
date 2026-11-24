/**
 * Tests for project ticket types: state machine, priority normalisation and
 * the WorkItem → ticket link reader.
 */
import {
  PROJECT_TICKET_TRANSITIONS,
  isProjectTicketStatus,
  isValidProjectTicketTransition,
  parseDeliveredBy,
  canCloseAsDelivered,
  normalizeProjectTicketPriority,
  projectTicketPriorityRank,
  readProjectTicketLink,
  OWNED_TICKET_FIELDS,
} from './project-ticket.types.js';
import { PROJECT_TICKET_CONSTANTS } from '../constants.js';

describe('project ticket state machine', () => {
  it('has an entry for every status and only targets known statuses', () => {
    for (const s of PROJECT_TICKET_CONSTANTS.STATUSES) {
      expect(PROJECT_TICKET_TRANSITIONS[s]).toBeDefined();
      for (const to of PROJECT_TICKET_TRANSITIONS[s]) expect(isProjectTicketStatus(to)).toBe(true);
      expect(PROJECT_TICKET_TRANSITIONS[s]).not.toContain(s);
    }
  });

  it('allows the claim path and the verified path', () => {
    expect(isValidProjectTicketTransition('ready', 'in_progress')).toBe(true);
    expect(isValidProjectTicketTransition('in_progress', 'done')).toBe(true);
    expect(isValidProjectTicketTransition('in_progress', 'review')).toBe(true);
    expect(isValidProjectTicketTransition('review', 'done')).toBe(true);
    expect(isValidProjectTicketTransition('in_progress', 'ready')).toBe(true);
  });

  it('refuses jumps that skip the lifecycle', () => {
    expect(isValidProjectTicketTransition('backlog', 'done')).toBe(false);
    expect(isValidProjectTicketTransition('done', 'in_progress')).toBe(false);
    expect(isValidProjectTicketTransition('cancelled', 'ready')).toBe(false);
    expect(isValidProjectTicketTransition('ready', 'review')).toBe(false);
  });

  it('recognises statuses', () => {
    expect(isProjectTicketStatus('ready')).toBe(true);
    expect(isProjectTicketStatus('open')).toBe(false);
    expect(isProjectTicketStatus(3)).toBe(false);
  });
});

describe('normalizeProjectTicketPriority', () => {
  it.each([
    ['P0', 'P0'],
    ['p1', 'P1'],
    ['critical', 'P0'],
    ['High', 'P1'],
    ['medium', 'P2'],
    ['low', 'P3'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeProjectTicketPriority(raw)).toBe(want);
  });

  it('returns null for unreadable values', () => {
    expect(normalizeProjectTicketPriority('P9')).toBeNull();
    expect(normalizeProjectTicketPriority(1)).toBeNull();
  });

  it('ranks P0 first', () => {
    expect(projectTicketPriorityRank('P0')).toBe(0);
    expect(projectTicketPriorityRank('P3')).toBe(3);
  });
});

describe('readProjectTicketLink', () => {
  it('reads a well-formed link', () => {
    expect(readProjectTicketLink({ projectTicket: { projectPath: '/p', id: 'CRW-1' } })).toEqual({ projectPath: '/p', id: 'CRW-1' });
  });

  it('ignores missing or malformed links', () => {
    expect(readProjectTicketLink(undefined)).toBeNull();
    expect(readProjectTicketLink({ projectTicket: 'CRW-1' })).toBeNull();
    expect(readProjectTicketLink({ projectTicket: { id: 'CRW-1' } })).toBeNull();
  });
});

describe('OWNED_TICKET_FIELDS', () => {
  it('starts with id and title', () => {
    expect(OWNED_TICKET_FIELDS.slice(0, 2)).toEqual(['id', 'title']);
  });
});

describe('parseDeliveredBy / canCloseAsDelivered (CREW-942)', () => {
  it('accepts a PR number, a PR or commit URL, a WorkItem id (with retry suffix) and a commit sha', () => {
    expect(parseDeliveredBy('#1632')).toBe('#1632');
    expect(parseDeliveredBy('PR #1632')).toBe('#1632');
    expect(parseDeliveredBy('https://github.com/stevehuang0115/crewly/pull/1632')).toBe('https://github.com/stevehuang0115/crewly/pull/1632');
    expect(parseDeliveredBy('01d89d86-4aee-4b2b-91eb-95dc4661416a')).toBe('01d89d86-4aee-4b2b-91eb-95dc4661416a');
    expect(parseDeliveredBy('01d89d86-4aee-4b2b-91eb-95dc4661416a:retry:1')).toBe('01d89d86-4aee-4b2b-91eb-95dc4661416a:retry:1');
    expect(parseDeliveredBy('5331A0992')).toBe('5331a0992');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '  ', 'soon', 'done', '#', 'abc', 'https://example.com/x', 42, null, undefined]) {
      expect(parseDeliveredBy(bad)).toBeNull();
    }
  });

  it('only backlog and ready may be closed as delivered', () => {
    expect(['backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled'].filter((s) => canCloseAsDelivered(s as never))).toEqual(['backlog', 'ready']);
  });
});
