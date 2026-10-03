/**
 * Tests for the signal digest type guard.
 *
 * @module types/signal-digest.types.test
 */

import { isSignalChoice } from './signal-digest.types.js';

describe('isSignalChoice', () => {
  it('accepts do and skip only', () => {
    expect(isSignalChoice('do')).toBe(true);
    expect(isSignalChoice('skip')).toBe(true);
    for (const v of ['Do', 'yes', '', null, undefined, 1]) expect(isSignalChoice(v)).toBe(false);
  });
});
