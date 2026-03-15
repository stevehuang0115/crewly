/**
 * Tests for Cloud Auth Client (token helpers)
 *
 * @module services/supabase.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getAccessToken, getRefreshToken, storeTokens, clearTokens } from './supabase';

describe('Cloud Auth Token Helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should return null when no tokens are stored', () => {
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('should store and retrieve tokens', () => {
    storeTokens('access-abc', 'refresh-xyz');
    expect(getAccessToken()).toBe('access-abc');
    expect(getRefreshToken()).toBe('refresh-xyz');
  });

  it('should overwrite existing tokens', () => {
    storeTokens('old-access', 'old-refresh');
    storeTokens('new-access', 'new-refresh');
    expect(getAccessToken()).toBe('new-access');
    expect(getRefreshToken()).toBe('new-refresh');
  });

  it('should clear tokens', () => {
    storeTokens('access-abc', 'refresh-xyz');
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});
