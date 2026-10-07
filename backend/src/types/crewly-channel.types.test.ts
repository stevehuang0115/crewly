/**
 * Tests for the Crewly channel registry type guard.
 *
 * @module types/crewly-channel.types.test
 */

import { isCrewlyChannelRecord } from './crewly-channel.types.js';

describe('isCrewlyChannelRecord', () => {
  const ok = { id: 'huddle-1', name: 'tech-brief', origin: 'crewly', createdAt: '2026-10-07T00:00:00.000Z' };

  it('accepts a minimal row and one linked to Slack', () => {
    expect(isCrewlyChannelRecord(ok)).toBe(true);
    expect(isCrewlyChannelRecord({ ...ok, origin: 'slack', slackChannelId: 'C1' })).toBe(true);
  });

  it('rejects rows missing an id, a name, a known origin or with a bad Slack id', () => {
    expect(isCrewlyChannelRecord(null)).toBe(false);
    expect(isCrewlyChannelRecord({ ...ok, id: '' })).toBe(false);
    expect(isCrewlyChannelRecord({ ...ok, name: 3 })).toBe(false);
    expect(isCrewlyChannelRecord({ ...ok, origin: 'team' })).toBe(false);
    expect(isCrewlyChannelRecord({ ...ok, slackChannelId: 7 })).toBe(false);
  });
});
