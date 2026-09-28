/**
 * Tests for the project tickets board constants.
 */
import { describe, it, expect } from 'vitest';
import {
  PROJECT_TICKET_PRIORITIES,
  PROJECT_TICKET_PRIORITY_CLASSES,
  PROJECT_TICKET_STATUS_LABELS,
  PROJECT_TICKET_STATUS_ORDER,
  PROJECT_TICKET_TRANSITIONS,
  DEFAULT_PROJECT_TICKET_PRIORITY,
} from './project-tickets.constants';

describe('project tickets constants', () => {
  it('labels every status and orders the board like the backend', () => {
    expect(PROJECT_TICKET_STATUS_ORDER).toEqual(['backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled']);
    for (const s of PROJECT_TICKET_STATUS_ORDER) expect(PROJECT_TICKET_STATUS_LABELS[s]).toBeTruthy();
  });

  it('never offers in_progress as a manual move (claim / assign start work)', () => {
    for (const s of PROJECT_TICKET_STATUS_ORDER) expect(PROJECT_TICKET_TRANSITIONS[s]).not.toContain('in_progress');
  });

  it('has a badge per priority and a valid default', () => {
    for (const p of PROJECT_TICKET_PRIORITIES) expect(PROJECT_TICKET_PRIORITY_CLASSES[p]).toContain('bg-');
    expect(PROJECT_TICKET_PRIORITIES).toContain(DEFAULT_PROJECT_TICKET_PRIORITY);
  });
});
