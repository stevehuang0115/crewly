/**
 * Fixture-driven integration tests for the intent classifier.
 *
 * Runs the regression fixtures from `intent-classifier.fixture.ts`
 * through the canonical classifier entry points
 * (`classifyIntentLevel`/`classifyIntentCategory`/`isActionableIntent`).
 *
 * **Failure-message contract:** the test name embeds the input + expected
 * level so a failing test points the engineer at the exact rule that
 * broke. The fixture's `rationale` field is logged via console.error
 * on failure so the spec section is one click away from the failure.
 *
 * @module services/intent-task/intent-classifier.fixture.test
 */

import { describe, it, expect } from '@jest/globals';

import {
  classifyIntentLevel,
  classifyIntentCategory,
  isActionableIntent,
} from '../../types/intent-task.types.js';
import {
  STEVE_DOGFOOD_FIXTURES,
  NEGATIVE_L2_FIXTURES,
  NON_ACTIONABLE_FIXTURES,
  L3_FIXTURES,
} from './intent-classifier.fixture.js';

describe('Steve dogfood mis-labels — must classify L2 with correct category', () => {
  it.each(STEVE_DOGFOOD_FIXTURES)(
    'L2: $input',
    ({ input, expectedLevel, expectedCategory, rationale }) => {
      const level = classifyIntentLevel(input);
      const category = classifyIntentCategory(input);
      if (level !== expectedLevel) {
        // eslint-disable-next-line no-console
        console.error(`FIXTURE FAIL [level]: input='${input}' rationale='${rationale}'`);
      }
      if (category !== expectedCategory) {
        // eslint-disable-next-line no-console
        console.error(`FIXTURE FAIL [category]: input='${input}' rationale='${rationale}'`);
      }
      expect(level).toBe(expectedLevel);
      expect(category).toBe(expectedCategory);
    },
  );
});

describe('Negative-L2 (Mia §3 anti-promotion guard)', () => {
  it.each(NEGATIVE_L2_FIXTURES)(
    '$expectedLevel: $input',
    ({ input, expectedLevel, expectedCategory, rationale }) => {
      const level = classifyIntentLevel(input);
      const category = classifyIntentCategory(input);
      if (level !== expectedLevel) {
        // eslint-disable-next-line no-console
        console.error(`FIXTURE FAIL [level]: input='${input}' rationale='${rationale}'`);
      }
      if (category !== expectedCategory) {
        // eslint-disable-next-line no-console
        console.error(`FIXTURE FAIL [category]: input='${input}' rationale='${rationale}'`);
      }
      expect(level).toBe(expectedLevel);
      expect(category).toBe(expectedCategory);
      // Critical: NEVER L2/L3 for these inputs.
      expect(level).not.toBe('L2');
      expect(level).not.toBe('L3');
    },
  );
});

describe('Non-actionable filter — must reject before classification', () => {
  it.each(NON_ACTIONABLE_FIXTURES)('rejects: $input', ({ input, rationale }) => {
    const actionable = isActionableIntent(input);
    if (actionable) {
      // eslint-disable-next-line no-console
      console.error(`FIXTURE FAIL [actionable]: input='${input}' rationale='${rationale}'`);
    }
    expect(actionable).toBe(false);
  });
});

describe('L3 fixtures — sprint/OKR markers + system-level scope', () => {
  it.each(L3_FIXTURES)('L3: $input', ({ input, expectedLevel, rationale }) => {
    const level = classifyIntentLevel(input);
    if (level !== expectedLevel) {
      // eslint-disable-next-line no-console
      console.error(`FIXTURE FAIL [level]: input='${input}' rationale='${rationale}'`);
    }
    expect(level).toBe(expectedLevel);
  });
});
