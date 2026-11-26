/**
 * A running WorkItem's own timing (CREW-1079).
 *
 * A holder can be quiet on purpose: the item is due later, or the holder
 * scheduled a recheck for it and has nothing to do until then. The quiet-holder
 * rule must not take such an item back before that time. (CE-571, 2026-11-11:
 * waiting for a 12:00Z data sync with a 12:10Z recheck scheduled, requeued
 * 33 minutes in; 4 redeliveries and 3 wakes followed.)
 *
 * Two signals count, both structured. Dates written in the brief's prose do not.
 * An explicit block with `until` needs nothing here: blocking releases the
 * claim, so a blocked item is never taken for quiet.
 *
 * The hold is capped: a time more than {@link TIMED_WAIT_CONSTANTS.MAX_HOLD_MS}
 * ahead is ignored. It is ignored rather than clamped to now + cap, because
 * "now" moves on every pass and a clamped end would never arrive.
 *
 * @module services/reconciler/timed-wait
 */

import { TIMED_WAIT_CONSTANTS } from '../../constants.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/** `metadata` key holding when a WorkItem is due (ISO8601). */
const DUE_AT_KEY = 'dueAt';

/** Length of the id prefix agents use to name a WorkItem. */
const SHORT_ID_LENGTH = 8;

/** What a running WorkItem is waiting for. */
export interface TimedWait {
  /** The wait ends at this time (epoch ms), always in the future when returned */
  untilMs: number;
  /** What set the time, for logs and correction reasons */
  reason: string;
}

/**
 * Whether a text names a WorkItem by its full id or, for a UUID, by its first
 * eight characters as a whole word.
 *
 * @param text - Text to search
 * @param workItemId - The WorkItem id
 * @returns True when the text names the item
 */
function namesWorkItem(text: string, workItemId: string): boolean {
  const haystack = text.toLowerCase();
  const id = workItemId.toLowerCase();
  // A derived id (`<uuid>:retry:1`) must be named in full: its prefix is the source's.
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) return haystack.includes(id);
  // Not followed by `:`, which would name a derived item instead of this one.
  return new RegExp(`(?<![0-9a-z-])(${id}|${id.slice(0, SHORT_ID_LENGTH)})(?![0-9a-z:-])`).test(haystack);
}

/**
 * When a trigger will fire, if it is an active one-shot time trigger. A cron
 * trigger always has a next fire, so it would hold an item forever.
 *
 * @param trigger - The trigger
 * @returns Fire time (epoch ms), or null
 */
function oneShotFireTime(trigger: Trigger): number | null {
  if (trigger.status !== 'active' || trigger.config.type !== 'time' || trigger.config.cronExpression) return null;
  const at = Date.parse(trigger.nextFireAt ?? trigger.config.fireAt ?? '');
  return Number.isFinite(at) ? at : null;
}

/**
 * Whether a trigger is a recheck of this WorkItem: it says so
 * (`forWorkItemId`, or it wakes the item), or the holder scheduled it and
 * named the item in it. Harness-internal triggers (fallback checks, sweeps)
 * are not the holder's plan and never count.
 *
 * @param trigger - The trigger
 * @param workItem - The running item
 * @returns True when the trigger belongs to the item
 */
function isRecheckOf(trigger: Trigger, workItem: WorkItem): boolean {
  if (trigger.internal || trigger.createdBy === 'delegate-task' || trigger.createdBy === 'system') return false;
  if (trigger.forWorkItemId === workItem.id || trigger.action.wakeWorkItemId === workItem.id) return true;
  if (!workItem.target || trigger.createdBySession !== workItem.target) return false;
  // One that says which item it is for is not also for another it mentions.
  if (trigger.forWorkItemId) return false;
  const follow = trigger.action.createWorkItem;
  return namesWorkItem([trigger.name, follow?.title, follow?.description].filter(Boolean).join('\n'), workItem.id);
}

/**
 * The time a running WorkItem is legitimately waiting for: its due date or a
 * scheduled recheck, whichever is later, among those still in the future and
 * no further out than the hold cap. A time past the cap does not hide a nearer
 * one, and counts once it comes within the cap.
 *
 * @param workItem - The item
 * @param triggers - Triggers to look for rechecks in
 * @param now - Current time (epoch ms)
 * @returns The wait, or null when the item has no future time within the cap
 */
export function pendingTimedWait(workItem: WorkItem, triggers: ReadonlyArray<Trigger>, now: number): TimedWait | null {
  if (workItem.status !== 'running') return null;
  const waits: TimedWait[] = [];
  const dueAt = workItem.metadata?.[DUE_AT_KEY];
  if (typeof dueAt === 'string') {
    waits.push({ untilMs: Date.parse(dueAt), reason: `due at ${dueAt}` });
  }
  for (const trigger of triggers) {
    const at = oneShotFireTime(trigger);
    if (at !== null && isRecheckOf(trigger, workItem)) {
      waits.push({ untilMs: at, reason: `recheck ${trigger.id} scheduled for ${new Date(at).toISOString()}` });
    }
  }
  // NaN (an unparsable date) fails both comparisons and is dropped.
  const latestHeld = now + TIMED_WAIT_CONSTANTS.MAX_HOLD_MS;
  const pending = waits
    .filter((w) => w.untilMs > now && w.untilMs <= latestHeld)
    .sort((a, b) => b.untilMs - a.untilMs)[0];
  if (!pending) return null;
  const capHours = TIMED_WAIT_CONSTANTS.MAX_HOLD_MS / 3_600_000;
  return { ...pending, reason: `${pending.reason} (within the ${capHours}h hold cap; later times are ignored)` };
}

/**
 * The pending wait of every WorkItem that has one.
 *
 * @param workItems - The pass's WorkItems
 * @param triggers - Triggers to look for rechecks in
 * @param now - Current time (epoch ms)
 * @returns WorkItem id → its wait
 */
export function collectTimedWaits(
  workItems: ReadonlyArray<WorkItem>,
  triggers: ReadonlyArray<Trigger>,
  now: number = Date.now(),
): Map<string, TimedWait> {
  const out = new Map<string, TimedWait>();
  for (const workItem of workItems) {
    const wait = pendingTimedWait(workItem, triggers, now);
    if (wait) out.set(workItem.id, wait);
  }
  return out;
}
