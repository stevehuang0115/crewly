import { WakeFailureTracker, formatWakeRestartNotice } from './wake-failure-tracker.js';

describe('WakeFailureTracker', () => {
  let t = 0;
  const mk = () => new WakeFailureTracker({ threshold: 3, cooldownMs: 1000, now: () => t });
  beforeEach(() => { t = 10_000; });

  it('restarts only on the 3rd consecutive failure', () => {
    const tr = mk();
    expect(tr.record('a', 'failed').action).toBe('none');
    expect(tr.record('a', 'failed').action).toBe('none');
    expect(tr.record('a', 'failed')).toEqual({ action: 'restart', failures: 3 });
  });

  it('a delivered wake resets the streak', () => {
    const tr = mk();
    tr.record('a', 'failed'); tr.record('a', 'failed'); tr.record('a', 'ok');
    expect(tr.record('a', 'failed').action).toBe('none');
  });

  it('skipped wakes neither count nor reset', () => {
    const tr = mk();
    tr.record('a', 'failed'); tr.record('a', 'skipped'); tr.record('a', 'failed');
    for (let i = 0; i < 20; i++) tr.record('b', 'skipped');
    expect(tr.record('b', 'failed').action).toBe('none');
    expect(tr.record('a', 'failed').action).toBe('restart');
  });

  it('tracks sessions independently', () => {
    const tr = mk();
    tr.record('a', 'failed'); tr.record('a', 'failed');
    expect(tr.record('b', 'failed').action).toBe('none');
  });

  it('honours the cooldown, then allows another restart', () => {
    const tr = mk();
    for (let i = 0; i < 3; i++) tr.record('a', 'failed');
    t += 999;
    for (let i = 0; i < 5; i++) expect(tr.record('a', 'failed').action).toBe('none');
    t += 2;
    expect(tr.record('a', 'failed').action).toBe('restart');
  });
});

describe('formatWakeRestartNotice', () => {
  it('names agent, count, and success', () => {
    const m = formatWakeRestartNotice('ce-vera', 3, true);
    expect(m).toContain('ce-vera'); expect(m).toContain('3'); expect(m).toContain('worked');
  });
  it('says FAILED and that no loop follows', () => {
    const m = formatWakeRestartNotice('ce-vera', 3, false);
    expect(m).toContain('FAILED'); expect(m).toContain('No further auto-restart');
  });
});
