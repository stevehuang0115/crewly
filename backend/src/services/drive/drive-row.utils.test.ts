/**
 * Tests for the Drive mode chat-row mark.
 */

import { isDriveModeRow } from './drive-row.utils.js';

describe('isDriveModeRow', () => {
  it('is true only for rows Drive mode wrote', () => {
    expect(isDriveModeRow({ metadata: { via: 'drive-mode' } })).toBe(true);
    expect(isDriveModeRow({ metadata: { via: 'slack' } })).toBe(false);
    expect(isDriveModeRow({})).toBe(false);
    expect(isDriveModeRow(null)).toBe(false);
  });
});
