/**
 * Tests for safe URL helpers.
 *
 * @module utils/safe-url.test
 */

import { describe, it, expect } from 'vitest';
import { isSafeHttpUrl } from './safe-url';

describe('isSafeHttpUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(isSafeHttpUrl('https://claude.ai/oauth/authorize?code=true')).toBe(true);
    expect(isSafeHttpUrl('http://localhost:1455/auth')).toBe(true);
  });

  it('rejects other schemes, relative and empty values', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,hi')).toBe(false);
    expect(isSafeHttpUrl('/relative')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
  });
});
