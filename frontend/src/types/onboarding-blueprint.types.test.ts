/**
 * Tests for the V2.5 Blueprint type module.
 *
 * Type definitions don't run, so these tests cover the runtime
 * helpers (`createEmptyBlueprint`, `BLUEPRINT_BLOCK_IDS`) and a
 * handful of compile-time shape assertions guarded by `satisfies`
 * to lock the contract.
 *
 * @module types/onboarding-blueprint.test
 */

import { describe, it, expect } from 'vitest';
import {
  BLUEPRINT_BLOCK_IDS,
  createEmptyBlueprint,
  type BlueprintBlockId,
  type CandidateTask,
  type HirableWorkflow,
  type MatchReport,
  type MatchTier,
  type OnboardingBlueprint,
  type OnboardingMode,
  type OnboardingStage,
  type OnboardingStatus,
} from './onboarding-blueprint.types';

describe('createEmptyBlueprint', () => {
  it('returns a stage=S2 blueprint with no captured fields by default', () => {
    const bp = createEmptyBlueprint();
    expect(bp.stage).toBe('S2');
    expect(bp.businessProfile).toBeUndefined();
    expect(bp.candidateTasks).toBeUndefined();
    expect(bp.matchReport).toBeUndefined();
    expect(bp.staffedWorkflows).toBeUndefined();
    expect(bp.guardrails).toBeUndefined();
    expect(bp.brand).toBeUndefined();
  });

  it('honours stage overrides', () => {
    const bp = createEmptyBlueprint({ stage: 'S4' });
    expect(bp.stage).toBe('S4');
  });

  it('does not mutate the overrides object', () => {
    const overrides: Partial<OnboardingBlueprint> = { stage: 'S3' };
    const bp = createEmptyBlueprint(overrides);
    bp.stage = 'S5';
    expect(overrides.stage).toBe('S3');
  });

  it('accepts partial populated fields for fixture construction', () => {
    const bp = createEmptyBlueprint({
      stage: 'S3',
      businessProfile: {
        industry: 'SaaS',
        customer: 'SMBs',
      },
    });
    expect(bp.businessProfile?.industry).toBe('SaaS');
    expect(bp.businessProfile?.workflow).toBeUndefined();
  });
});

describe('BLUEPRINT_BLOCK_IDS', () => {
  it('declares the five blocks in spec render order', () => {
    expect(BLUEPRINT_BLOCK_IDS).toEqual([
      'business-profile',
      'match-report',
      'staffed-workflows',
      'guardrails',
      'brand',
    ]);
  });

  it('is frozen-by-construction (readonly tuple)', () => {
    // `as const` makes the array readonly at type-time. This test
    // documents that and guards against accidental conversion to a
    // mutable string[] in future edits.
    const ids: readonly BlueprintBlockId[] = BLUEPRINT_BLOCK_IDS;
    expect(ids).toHaveLength(5);
  });
});

describe('type shape (satisfies guards)', () => {
  it('OnboardingMode covers exactly normal | onboarding | escape-hatch', () => {
    const modes: OnboardingMode[] = ['normal', 'onboarding', 'escape-hatch'];
    expect(modes).toHaveLength(3);
  });

  it('OnboardingStage covers S2..S6', () => {
    const stages: OnboardingStage[] = ['S2', 'S3', 'S4', 'S5', 'S6'];
    expect(stages).toHaveLength(5);
  });

  it('MatchTier covers the 4 spec tiers', () => {
    const tiers: MatchTier[] = [
      'autonomous',
      'collaborative',
      'roadmap',
      'out-of-scope',
    ];
    expect(tiers).toHaveLength(4);
  });

  it('HirableWorkflow accepts the minimal required shape', () => {
    const w: HirableWorkflow = {
      workflowId: 'wf-1',
      name: 'Draft Newsletter',
      description: 'Drafts a weekly customer newsletter from CRM activity.',
    };
    expect(w.estimatedValue).toBeUndefined();
  });

  it('CandidateTask carries the topMatches scoring debug payload', () => {
    const task: CandidateTask = {
      raw: 'I want help with my newsletter',
      extractedIntent: 'newsletter-drafting',
      topMatches: [
        { workflowId: 'wf-1', score: 0.91 },
        { workflowId: 'wf-2', score: 0.74 },
      ],
      chosenTier: 'autonomous',
    };
    expect(task.topMatches[0].score).toBeGreaterThan(task.topMatches[1].score);
  });

  it('MatchReport always carries all 4 tiers (possibly empty arrays)', () => {
    const r: MatchReport = {
      autonomous: [],
      collaborative: [],
      roadmap: [],
      outOfScope: [],
    };
    // Asserting we can read each key without optional chaining proves
    // the contract — tiers are required, not optional.
    expect(r.autonomous.length + r.collaborative.length).toBe(0);
  });

  it('OnboardingStatus accepts the minimal shape (mode + loading)', () => {
    const s: OnboardingStatus = { mode: 'normal', loading: false };
    expect(s.stage).toBeUndefined();
    expect(s.error).toBeUndefined();
  });

  it('OnboardingStatus carries stage + error when populated', () => {
    const s: OnboardingStatus = {
      mode: 'onboarding',
      stage: 'S3',
      loading: false,
      error: 'transient network blip',
    };
    expect(s.stage).toBe('S3');
    expect(s.error).toMatch(/network/);
  });
});
