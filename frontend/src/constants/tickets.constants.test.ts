/**
 * Tests for ticket board constants.
 */
import { describe, it, expect } from 'vitest';
import {
  MS_PER_DAY,
  TICKETS_API_BASE,
  TICKETS_POLL_INTERVAL_MS,
  TICKETS_ROUTE,
  TICKET_ACCEPTANCE_CHECK_LABEL,
  TICKET_ACCEPTANCE_SOURCE_LABEL,
  TICKET_BOARD_COLUMN_ORDER,
  TICKET_BOARD_TEXT,
  TICKET_EMPTY_COLUMN_TEXT,
  TICKET_COLUMN_LABEL,
  TICKET_ERROR_TEXT,
  TICKET_KINDS,
  TICKET_KIND_LABEL,
  TICKET_PRIORITY_OPTIONS,
  TICKET_PRIORITY_VARIANT,
} from './tickets.constants';

describe('tickets constants', () => {
  it('points at the tickets API and route', () => {
    expect(TICKETS_API_BASE).toBe('/api/tickets');
    expect(TICKETS_ROUTE).toBe('/tickets');
  });

  it('polls about every 15 seconds', () => {
    expect(TICKETS_POLL_INTERVAL_MS).toBe(15_000);
  });

  it('has a day in ms', () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });

  it('shows six columns in board order, without cancelled', () => {
    expect(TICKET_BOARD_COLUMN_ORDER).toEqual(['idea', 'todo', 'in_progress', 'blocked', 'to_review', 'done']);
    expect(TICKET_BOARD_COLUMN_ORDER.map((c) => TICKET_COLUMN_LABEL[c])).toEqual([
      'Ideas', 'To do', 'In progress', 'Blocked', 'To review', 'Done',
    ]);
  });

  it('labels every kind', () => {
    for (const k of TICKET_KINDS) expect(TICKET_KIND_LABEL[k]).toBeTruthy();
  });

  it('maps priorities to P0..P3, most urgent first, each with a badge variant', () => {
    expect(TICKET_PRIORITY_OPTIONS.map((p) => `${p.value}:${p.label}`)).toEqual([
      'urgent:P0', 'high:P1', 'normal:P2', 'low:P3',
    ]);
    for (const p of TICKET_PRIORITY_OPTIONS) expect(TICKET_PRIORITY_VARIANT[p.label]).toBeTruthy();
  });

  it('labels acceptance sources and checks', () => {
    expect(TICKET_ACCEPTANCE_SOURCE_LABEL).toMatchObject({ reject: 'Sent back', decompose: 'Breakdown', owner: 'Me' });
    expect(TICKET_ACCEPTANCE_CHECK_LABEL).toEqual({ auto: 'Auto', judgment: 'Manual' });
  });

  it('has text for every refusal code', () => {
    for (const code of ['not_in_review', 'already_done', 'open_work', 'cancelled', 'invalid']) {
      expect(TICKET_ERROR_TEXT[code]).toBeTruthy();
    }
  });
});

describe('ticket kinds (#827)', () => {
  it('lists the question kind with its own label, and labels every kind', () => {
    expect(TICKET_KINDS).toContain('question');
    expect(TICKET_KIND_LABEL.question).toBe('Question');
    for (const k of TICKET_KINDS) expect(TICKET_KIND_LABEL[k]).toBeTruthy();
    // Distinct labels, so a question never reads as an issue.
    expect(new Set(TICKET_KINDS.map((k) => TICKET_KIND_LABEL[k])).size).toBe(TICKET_KINDS.length);
  });
});

describe('redesigned board copy', () => {
  it('has an empty text for every column, including cancelled', () => {
    for (const c of [...TICKET_BOARD_COLUMN_ORDER, 'cancelled' as const]) expect(TICKET_EMPTY_COLUMN_TEXT[c]).toBeTruthy();
  });
  it('is English and non-empty', () => {
    for (const v of Object.values(TICKET_BOARD_TEXT)) {
      expect(v.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fff]/.test(v)).toBe(false);
    }
  });
});
