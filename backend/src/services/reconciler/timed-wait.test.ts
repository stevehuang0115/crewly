/**
 * Tests for a running WorkItem's own timing (CREW-1079).
 */

import { collectTimedWaits, pendingTimedWait } from './timed-wait.js';
import { TIMED_WAIT_CONSTANTS } from '../../constants.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/index.js';
import { createTrigger, type Trigger } from '../../types/v2/trigger.types.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-11T02:56:00Z');
const RECHECK = '2026-11-11T12:10:00.000Z';
const ID = 'b8698146-8ee5-4949-905c-5190124abdd0';
const VERA = 'ce-vera';

function running(extra: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'team_lead', title: 'Close three follow-ups', target: VERA }),
    id: ID,
    status: 'running',
    ...extra,
  };
}

/** The follow-up Vera scheduled in the incident. */
function recheck(extra: Partial<Trigger> = {}): Trigger {
  return {
    ...createTrigger({
      type: 'time',
      config: { type: 'time', fireAt: RECHECK },
      action: { createWorkItem: { type: 'delegate', target: VERA, title: 'b8698146 item1: recheck SES suppression after 12:00Z sync' } },
      createdBy: 'agent',
      createdBySession: VERA,
      name: 'followup:59932fe8',
    }),
    nextFireAt: RECHECK,
    ...extra,
  };
}

const unnamed = { createWorkItem: { type: 'delegate' as const, target: VERA, title: 'Poll the inbox' } };

describe('pendingTimedWait', () => {
  it('waits for a due date in the future', () => {
    const wi = running({ metadata: { dueAt: '2026-11-11T18:00:00Z' } });
    expect(pendingTimedWait(wi, [], NOW)).toEqual({
      untilMs: Date.parse('2026-11-11T18:00:00Z'),
      reason: 'due at 2026-11-11T18:00:00Z (within the 24h hold cap; later times are ignored)',
    });
  });

  it('stops waiting once the due date has passed', () => {
    const wi = running({ metadata: { dueAt: '2026-11-11T18:00:00Z' } });
    expect(pendingTimedWait(wi, [], Date.parse('2026-11-11T18:00:00Z'))).toBeNull();
  });

  it('has nothing to wait for without a signal, or with an unreadable date', () => {
    expect(pendingTimedWait(running(), [], NOW)).toBeNull();
    expect(pendingTimedWait(running({ metadata: { dueAt: 'tomorrow' } }), [], NOW)).toBeNull();
    // A date only in the brief's prose is not a signal.
    expect(pendingTimedWait(running({ description: 'all read-only, by 11/11 18:00Z' }), [], NOW)).toBeNull();
  });

  it('waits for the recheck the holder scheduled and named the item in (CE-571)', () => {
    expect(pendingTimedWait(running(), [recheck()], NOW)?.untilMs).toBe(Date.parse(RECHECK));
  });

  it('stops waiting when the recheck time passes, or the trigger is over', () => {
    expect(pendingTimedWait(running(), [recheck()], Date.parse(RECHECK) + 1)).toBeNull();
    for (const status of ['exhausted', 'cancelled', 'paused'] as const) {
      expect(pendingTimedWait(running(), [recheck({ status })], NOW)).toBeNull();
    }
  });

  it('counts a trigger that says which item it is for, or wakes it', () => {
    expect(pendingTimedWait(running(), [recheck({ action: unnamed, forWorkItemId: ID, createdBySession: 'ce-owen' })], NOW)).not.toBeNull();
    expect(pendingTimedWait(running(), [recheck({ action: { wakeWorkItemId: ID } })], NOW)).not.toBeNull();
  });

  it.each<[string, Partial<Trigger>]>([
    ['one that names no item', { action: unnamed }],
    ['one someone else scheduled that mentions the item', { createdBySession: 'ce-owen' }],
    ['one for another item that mentions this one', { forWorkItemId: 'a597e1c9-8d83-4be6-9594-379330b3d566' }],
    ['a harness-internal one', { internal: true }],
    ['a delegation fallback check', { createdBy: 'delegate-task' }],
    ['a cron', { config: { type: 'time', cronExpression: '0 * * * *' } }],
    ['an event watcher', { config: { type: 'signal', eventType: 'agent:idle' }, nextFireAt: undefined }],
  ])('does not count %s', (_label, extra) => {
    expect(pendingTimedWait(running(), [recheck(extra)], NOW)).toBeNull();
  });

  it('does not take a mention of a derived item for the item, or of the source for its retry', () => {
    const forRetry = recheck({ action: { createWorkItem: { title: `recheck ${ID}:retry:1` } } });
    expect(pendingTimedWait(running(), [forRetry], NOW)).toBeNull();
    expect(pendingTimedWait(running({ id: `${ID}:retry:1` }), [forRetry], NOW)).not.toBeNull();
    expect(pendingTimedWait(running({ id: `${ID}:retry:1` }), [recheck()], NOW)).toBeNull();
  });

  it('takes the latest of several pending times', () => {
    const wi = running({ metadata: { dueAt: new Date(NOW + HOUR).toISOString() } });
    expect(pendingTimedWait(wi, [recheck()], NOW)?.untilMs).toBe(Date.parse(RECHECK));
  });

  describe('hold cap', () => {
    const CAP = TIMED_WAIT_CONSTANTS.MAX_HOLD_MS;
    const dueIn = (ms: number) => running({ metadata: { dueAt: new Date(NOW + ms).toISOString() } });
    const recheckIn = (ms: number) => {
      const at = new Date(NOW + ms).toISOString();
      return recheck({ config: { type: 'time', fireAt: at }, nextFireAt: at });
    };

    it('is 24 hours', () => {
      expect(CAP).toBe(24 * HOUR);
    });

    it('holds for a time up to the cap', () => {
      expect(pendingTimedWait(dueIn(CAP), [], NOW)?.untilMs).toBe(NOW + CAP);
      expect(pendingTimedWait(running(), [recheckIn(CAP)], NOW)?.untilMs).toBe(NOW + CAP);
    });

    it('does not hold for a time beyond the cap', () => {
      expect(pendingTimedWait(dueIn(CAP + 1), [], NOW)).toBeNull();
      expect(pendingTimedWait(running(), [recheckIn(14 * 24 * HOUR)], NOW)).toBeNull();
    });

    it('counts a far time once it comes within the cap', () => {
      expect(pendingTimedWait(dueIn(3 * CAP), [], NOW + 2 * CAP)?.untilMs).toBe(NOW + 3 * CAP);
    });

    it('still holds for a near recheck when the due date is beyond the cap', () => {
      expect(pendingTimedWait(dueIn(3 * CAP), [recheckIn(HOUR)], NOW)?.untilMs).toBe(NOW + HOUR);
    });
  });

  it('applies to running items only', () => {
    const wi = running({ status: 'queued', metadata: { dueAt: '2026-11-11T18:00:00Z' } });
    expect(pendingTimedWait(wi, [recheck()], NOW)).toBeNull();
  });
});

describe('collectTimedWaits', () => {
  it('returns only the items that are waiting', () => {
    const other = running({ id: 'wi-other' });
    expect([...collectTimedWaits([running(), other], [recheck()], NOW).keys()]).toEqual([ID]);
  });
});
