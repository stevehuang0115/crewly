/**
 * The gate of a conditional promise (a commitment waiting on the owner): the
 * question from the same message ("你看这样写行吗？你点头后我就…") whose card
 * answer opens or drops it (CREW-440). Pure helpers, no I/O.
 *
 * @module services/open-items/open-item-gate
 */

import { OPEN_ITEMS_CONSTANTS } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { RequestOpenItem } from '../../types/v2/open-item.types.js';

/** What a settled (or pending) gate decision means for the promise. */
export type GateVerdict = 'wait' | 'open' | 'skipped' | 'declined';

/**
 * The question item a conditional promise waits behind: `gateItemId`, else
 * (promises stored before CREW-440) the question of the same source message.
 *
 * @param item - The waiting commitment
 * @param items - All items of the request
 * @returns The question item, or null
 */
export function siblingQuestion(item: RequestOpenItem, items: readonly RequestOpenItem[]): RequestOpenItem | null {
  if (item.gateItemId) return items.find((i) => i.id === item.gateItemId) ?? null;
  return items.find((i) => i.type === 'question' && i.sourceMessageId === item.sourceMessageId) ?? null;
}

/**
 * What an owner's answer on the gate card means for the promise.
 *
 * @param d - The gate decision
 * @returns `open` (yes), `skipped` (drop it, tell the agent), `declined` (no / withdrawn), `wait` (still pending, or "reply in words")
 */
export function gateVerdict(d: Pick<OwnerDecision, 'status' | 'chosenKey' | 'yesKey' | 'options'>): GateVerdict {
  if (d.status === 'open' || d.status === 'parked') return 'wait';
  if (d.status === 'skipped') return 'skipped';
  if (d.status === 'cancelled' || d.status === 'expired') return 'declined';
  const chosen = d.chosenKey ? d.options?.find((o) => o.key === d.chosenKey) : undefined;
  if (chosen?.label === OPEN_ITEMS_CONSTANTS.REPLY_LABEL) return 'wait';
  if (d.chosenKey && d.yesKey && d.chosenKey !== d.yesKey) return 'declined';
  return 'open';
}

/**
 * A waiting promise nobody can open: its sibling question was dropped (skipped,
 * withdrawn, expired), or it has neither a sibling nor a gate card. A sibling
 * that was ANSWERED is not dead: the sweep opens or drops the promise by that
 * answer. (Auto-accept by silence closes dead ones instead of parking the
 * ticket in `awaiting_followup`.)
 *
 * @param item - Item
 * @param items - All items of the request
 * @returns True when no answer can ever reach it
 */
export function isDeadGate(item: RequestOpenItem, items: readonly RequestOpenItem[]): boolean {
  if (item.type !== 'commitment' || item.status !== 'waiting_owner') return false;
  const sib = siblingQuestion(item, items);
  if (!sib) return !item.gateDecisionId;
  return sib.status === 'skipped' || sib.status === 'superseded' || sib.status === 'expired' || sib.status === 'cancelled';
}
