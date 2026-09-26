/**
 * Request completion — the single answer to "has this Request actually been
 * delivered?"
 *
 * Three writers used to decide it independently (the reconciler's
 * `reconcileRequestStatus`, the event-driven `cascadeRequestStatus`, and the
 * heartbeat's `closeStaleRequest`), and each had a variant of the same hole:
 * a Request counted as done as soon as its WorkItems were terminal and at
 * least one of them said `verified` — whatever that item was.
 *
 * Incident 2026-09-26, Request d86b5faf ("Demand test: one-click deploy a
 * ready-made AI team"): auto-decomposed into Plan → Execute → Review, all for
 * the orchestrator, plus a direct item for Ella. The orchestrator re-routed
 * the work to Ella as a NEW WorkItem (806dc528, which carried the request id
 * only in its title), completed Plan and Execute as "re-routed / no execution
 * needed", and cancelled Review and Ella's original item as duplicates. The
 * reconciler then saw `{verified:2, cancelled:2}` and closed the Request while
 * the only real work (806dc528) was still running.
 *
 * The rules here:
 *   1. Cancelled items never count as delivered work.
 *   2. A cancelled item that names its replacement (explicitly via
 *      `metadata.supersededBy` / a `succeeded_by` disposition, or in its
 *      cancel reason, e.g. "re-routed … as WI 806dc528") pulls that
 *      replacement into the Request's set — its status now decides.
 *   3. Items that were split off the Request without the link (no
 *      `requestId`, but the full request id in their title/brief — the shape
 *      `delegate-task` produces when the orc pastes "[Request <id> | …]")
 *      belong to the Request too.
 *   4. Plan/Review bookkeeping from auto-decomposition is not a deliverable.
 *      A Request whose only finished items are bookkeeping is not done.
 *
 * Pure functions only — callers pass in the pool snapshot.
 *
 * @module services/v3/request-completion
 */

import type { WorkItem } from '../../types/v2/work-item.types.js';
import { getWorkItemDisposition } from '../../types/v2/work-item.types.js';

/**
 * Phases a planner can stamp on an auto-decomposed WorkItem
 * (`metadata.decompositionPhase`). `plan` and `review` are bookkeeping around
 * the work; `execute` is the work.
 */
export type DecompositionPhase = 'plan' | 'execute' | 'review';

/** Metadata key for {@link DecompositionPhase}. */
export const DECOMPOSITION_PHASE_METADATA_KEY = 'decompositionPhase';

/** Metadata key a canceller sets to name the item(s) that replace this one. */
export const SUPERSEDED_BY_METADATA_KEY = 'supersededBy';

/** Phases that do not, on their own, deliver anything to the owner. */
const BOOKKEEPING_PHASES: ReadonlySet<DecompositionPhase> = new Set(['plan', 'review']);

/**
 * Title prefixes the generic planner (`V3DataService.generateTasks`) gives its
 * bookkeeping items. Only consulted for auto-decomposed items that predate the
 * explicit `decompositionPhase` stamp.
 */
const LEGACY_BOOKKEEPING_TITLE = /^(Plan|Review|Investigate|Verify fix):\s/;

/**
 * SLA "reply to the user" trackers. Housekeeping when the Request has other
 * work; the whole deliverable when it does not (a question answered in chat).
 */
const SLA_TRACKER_ID = /^request:.+:respond_to_user$/;

/**
 * `slaResolvedReason` values meaning the orchestrator really replied. Kept in
 * sync with `request-sla.subscriber.ts:VERIFIED_REPLY_REASONS`, minus
 * `workitem_decompose` (the tracker was retired because the Request was split
 * into other WorkItems — that is not a reply).
 */
const SLA_REPLIED_REASONS: ReadonlySet<string> = new Set(['orc_reply', 'orc_reply_recheck', 'chatv2_reply']);

/**
 * Cancel reasons that mean "this work continues elsewhere". Used only to
 * decide whether ids mentioned in the reason are worth following; a cancelled
 * item never counts as delivered either way.
 */
const SUPERSEDED_REASON =
  /\b(duplicate|dup|superseded|replaced|redundant|stale|re-?routed|re-?assigned|moved to|handed (?:off|over)|delegated to|instead)\b/i;

/**
 * A WorkItem id, full or abbreviated. Agents routinely quote the first 8 hex
 * characters ("WI 806dc528"), so short ids are resolved by unique prefix.
 */
const WORK_ITEM_ID_TOKEN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;

/** Upper bound on successor hops, so a cancel-reason cycle cannot loop. */
const MAX_SUCCESSOR_DEPTH = 5;

/** Statuses that mean the work was accepted. `done_by_worker` is not one. */
const DELIVERED_STATUSES: ReadonlySet<WorkItem['status']> = new Set(['done', 'verified']);

/**
 * Whether a WorkItem is Plan/Review-style bookkeeping rather than a
 * deliverable.
 *
 * @param wi - WorkItem to classify
 * @returns True for SLA trackers and for auto-decomposed plan/review phases
 *
 * @example
 * ```typescript
 * isBookkeepingWorkItem({ ...wi, metadata: { decompositionPhase: 'plan' } }); // true
 * ```
 */
