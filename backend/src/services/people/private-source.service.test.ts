/**
 * Tests for the private-source tracker (issue #969).
 *
 * @module services/people/private-source.service.test
 */

import { PrivateSourceTracker, getPrivateSourceTracker, setPrivateSourceTrackerForTesting } from './private-source.service.js';

function make(now: { t: number }, windowMs = 60_000, maxSessions?: number) {
  return new PrivateSourceTracker({ now: () => now.t, windowMs, ...(maxSessions ? { maxSessions } : {}) });
}

describe('PrivateSourceTracker', () => {
  it('remembers who a session read for, newest first, and drops uses past the window', () => {
    const now = { t: 1000 };
    const t = make(now, 60_000);
    t.note('a-dev', 'UALICE', 'google-workspace');
    now.t += 10_000;
    t.note('a-dev', 'UBOB', 'canva');
    expect(t.recentPeople('a-dev')).toEqual(['UBOB', 'UALICE']);
    expect(t.recent('a-dev').map((u) => u.connectorId)).toEqual(['canva', 'google-workspace']);
    now.t += 55_000; // Alice's use is 65 s old, Bob's 55 s
    expect(t.recentPeople('a-dev')).toEqual(['UBOB']);
    now.t += 10_000;
    expect(t.recent('a-dev')).toEqual([]);
  });

  it('keeps one entry per person and connector, refreshed on each use', () => {
    const now = { t: 1000 };
    const t = make(now, 60_000);
    t.note('a-dev', 'UALICE', 'google-workspace');
    now.t += 50_000;
    t.note('a-dev', 'UALICE', 'google-workspace');
    now.t += 20_000; // 70 s after the first use, 20 s after the second
    expect(t.recent('a-dev')).toHaveLength(1);
    expect(t.recentPeople('a-dev')).toEqual(['UALICE']);
  });

  it('keeps sessions apart and ignores empty names', () => {
    const t = make({ t: 1000 });
    t.note('a-dev', 'UALICE', 'canva');
    t.note(undefined, 'UBOB', 'canva');
    t.note('a-ops', '', 'canva');
    expect(t.recentPeople('a-dev')).toEqual(['UALICE']);
    expect(t.recentPeople('a-ops')).toEqual([]);
    expect(t.recentPeople(undefined)).toEqual([]);
  });

  it('forgets the oldest sessions past the cap', () => {
    const now = { t: 1000 };
    const t = make(now, 60_000, 2);
    t.note('s1', 'UALICE', 'canva');
    t.note('s2', 'UALICE', 'canva');
    t.note('s3', 'UALICE', 'canva');
    expect(t.recentPeople('s1')).toEqual([]);
    expect(t.recentPeople('s3')).toEqual(['UALICE']);
    // a new use moves a session to the newest end
    now.t += 1_000;
    t.note('s2', 'UBOB', 'canva');
    t.note('s4', 'UALICE', 'canva');
    expect(t.recentPeople('s3')).toEqual([]);
    expect(t.recentPeople('s2')).toEqual(['UBOB', 'UALICE']);
  });

  it('reset() forgets everything', () => {
    const t = make({ t: 1000 });
    t.note('a-dev', 'UALICE', 'canva');
    t.reset();
    expect(t.recentPeople('a-dev')).toEqual([]);
  });
});

describe('singleton', () => {
  afterEach(() => setPrivateSourceTrackerForTesting(null));

  it('hands out one instance and lets tests replace it', () => {
    const a = getPrivateSourceTracker();
    expect(getPrivateSourceTracker()).toBe(a);
    const mine = new PrivateSourceTracker();
    setPrivateSourceTrackerForTesting(mine);
    expect(getPrivateSourceTracker()).toBe(mine);
  });
});
