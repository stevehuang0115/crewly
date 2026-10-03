/**
 * Owner Session Constants Tests
 *
 * @module constants/owner-session.constants.test
 */

import { describe, it, expect } from 'vitest';
import { CSRF_HEADER, OWNER_AUTH_REQUIRED_ERROR, OWNER_SESSION_ENDPOINT, WRITE_METHODS } from './owner-session.constants';

describe('owner-session.constants', () => {
  it('match the backend (config/constants.ts OWNER_AUTH_CONSTANTS)', () => {
    expect(OWNER_SESSION_ENDPOINT).toBe('/api/auth/session');
    expect(CSRF_HEADER.toLowerCase()).toBe('x-crewly-csrf');
    expect(OWNER_AUTH_REQUIRED_ERROR).toBe('owner_auth_required');
    expect([...WRITE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
  });
});
