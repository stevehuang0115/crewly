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

  it('after markRestartFailed, no restart even past the cooldown, until an ok wake', () => {
    const tr = mk();
    for (let i = 0; i < 3; i++) tr.record('a', 'failed');
    tr.markRestartFailed('a');
    t += 10_000;
    for (let i = 0; i < 6; i++) expect(tr.record('a', 'failed').action).toBe('none');
    tr.record('a', 'ok');
    for (let i = 0; i < 2; i++) tr.record('a', 'failed');
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
    const m = formatWakeRestartNotice('ce-vera', 3, 'restarted');
    expect(m).toContain('ce-vera'); expect(m).toContain('3'); expect(m).toContain('worked');
  });
  it('says STOPPED when the stop worked and the start did not', () => {
    const m = formatWakeRestartNotice('ce-vera', 3, 'stopped_not_started');
    expect(m).toContain('now STOPPED'); expect(m).toContain('No more auto-restarts');
  });
  it('says the agent is still running when nothing was stopped', () => {
    const m = formatWakeRestartNotice('ce-vera', 3, 'not_restarted');
    expect(m).toContain('still running'); expect(m).toContain('No further auto-restart');
  });
});
