/**
 * Tests for ticket type helpers (specs/ticket-loop.md).
 */

import {
  formatTicketNumber,
  parseTicketNumber,
  isTicketNumberRef,
  formatTicketMarker,
  parseTicketMarkers,
  uniqueTicketIdFromTexts,
  ticketPriorityLabel,
  deriveBoardColumn,
  isTicketBoardColumn,
  isTicketKind,
  inferTicketKind,
  ticketNeedsReview,
  activeAcceptance,
  parseReviewReply,
} from './ticket.types.js';

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('ticket numbers', () => {
  it('formats with a TKT- prefix, zero-padded to three digits', () => {
    expect(formatTicketNumber(7)).toBe('TKT-007');
    expect(formatTicketNumber(42)).toBe('TKT-042');
    expect(formatTicketNumber(1234)).toBe('TKT-1234');
  });

  it('parses TKT-123, tkt 123, TKT-007 and bare numbers', () => {
    expect(parseTicketNumber('TKT-123')).toBe(123);
    expect(parseTicketNumber('tkt-7')).toBe(7);
    expect(parseTicketNumber('TKT-007')).toBe(7);
    expect(parseTicketNumber(' tkt 12 ')).toBe(12);
    expect(parseTicketNumber('123')).toBe(123);
  });

  it('rejects non-number references', () => {
    expect(parseTicketNumber(ID_A)).toBeNull();
    expect(parseTicketNumber('TKT-')).toBeNull();
    expect(parseTicketNumber('0')).toBeNull();
    expect(parseTicketNumber('')).toBeNull();
  });

  it('isTicketNumberRef is true only for the TKT form', () => {
    expect(isTicketNumberRef('TKT-5')).toBe(true);
    expect(isTicketNumberRef('5')).toBe(false);
    expect(isTicketNumberRef(ID_A)).toBe(false);
  });
});

describe('delivered-message marker', () => {
  it('formats [TICKET:TKT-123 <id>]', () => {
    expect(formatTicketMarker({ id: ID_A, ticketNumber: 3 })).toBe(`[TICKET:TKT-003 ${ID_A}]`);
  });

  it('is empty for a Request without a number', () => {
    expect(formatTicketMarker({ id: ID_A })).toBe('');
  });

  it('parses every marker once, in order', () => {
    const text = `hi [TICKET:TKT-003 ${ID_A}] and [TICKET:TKT-004 ${ID_B}] again [TICKET:TKT-003 ${ID_A}]`;
    expect(parseTicketMarkers(text)).toEqual([
      { tkt: 'TKT-003', id: ID_A },
      { tkt: 'TKT-004', id: ID_B },
    ]);
  });

  it('uniqueTicketIdFromTexts returns the one ticket a turn is about', () => {
    expect(uniqueTicketIdFromTexts([`a [TICKET:TKT-001 ${ID_A}]`, '[SYSTEM] ping', `b [TICKET:TKT-001 ${ID_A}]`])).toBe(ID_A);
  });

  it('uniqueTicketIdFromTexts refuses to guess between two tickets', () => {
    expect(uniqueTicketIdFromTexts([`[TICKET:TKT-001 ${ID_A}]`, `[TICKET:TKT-002 ${ID_B}]`])).toBeNull();
  });

  it('uniqueTicketIdFromTexts is null without markers', () => {
    expect(uniqueTicketIdFromTexts(['plain text'])).toBeNull();
    expect(uniqueTicketIdFromTexts([])).toBeNull();
  });
});

describe('ticketPriorityLabel', () => {
  it('maps urgent/high/normal/low to P0..P3', () => {
    expect(ticketPriorityLabel('urgent')).toBe('P0');
    expect(ticketPriorityLabel('high')).toBe('P1');
    expect(ticketPriorityLabel('normal')).toBe('P2');
    expect(ticketPriorityLabel('low')).toBe('P3');
  });
});