export function isBookkeepingWorkItem(wi: Pick<WorkItem, 'id' | 'title' | 'metadata'>): boolean {
  if (SLA_TRACKER_ID.test(wi.id)) return true;
  const phase = wi.metadata?.[DECOMPOSITION_PHASE_METADATA_KEY];
  if (typeof phase === 'string') {
    return BOOKKEEPING_PHASES.has(phase as DecompositionPhase);
  }
  return wi.metadata?.autoDecomposed === true && LEGACY_BOOKKEEPING_TITLE.test(wi.title);
}

/**
 * Whether a cancelled WorkItem was cancelled because its work moved to another
 * item (duplicate / superseded / re-routed).
 *
 * @param wi - WorkItem to test
 * @returns True only for `cancelled` items with an explicit successor or a
 *   superseding cancel reason
 */
export function isSupersededCancellation(
  wi: Pick<WorkItem, 'status' | 'cancelReason' | 'metadata'>,
): boolean {
  if (wi.status !== 'cancelled') return false;
  if (readExplicitSuccessorIds(wi).length > 0) return true;
  return typeof wi.cancelReason === 'string' && SUPERSEDED_REASON.test(wi.cancelReason);
}

/**
 * Reads the explicitly recorded successor ids of a WorkItem.
 *
 * @param wi - WorkItem to read
 * @returns Ids from `metadata.supersededBy` (string or string[]) and from a
 *   `succeeded_by` disposition
 */
function readExplicitSuccessorIds(wi: Pick<WorkItem, 'metadata'>): string[] {
  const ids: string[] = [];
  const raw = wi.metadata?.[SUPERSEDED_BY_METADATA_KEY];
  if (typeof raw === 'string' && raw.trim()) ids.push(raw.trim());
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string' && v.trim()) ids.push(v.trim());
  }
  const disposition = getWorkItemDisposition(wi);
  if (disposition?.kind === 'succeeded_by' && disposition.successorWorkItemId) {
    ids.push(disposition.successorWorkItemId);
  }
  return ids;
}

/**
 * Resolves an id or unique id prefix against the pool.
 *
 * @param token - Full id or an abbreviated (>= 8 char) prefix
 * @param allItems - Pool snapshot
 * @returns The single matching WorkItem, or null when absent or ambiguous
 */
