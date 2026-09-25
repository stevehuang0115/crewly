/**
 * Tests for the Onboarding barrel.
 *
 * @module components/Onboarding/index.test
 */

import { describe, it, expect } from 'vitest';
import * as Onboarding from './index';

describe('Onboarding barrel', () => {
  it('exports the step indicator and the checklist steps, not the removed wizard', () => {
    expect(Object.keys(Onboarding).sort()).toEqual(
      ['CloudConnectStep', 'FirstTaskStep', 'GettingStartedCard', 'SlackConnectStep', 'StarterTeamStep', 'StepIndicator'].sort(),
    );
  });
});
