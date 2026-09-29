/**
 * Tests for clipboard constants.
 *
 * @module constants/clipboard.constants.test
 */

import { describe, it, expect } from 'vitest';
import { CLIPBOARD_CONSTANTS } from './clipboard.constants';

describe('CLIPBOARD_CONSTANTS', () => {
  it('has a positive feedback duration and English labels', () => {
    expect(CLIPBOARD_CONSTANTS.FEEDBACK_MS).toBeGreaterThan(0);
    expect(CLIPBOARD_CONSTANTS.COPIED_LABEL).toBe('Copied');
    expect(CLIPBOARD_CONSTANTS.FAILED_LABEL).toMatch(/manually/);
  });
});
