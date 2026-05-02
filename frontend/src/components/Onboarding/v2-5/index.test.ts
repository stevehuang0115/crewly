/**
 * Smoke test for the v2-5 barrel — every public export is reachable
 * and non-undefined. Catches accidental dropped re-exports during
 * future refactors.
 *
 * @module components/Onboarding/v2-5/index.test
 */

import { describe, it, expect } from 'vitest';
import * as v25 from './index';

describe('Onboarding/v2-5 barrel', () => {
  it('exports the gate / shell / sidebar', () => {
    expect(v25.OnboardingGate).toBeTypeOf('function');
    expect(v25.OnboardingShell).toBeTypeOf('function');
    expect(v25.BlueprintSidebar).toBeTypeOf('function');
  });

  it('exports the blueprint context + hook', () => {
    expect(v25.OnboardingBlueprintProvider).toBeTypeOf('function');
    expect(v25.useOnboardingBlueprint).toBeTypeOf('function');
  });

  it('exports the orc-status hook + test helper', () => {
    expect(v25.useOnboardingStatus).toBeTypeOf('function');
    expect(v25.setOnboardingStatusForTests).toBeTypeOf('function');
  });

  it('exports all five sidebar blocks + the shared block shell', () => {
    expect(v25.BusinessProfileBlock).toBeTypeOf('function');
    expect(v25.MatchReportBlock).toBeTypeOf('function');
    expect(v25.StaffedWorkflowsBlock).toBeTypeOf('function');
    expect(v25.GuardrailsBlock).toBeTypeOf('function');
    expect(v25.BrandBlock).toBeTypeOf('function');
    expect(v25.BlueprintBlock).toBeTypeOf('function');
  });
});
