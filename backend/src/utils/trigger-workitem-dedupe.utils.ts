/**
 * Duplicate checks for WorkItems created by triggers (`watch-for-event` and
 * friends).
 *
 * `agent:idle_after_task` fires on every busy→idle transition, and every
 * fire used to create a fresh WorkItem with a new id — so one delegation
 * could wake the reviewer several times to verify the same deliverable,
 * on top of the bridge's own `Verify:` item. These pure helpers let the
 * trigger action path skip a fire whose work is already open in the pool.
 *
 * @module utils/trigger-workitem-dedupe
 */

import { TERMINAL_WORK_ITEM_STATUSES, type WorkItem } from '../types/v2/work-item.types.js';

/** What the trigger is about to create. */
export interface TriggeredWorkItemDraft {
  /** Session the new WorkItem targets */
  target?: string;
  /** Owner of the new WorkItem */
  owner?: string;
  /** Title of the new WorkItem */
  title: string;
}

/** The parts of the trigger that identify an idle-verify watcher. */
export interface TriggerLike {
  /** Trigger configuration; only `signal` configs are inspected */
  config?: { type?: string; eventType?: string; filter?: Record<string, unknown> };
}

/** The event that fired an idle-after-task watcher. */
const IDLE_AFTER_TASK_EVENT = 'agent:idle_after_task';

/** Marker in the bridge's deterministic verification ids (`<id>:verify:<id>`). */
const VERIFY_ID_MARKER = ':verify:';

/** Words in a watcher title that mark it as a "verify the worker's output" watcher. */
const VERIFY_TITLE_RE = /verif/i;

/**
 * Whether a WorkItem is still open (not done, verified or cancelled).
 *
 * @param wi - WorkItem
 * @returns True when not in a terminal status
 */
function isOpen(wi: Pick<WorkItem, 'status'>): boolean {
  return !TERMINAL_WORK_ITEM_STATUSES.has(wi.status);
}

/**
 * An open WorkItem with the same target, owner and title as the one about to
 * be created, if any.
 *
 * @param items - Current pool items
 * @param draft - What the trigger would create
 * @returns The existing open item, or null
 */
export function findOpenDuplicateWorkItem(
  items: ReadonlyArray<WorkItem>,
  draft: TriggeredWorkItemDraft,
): WorkItem | null {
  return (
    items.find(
      (wi) =>
        isOpen(wi) &&
        wi.title === draft.title &&
        (wi.target ?? '') === (draft.target ?? '') &&
        (draft.owner === undefined || wi.owner === draft.owner),
    ) ?? null
  );
}

/**
 * For an idle-verify watcher (`agent:idle_after_task` on one worker, with a
 * "verify" title): the open bridge `Verify:` item that already covers that
 * worker's work for the same reviewer, if any. Such a fire adds nothing —
 * the worker reported done and the reviewer already has the item.
 *
 * @param items - Current pool items
 * @param trigger - The trigger that fired
 * @param draft - What the trigger would create (its target is the reviewer)
 * @returns The covering Verify item, or null (also for every other kind of trigger)
 */
export function findCoveringVerifyItem(
  items: ReadonlyArray<WorkItem>,
  trigger: TriggerLike,
  draft: TriggeredWorkItemDraft,
): WorkItem | null {
  const config = trigger.config;
  if (!config || config.type !== 'signal' || config.eventType !== IDLE_AFTER_TASK_EVENT) return null;
  if (!VERIFY_TITLE_RE.test(draft.title)) return null;
  const worker = typeof config.filter?.['sessionName'] === 'string' ? (config.filter['sessionName'] as string) : null;
  if (!worker) return null;
  const byId = new Map(items.map((wi) => [wi.id, wi]));
  return (
    items.find((wi) => {
      if (!isOpen(wi) || !wi.id.includes(VERIFY_ID_MARKER)) return false;
      if (draft.target && wi.target !== draft.target) return false;
      const sourceId = typeof wi.metadata?.['verifyOf'] === 'string'
        ? (wi.metadata['verifyOf'] as string)
        : wi.id.slice(0, wi.id.indexOf(VERIFY_ID_MARKER));
      return byId.get(sourceId)?.target === worker;
    }) ?? null
  );
}
