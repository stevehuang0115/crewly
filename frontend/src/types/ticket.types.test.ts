/**
 * Tests for ticket types' runtime helpers.
 */
import { describe, it, expect } from 'vitest';
import { TicketApiError, isTicketApiError } from './ticket.types';

describe('TicketApiError', () => {
  it('carries status and code', () => {
    const err = new TicketApiError('Ticket is not waiting for review', 409, 'not_in_review');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TicketApiError');
    expect(err.status).toBe(409);
    expect(err.code).toBe('not_in_review');
    expect(err.message).toBe('Ticket is not waiting for review');
  });

  it('allows a missing code', () => {
    expect(new TicketApiError('x', 500).code).toBeUndefined();
  });
});

describe('isTicketApiError', () => {
  it('recognises only TicketApiError', () => {
    expect(isTicketApiError(new TicketApiError('x', 404))).toBe(true);
    expect(isTicketApiError(new Error('x'))).toBe(false);
    expect(isTicketApiError('x')).toBe(false);
    expect(isTicketApiError(null)).toBe(false);
  });
});
