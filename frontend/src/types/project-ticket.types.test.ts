/**
 * Tests for project ticket type helpers.
 */
import { describe, it, expect } from 'vitest';
import { ProjectTicketApiError, isProjectTicketStatus } from './project-ticket.types';

describe('project ticket types', () => {
  it('recognises statuses', () => {
    expect(isProjectTicketStatus('ready')).toBe(true);
    expect(isProjectTicketStatus('open')).toBe(false);
    expect(isProjectTicketStatus(1)).toBe(false);
  });

  it('carries the HTTP status on API errors', () => {
    const err = new ProjectTicketApiError('Not allowed', 403);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(err.name).toBe('ProjectTicketApiError');
  });
});
