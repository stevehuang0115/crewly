/**
 * Tests for Content Approval type constants.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTENT_APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
} from './content-approval.types.js';

describe('Content Approval Constants', () => {
  it('TTL is 24 hours in milliseconds', () => {
    expect(CONTENT_APPROVAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(CONTENT_APPROVAL_TTL_MS).toBe(86_400_000);
  });

  it('max pending approvals is a reasonable limit', () => {
    expect(MAX_PENDING_APPROVALS).toBeGreaterThan(0);
    expect(MAX_PENDING_APPROVALS).toBeLessThanOrEqual(100);
    expect(MAX_PENDING_APPROVALS).toBe(50);
  });
});
