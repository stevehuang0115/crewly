/**
 * Tests for the checklist fixtures.
 *
 * @module test/onboarding.fixtures.test
 */

import { describe, it, expect } from 'vitest';
import { makeChecklist, STARTERS } from './onboarding.fixtures';

describe('onboarding fixtures', () => {
  it('marks the given steps done and counts them', () => {
    const list = makeChecklist(['harness', 'cloud']);
    expect(list.steps.filter((s) => s.done).map((s) => s.id)).toEqual(['harness', 'cloud']);
    expect(list.doneCount).toBe(2);
    expect(list.allDone).toBe(false);
    expect(makeChecklist(['harness', 'team', 'first_task', 'cloud', 'slack']).allDone).toBe(true);
  });

  it('lists the recommended starter first and Blank last', () => {
    expect(STARTERS[0].recommended).toBe(true);
    expect(STARTERS[STARTERS.length - 1].id).toBe('blank');
  });
});
