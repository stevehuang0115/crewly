/**
 * Tests for ticket board helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  autoAcceptLabel,
  daysUntilAutoAccept,
  formatOrigin,
  formatTicketTime,
  groupTicketsByColumn,
  ticketErrorMessage,
  toAcceptanceInputs,
} from './ticket.utils';
import { TicketApiError, type TicketListItem } from '../types/ticket.types';

const NOW = Date.parse('2026-09-24T00:00:00Z');

/**
 * Build a board row.
 *
 * @param over - Field overrides
 * @returns The row
 */
function row(over: Partial<TicketListItem>): TicketListItem {
  return {
    id: 'r1', tkt: 'TKT-001', title: 't', kind: 'feature', column: 'todo', status: 'open',
    priority: 'normal', priorityLabel: 'P2', origin: null, assignee: null, workItemIds: [], tags: [],
    createdAt: '', updatedAt: '', ...over,
  };
}

describe('groupTicketsByColumn', () => {
  it('buckets rows by column and keeps order', () => {
    const g = groupTicketsByColumn([
      row({ id: 'a', column: 'todo' }),
      row({ id: 'b', column: 'to_review' }),
      row({ id: 'c', column: 'todo' }),
    ]);
    expect(g.todo.map((t) => t.id)).toEqual(['a', 'c']);
    expect(g.to_review.map((t) => t.id)).toEqual(['b']);
    expect(g.idea).toEqual([]);
    expect(g.done).toEqual([]);
  });
});

describe('daysUntilAutoAccept / autoAcceptLabel', () => {
  it('rounds partial days up', () => {
    expect(daysUntilAutoAccept('2026-09-26T12:00:00Z', NOW)).toBe(3);
    expect(autoAcceptLabel('2026-09-27T00:00:00Z', NOW)).toBe('Auto-accepts in 3 days');
  });

  it('says soon when due or past', () => {
    expect(daysUntilAutoAccept('2026-09-20T00:00:00Z', NOW)).toBe(0);
    expect(autoAcceptLabel('2026-09-20T00:00:00Z', NOW)).toBe('Auto-accepts soon');
  });

  it('returns null without a (valid) deadline', () => {
    expect(daysUntilAutoAccept(null, NOW)).toBeNull();
    expect(daysUntilAutoAccept('not a date', NOW)).toBeNull();
    expect(autoAcceptLabel(undefined, NOW)).toBeNull();
  });
});

describe('formatOrigin', () => {
  it('names the channel and the author', () => {
    expect(formatOrigin({ channel: 'slack-dm', author: 'U1', authorName: 'Steve' })).toBe('Slack DM · Steve');
    expect(formatOrigin({ channel: 'chat', author: 'owner' })).toBe('Chat · owner');
  });

  it('shows unknown channels as-is and null for no origin', () => {
    expect(formatOrigin({ channel: 'fax', author: '' })).toBe('fax');
    expect(formatOrigin(null)).toBeNull();
  });
});

describe('formatTicketTime', () => {
  it('formats a valid time and passes through junk', () => {
    expect(formatTicketTime('2026-09-24T00:00:00Z')).not.toBe('');
    expect(formatTicketTime('junk')).toBe('junk');
    expect(formatTicketTime(null)).toBe('');
  });
});

describe('toAcceptanceInputs', () => {
  it('keeps text and check only', () => {
    expect(toAcceptanceInputs([
      { text: 'a', check: 'auto', source: 'decompose', selfCheck: 'pass' },
      { text: 'b' },
    ])).toEqual([{ text: 'a', check: 'auto' }, { text: 'b' }]);
    expect(toAcceptanceInputs(undefined)).toEqual([]);
  });
});

describe('ticketErrorMessage', () => {
  it('translates known refusal codes', () => {
    expect(ticketErrorMessage(new TicketApiError('x', 409, 'open_work'))).toBe('Some work items are still open, so it cannot be accepted yet');
  });

  it('falls back to the message', () => {
    expect(ticketErrorMessage(new TicketApiError('Ticket not found', 404))).toBe('Ticket not found');
    expect(ticketErrorMessage(new Error('boom'))).toBe('boom');
    expect(ticketErrorMessage('plain')).toBe('plain');
  });
});
