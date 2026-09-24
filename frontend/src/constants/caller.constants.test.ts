/**
 * Caller Identity Constants Tests
 *
 * @module constants/caller.constants.test
 */

import { describe, it, expect } from 'vitest';
import { CALLER_HEADER, DASHBOARD_CALLER, DASHBOARD_CALLER_HEADERS } from './caller.constants';

describe('caller.constants', () => {
  it('matches the backend header name and value (case-insensitive header)', () => {
    // Backend: API_SECURITY_CONSTANTS.CALLER_HEADER / DASHBOARD_CALLER
    expect(CALLER_HEADER.toLowerCase()).toBe('x-crewly-caller');
    expect(DASHBOARD_CALLER).toBe('dashboard');
  });

  it('builds the dashboard header map', () => {
    expect(DASHBOARD_CALLER_HEADERS).toEqual({ 'X-Crewly-Caller': 'dashboard' });
  });

  it('is frozen so a caller cannot mutate the shared map', () => {
    expect(Object.isFrozen(DASHBOARD_CALLER_HEADERS)).toBe(true);
  });
});
