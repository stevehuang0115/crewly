import { OrcWakeCounter, formatOrcWakeLine } from './orc-wake-counter.js';
import { ORC_WAKE_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

describe('OrcWakeCounter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    OrcWakeCounter.resetInstance();
  });

  it('formats the hourly line; other = turns not explained by owner or status routing', () => {
    expect(formatOrcWakeLine({ turns: 14, owner: 3, delegatedDone: 2, escalations: 1, digest: 2, statusOther: 1 }))
      .toBe('orc wakes: 14 (owner 3, delegated-done 2, escalations 1, digest 2, other 6)');
    // Coalesced status events can outnumber turns: other never goes negative.
    expect(formatOrcWakeLine({ turns: 1, owner: 0, delegatedDone: 3, escalations: 0, digest: 0, statusOther: 0 })).toContain('other 0');
  });

  it('counts owner turns by source and status wakes by category, then resets on flush', () => {
    const c = new OrcWakeCounter(() => 0);
    c.noteTurn('slack');
    c.noteTurn('web_chat');
    c.noteTurn('system_event');
    c.noteRouted('delegated-done');
    c.noteRouted('owner'); // an owed owner delivery counts with delegated-done
    c.noteRouted('escalation');
    c.noteRouted('digest');
    expect(c.snapshot()).toEqual({ turns: 3, owner: 2, delegatedDone: 2, escalations: 1, digest: 1, statusOther: 0 });
    expect(c.flush()).toBe('orc wakes: 3 (owner 2, delegated-done 2, escalations 1, digest 1, other 0)');
    expect(c.snapshot().turns).toBe(0);
  });

  it('logs the line once an hour once started', () => {
    jest.useFakeTimers();
    const info = jest.fn();
    jest.spyOn(LoggerService.getInstance(), 'createComponentLogger').mockReturnValue({ info, warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never);
    const c = new OrcWakeCounter();
    c.start();
    c.start(); // idempotent
    c.noteTurn('slack');
    jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.COUNTER_LOG_INTERVAL_MS);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe('orc wakes: 1 (owner 1, delegated-done 0, escalations 0, digest 0, other 0)');
    jest.advanceTimersByTime(ORC_WAKE_CONSTANTS.COUNTER_LOG_INTERVAL_MS);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toBe('orc wakes: 0 (owner 0, delegated-done 0, escalations 0, digest 0, other 0)');
    c.stop();
  });
});
