/**
 * Tests for the briefing error type.
 */

import { BriefingError } from './briefing.types.js';

describe('BriefingError', () => {
  it('carries an HTTP status and a code', () => {
    const err = new BriefingError(409, 'confirm_mismatch', 'Confirm first');
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 409, code: 'confirm_mismatch', message: 'Confirm first', name: 'BriefingError' });
  });
});