function resolveIdToken(token: string, allItems: readonly WorkItem[]): WorkItem | null {
  const needle = token.toLowerCase();
  const exact = allItems.find((wi) => wi.id.toLowerCase() === needle);
  if (exact) return exact;
  const matches = allItems.filter((wi) => wi.id.toLowerCase().startsWith(needle));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Finds the WorkItems that carry on the work of a cancelled item.
 *
 * @param wi - The cancelled WorkItem
 * @param allItems - Pool snapshot
 * @returns Successor WorkItems (never `wi` itself)
 */
export function findSuccessorWorkItems(wi: WorkItem, allItems: readonly WorkItem[]): WorkItem[] {
  if (wi.status !== 'cancelled') return [];
  const tokens = new Set<string>(readExplicitSuccessorIds(wi));
  if (isSupersededCancellation(wi) && typeof wi.cancelReason === 'string') {
    for (const m of wi.cancelReason.match(WORK_ITEM_ID_TOKEN) ?? []) tokens.add(m);
  }
  const found = new Map<string, WorkItem>();
  for (const token of tokens) {
    const hit = resolveIdToken(token, allItems);
    if (hit && hit.id !== wi.id) found.set(hit.id, hit);
  }
  return [...found.values()];
}

/**
 * Whether an unlinked WorkItem names the Request in its own text.
 *
 * @param wi - Candidate WorkItem (must have no `requestId`)
 * @param requestId - Full Request id
 * @returns True when the title, description or brief contains the full id
 */
function mentionsRequest(wi: WorkItem, requestId: string): boolean {
  if (wi.requestId) return false;
  return [wi.title, wi.description, wi.briefMarkdown].some(
    (text) => typeof text === 'string' && text.includes(requestId),
  );
}

/**
 * Collects every WorkItem whose status bears on a Request's completion: its
 * own items, unlinked items that name it, and — transitively — the
 * replacements of any superseded cancellations among them.
 *
 * @param requestId - Request id
 * @param allItems - Pool snapshot (all statuses)
 * @returns The Request's effective WorkItem set, own items first
 *
 * @example
 * ```typescript
 * const items = collectRequestWorkItems(request.id, await pool.getAllItems());
 * ```
 */
export function collectRequestWorkItems(requestId: string, allItems: readonly WorkItem[]): WorkItem[] {
  const collected = new Map<string, WorkItem>();
  for (const wi of allItems) {
    if (wi.requestId === requestId) collected.set(wi.id, wi);
  }
  for (const wi of allItems) {
    if (!collected.has(wi.id) && mentionsRequest(wi, requestId)) collected.set(wi.id, wi);
  }

  let frontier = [...collected.values()];
  for (let depth = 0; depth < MAX_SUCCESSOR_DEPTH && frontier.length > 0; depth++) {
    const next: WorkItem[] = [];
    for (const wi of frontier) {
      for (const successor of findSuccessorWorkItems(wi, allItems)) {
        if (collected.has(successor.id)) continue;
        collected.set(successor.id, successor);
        next.push(successor);
      }
    }
    frontier = next;
  }
  return [...collected.values()];
}

/**
 * Outcome of {@link evaluateRequestCompletion}.
 *
 * - `complete`: every live item is done/verified and at least one of them is
 *   a real deliverable.
 * - `in_progress`: some live item is not finished yet.
 * - `bookkeeping_only`: every live item is finished, but none of them is a
 *   deliverable — nothing was actually produced.
 * - `nothing_live`: every item was cancelled; nothing is left to deliver.
 */
export type RequestCompletionOutcome = 'complete' | 'in_progress' | 'bookkeeping_only' | 'nothing_live';

/** Result of {@link evaluateRequestCompletion}. */
export interface RequestCompletionEvaluation {
  outcome: RequestCompletionOutcome;
  /** Items that still count (not cancelled). */
  liveItems: WorkItem[];
  /** Live, finished, non-bookkeeping items. */
  deliveredItems: WorkItem[];
  /** One-line explanation for logs and correction reasons. */
  reason: string;
}

/**
 * Decides whether a Request's work was actually delivered.
 *
 * @param items - The Request's effective WorkItems (see
 *   {@link collectRequestWorkItems})
 * @returns The outcome plus the items that justify it
 *
 * @example
 * ```typescript
 * const { outcome } = evaluateRequestCompletion(collectRequestWorkItems(id, all));
 * if (outcome === 'complete') markDone();
 * ```
 */
export function evaluateRequestCompletion(items: readonly WorkItem[]): RequestCompletionEvaluation {
  const trackers = items.filter((wi) => SLA_TRACKER_ID.test(wi.id));
  if (trackers.length > 0 && trackers.length === items.length) {
    return evaluateReplyOnlyRequest(trackers);
  }
  const liveItems = items.filter((wi) => wi.status !== 'cancelled');
  const deliveredItems = liveItems.filter(
    (wi) => DELIVERED_STATUSES.has(wi.status) && !isBookkeepingWorkItem(wi),
  );

  if (liveItems.length === 0) {
    return {
      outcome: 'nothing_live',
      liveItems,
      deliveredItems,
      reason: `all ${items.length} WorkItem(s) cancelled — nothing was delivered`,
    };
  }
  const unfinished = liveItems.filter((wi) => !DELIVERED_STATUSES.has(wi.status));
  if (unfinished.length > 0) {
    return {
      outcome: 'in_progress',
      liveItems,
      deliveredItems,
      reason: `${unfinished.length} WorkItem(s) not finished: ${unfinished
        .map((wi) => `${wi.id.slice(0, 8)}=${wi.status}`)
        .join(', ')}`,
    };
  }
  if (deliveredItems.length === 0) {
    return {
      outcome: 'bookkeeping_only',
      liveItems,
      deliveredItems,
      reason: `only plan/review bookkeeping finished (${liveItems
        .map((wi) => wi.id.slice(0, 8))
        .join(', ')}) — no deliverable WorkItem was completed`,
    };
  }
  return {
    outcome: 'complete',
    liveItems,
    deliveredItems,
    reason: `${deliveredItems.length} deliverable WorkItem(s) done/verified`,
  };
}

/**
 * Completion for a Request whose only WorkItems are SLA reply trackers: the
 * reply is the deliverable. A tracker the SLA subscriber closed because the
 * orchestrator answered counts as delivered even though it lands `cancelled`.
 *
 * @param trackers - The Request's SLA tracker WorkItems (non-empty)
 * @returns The completion evaluation
 */
function evaluateReplyOnlyRequest(trackers: readonly WorkItem[]): RequestCompletionEvaluation {
  const replied = trackers.filter((wi) => {
    if (DELIVERED_STATUSES.has(wi.status)) return true;
    const reason = wi.metadata?.slaResolvedReason;
    return wi.status === 'cancelled' && typeof reason === 'string' && SLA_REPLIED_REASONS.has(reason);
  });
  const liveItems = trackers.filter((wi) => wi.status !== 'cancelled');
  const pending = liveItems.filter((wi) => !DELIVERED_STATUSES.has(wi.status));
  if (pending.length > 0) {
    return { outcome: 'in_progress', liveItems, deliveredItems: replied, reason: 'reply to the user still pending' };
  }
  if (replied.length > 0) {
    return { outcome: 'complete', liveItems, deliveredItems: replied, reason: 'the user was answered' };
  }
  return {
    outcome: 'nothing_live',
    liveItems,
    deliveredItems: replied,
    reason: 'reply tracker cancelled without a reply',
  };
}
