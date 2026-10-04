import { describe, it, expect } from 'vitest';
import { isTeamPaused, localDateTimeToIso, pauseSummary } from './team-pause.utils';

const NOW = Date.parse('2026-10-04T12:00:00Z');

describe('team-pause.utils (specs/2026-10-04-team-pause.md)', () => {
  it('prefers the server pausedNow flag', () => {
    expect(isTeamPaused({ pausedNow: true })).toBe(true);
    expect(isTeamPaused({ pausedNow: false, paused: { pausedAt: 'x', by: 'owner' } })).toBe(false);
  });

  it('falls back to paused + until', () => {
    expect(isTeamPaused({ paused: { pausedAt: 'x', by: 'owner' } }, NOW)).toBe(true);
    expect(isTeamPaused({ paused: { pausedAt: 'x', by: 'owner', until: '2026-10-05T00:00:00Z' } }, NOW)).toBe(true);
    expect(isTeamPaused({ paused: { pausedAt: 'x', by: 'owner', until: '2026-10-01T00:00:00Z' } }, NOW)).toBe(false);
    expect(isTeamPaused({})).toBe(false);
    expect(isTeamPaused(null)).toBe(false);
  });

  it('summarises a pause', () => {
    expect(pauseSummary({ paused: { pausedAt: 'x', by: 'owner', reason: 'harness' } })).toBe('Paused by you — harness');
    expect(pauseSummary({})).toBe('Paused');
  });

  it('converts a datetime-local value to ISO', () => {
    expect(localDateTimeToIso('')).toBeUndefined();
    expect(localDateTimeToIso('nonsense')).toBeUndefined();
    expect(localDateTimeToIso('2026-10-10T09:00')).toBe(new Date('2026-10-10T09:00').toISOString());
  });
});
