/**
 * Drive mode keep-warm registry: lists per session, expiry, the end, the
 * newly-warm agents to pre-start.
 */

import { DriveKeepWarm, getDriveKeepWarm, isDriveWarm, setDriveKeepWarm } from './drive-keep-warm.js';

describe('DriveKeepWarm', () => {
  let clock = 1_000_000;
  const now = () => clock;

  afterEach(() => setDriveKeepWarm(new DriveKeepWarm()));

  it('keeps a session\'s agents warm until its time, and says which are new', () => {
    const k = new DriveKeepWarm(now);
    expect(k.set('drv_a', ['ella-1', 'owen-1'], clock + 60_000)).toEqual(['ella-1', 'owen-1']);
    expect(k.isWarm('ella-1')).toBe(true);
    expect(k.isWarm('vera-1')).toBe(false);
    // The reminder repeats the list: nothing new to pre-start.
    expect(k.set('drv_a', ['ella-1', 'owen-1'], clock + 120_000)).toEqual([]);
    clock += 121_000;
    expect(k.isWarm('ella-1')).toBe(false);
    expect(k.warmAgents()).toEqual([]);
  });

  it('two sessions add up; ending one keeps the other\'s', () => {
    const k = new DriveKeepWarm(now);
    k.set('drv_a', ['ella-1'], clock + 60_000);
    k.set('drv_b', ['owen-1'], clock + 60_000);
    k.end('drv_a');
    expect(k.warmAgents()).toEqual(['owen-1']);
    // An empty list (or a past time) clears the session.
    k.set('drv_b', [], clock + 60_000);
    expect(k.warmAgents()).toEqual([]);
  });

  it('isDriveWarm reads the process-wide registry', () => {
    const k = new DriveKeepWarm(now);
    setDriveKeepWarm(k);
    expect(getDriveKeepWarm()).toBe(k);
    k.set('drv_a', ['ella-1'], clock + 1000);
    expect(isDriveWarm('ella-1')).toBe(true);
    expect(isDriveWarm('owen-1')).toBe(false);
  });
});
