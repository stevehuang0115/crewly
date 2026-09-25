/**
 * Tests for the bundle constants.
 */

import { describe, expect, it } from 'vitest';
import { BUNDLE_API, BUNDLE_POLL_INTERVAL_MS, BUNDLE_STEP_STATUS_LABELS } from './bundle.constants';

describe('bundle constants', () => {
  it('builds encoded endpoints', () => {
    expect(BUNDLE_API.detail('smb-marketing-team')).toBe('/api/bundles/smb-marketing-team');
    expect(BUNDLE_API.job('job 1')).toBe('/api/bundles/apply/job%201');
    expect(BUNDLE_API.APPLY).toBe('/api/bundles/apply');
  });

  it('has a label for every step status and a sane poll interval', () => {
    expect(Object.keys(BUNDLE_STEP_STATUS_LABELS).sort()).toEqual(['done', 'failed', 'pending', 'queued', 'running', 'skipped']);
    expect(BUNDLE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });
});
