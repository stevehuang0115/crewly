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
      '想法', '待处理', '进行中', '阻塞', '待验收', '已完成',
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
    expect(TICKET_ACCEPTANCE_SOURCE_LABEL).toMatchObject({ reject: '打回', decompose: '拆解', owner: '我' });
    expect(TICKET_ACCEPTANCE_CHECK_LABEL).toEqual({ auto: '自动', judgment: '人工' });
  });

  it('has text for every refusal code', () => {
    for (const code of ['not_in_review', 'already_done', 'open_work', 'cancelled', 'invalid']) {
      expect(TICKET_ERROR_TEXT[code]).toBeTruthy();
    }
  });
});