describe('deriveBoardColumn', () => {
  const base = { requiresConfirmation: false } as const;

  it('open → To do, or Idea for kind=idea', () => {
    expect(deriveBoardColumn({ ...base, status: 'open', kind: 'feature' })).toBe('todo');
    expect(deriveBoardColumn({ ...base, status: 'open', kind: 'idea' })).toBe('idea');
    expect(deriveBoardColumn({ ...base, status: 'ready' })).toBe('todo');
  });

  it('running → In progress; blocked / waiting_confirmation → Blocked', () => {
    expect(deriveBoardColumn({ ...base, status: 'running' })).toBe('in_progress');
    expect(deriveBoardColumn({ ...base, status: 'blocked' })).toBe('blocked');
    expect(deriveBoardColumn({ ...base, status: 'waiting_confirmation' })).toBe('blocked');
  });

  it('done / cancelled map to their own columns', () => {
    expect(deriveBoardColumn({ ...base, status: 'done' })).toBe('done');
    expect(deriveBoardColumn({ ...base, status: 'cancelled' })).toBe('cancelled');
  });

  it('To review when confirmation is required and every WorkItem succeeded', () => {
    const wis = [{ status: 'done' }, { status: 'verified' }];
    expect(deriveBoardColumn({ status: 'waiting_confirmation', requiresConfirmation: true }, wis)).toBe('to_review');
    expect(deriveBoardColumn({ status: 'running', requiresConfirmation: true }, wis)).toBe('to_review');
    expect(deriveBoardColumn({ status: 'running', requiresConfirmation: true }, [{ status: 'running' }])).toBe('in_progress');
    expect(deriveBoardColumn({ status: 'running', requiresConfirmation: false }, wis)).toBe('in_progress');
    expect(deriveBoardColumn({ status: 'running', requiresConfirmation: true }, [])).toBe('in_progress');
  });
});

describe('guards and kind inference', () => {
  it('validates columns and kinds', () => {
    expect(isTicketBoardColumn('to_review')).toBe(true);
    expect(isTicketBoardColumn('nope')).toBe(false);
    expect(isTicketKind('idea')).toBe(true);
    expect(isTicketKind('bug')).toBe(false);
  });

  it('a 🐛 makes an issue, otherwise a feature', () => {
    expect(inferTicketKind('🐛 login is broken')).toBe('issue');
    expect(inferTicketKind('add dark mode')).toBe('feature');
  });
});

describe('Phase 2 review helpers', () => {
  it('ticketNeedsReview: numbered, requiresConfirmation, not cron/mission', () => {
    const base = { ticketNumber: 1, requiresConfirmation: true, origin: { channel: 'slack-dm' as const, ref: 'r', author: 'U' } };
    expect(ticketNeedsReview(base)).toBe(true);
    expect(ticketNeedsReview({ ...base, requiresConfirmation: false })).toBe(false);
    expect(ticketNeedsReview({ ...base, ticketNumber: undefined })).toBe(false);
    expect(ticketNeedsReview({ ...base, origin: { ...base.origin, channel: 'cron' } })).toBe(false);
    expect(ticketNeedsReview({ ...base, origin: { ...base.origin, channel: 'mission' } })).toBe(false);
  });

  it('activeAcceptance drops removed criteria', () => {
    expect(activeAcceptance([{ text: 'a' }, { text: 'b', removedAt: 'x' }]).map((a) => a.text)).toEqual(['a']);
    expect(activeAcceptance(undefined)).toEqual([]);
  });

  it.each(['验过了', '验收通过', '通过', '没问题了', '可以了！', 'LGTM', 'lgtm 👍', 'approved'])('%s → verify', (t) => {
    expect(parseReviewReply(t)).toEqual({ action: 'verify' });
  });

  it('打回 with and without a reason', () => {
    expect(parseReviewReply('打回：少了表头')).toEqual({ action: 'reject', reason: '少了表头' });
    expect(parseReviewReply('打回 数字是上个月的')).toEqual({ action: 'reject', reason: '数字是上个月的' });
    expect(parseReviewReply('reject - wrong file')).toEqual({ action: 'reject', reason: 'wrong file' });
    expect(parseReviewReply('打回')).toEqual({ action: 'reject', reason: '（未写原因）' });
  });

  it.each(['通过这个接口拿数据', '可以了吗？', '好的', 'please redo the header', 'hello'])('%s → nothing', (t) => {
    expect(parseReviewReply(t)).toBeNull();
  });

  it('a directly answered ticket in waiting_confirmation is 待验收 without WorkItems', () => {
    expect(deriveBoardColumn({ status: 'waiting_confirmation', requiresConfirmation: true })).toBe('to_review');
    expect(deriveBoardColumn({ status: 'waiting_confirmation', requiresConfirmation: false })).toBe('blocked');
  });
});
