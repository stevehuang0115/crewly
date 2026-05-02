/**
 * Smoke tests for the visual-harness fixtures. Every fixture must
 * (a) have a valid stage and (b) be deeply non-mutated when read.
 *
 * @module components/Onboarding/v2-5/stories/fixtures.test
 */

import { describe, it, expect } from 'vitest';
import {
  FIXTURE_ALL_EMPTY,
  FIXTURE_ALL_POPULATED,
  FIXTURE_BUSINESS_PROFILE,
  FIXTURE_MATCH_REPORT,
} from './fixtures';

describe('fixtures', () => {
  it('FIXTURE_ALL_EMPTY is at S2 with no captured fields', () => {
    expect(FIXTURE_ALL_EMPTY.stage).toBe('S2');
    expect(FIXTURE_ALL_EMPTY.businessProfile).toBeUndefined();
    expect(FIXTURE_ALL_EMPTY.matchReport).toBeUndefined();
  });

  it('FIXTURE_BUSINESS_PROFILE has D1..D4 populated', () => {
    expect(FIXTURE_BUSINESS_PROFILE.stage).toBe('S3');
    expect(FIXTURE_BUSINESS_PROFILE.businessProfile?.industry).toBeTruthy();
    expect(FIXTURE_BUSINESS_PROFILE.businessProfile?.customer).toBeTruthy();
    expect(FIXTURE_BUSINESS_PROFILE.businessProfile?.workflow).toBeTruthy();
    expect(FIXTURE_BUSINESS_PROFILE.businessProfile?.pain).toBeTruthy();
    // Match Report not yet rendered at S3.
    expect(FIXTURE_BUSINESS_PROFILE.matchReport).toBeUndefined();
  });

  it('FIXTURE_MATCH_REPORT carries all 4 tiers with at least one entry across them', () => {
    const r = FIXTURE_MATCH_REPORT.matchReport;
    expect(r).toBeDefined();
    const total =
      (r?.autonomous.length ?? 0) +
      (r?.collaborative.length ?? 0) +
      (r?.roadmap.length ?? 0) +
      (r?.outOfScope.length ?? 0);
    expect(total).toBeGreaterThan(0);
    // CandidateTasks list is non-empty so the "why this tier" debug
    // pane has data when F3 lands W3.
    expect(FIXTURE_MATCH_REPORT.candidateTasks?.length ?? 0).toBeGreaterThan(0);
  });

  it('FIXTURE_ALL_POPULATED has every block populated', () => {
    expect(FIXTURE_ALL_POPULATED.businessProfile).toBeDefined();
    expect(FIXTURE_ALL_POPULATED.matchReport).toBeDefined();
    expect(FIXTURE_ALL_POPULATED.staffedWorkflows?.length ?? 0).toBeGreaterThan(0);
    expect(FIXTURE_ALL_POPULATED.guardrails?.length ?? 0).toBeGreaterThan(0);
    expect(FIXTURE_ALL_POPULATED.brand?.voiceChips.length ?? 0).toBeGreaterThan(0);
    expect(FIXTURE_ALL_POPULATED.brand?.tone).toBeTruthy();
    expect(FIXTURE_ALL_POPULATED.brand?.approvalChannel).toBeTruthy();
  });
});
