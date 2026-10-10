/**
 * Open items: commitments and questions an agent put in its reply to the
 * owner (specs/2026-10-01-reply-open-items.md).
 *
 * A Request is not `done` while one of these is open: the agent promised the
 * owner something ("明天中午给你", "I'll send it tonight") or asked the owner
 * to decide ("你同意吗？"), and Crewly tracks it until it is delivered or
 * answered.
 *
 * @module types/v2/open-item.types
 */

/** What the agent left open. */
export type OpenItemType = 'commitment' | 'question';

/**
 * Lifecycle of an open item.
 *
 * - `open`      — waiting (commitment not delivered / question not answered)
 * - `ready`     — commitment: the delegated work it waits on is finished; the
 *                 agent was woken to deliver it
 * - `waiting_owner` — commitment: conditional on the owner ("你点头后…"); no due time, no
 *                 follow-up, no nudges until the owner says yes in the thread or answers the card
 * - `overdue`   — commitment: the due time passed undelivered (the agent was
 *                 nudged; later the owner was told)
 * - `delivered` — commitment: the agent posted in the thread after the work
 *                 was ready
 * - `resolved`  — question: the owner answered (card, reaction, reply) or the
 *                 card's default was applied
 * - `superseded`— replaced (a newer promise in the thread, or the agent asked
 *                 the same question through ask-owner)
 * - `expired`   — nothing happened for {@link OPEN_ITEMS_CONSTANTS.EXPIRE_AFTER_MS}
 * - `cancelled` — the Request was cancelled
 * - `skipped`   — the owner skipped it ("I don't care about this anymore");
 *                 a promise's follow-up is cancelled, a question's card is
 *                 settled as skipped
 */
export type OpenItemStatus =
  | 'open'
  | 'waiting_owner'
  | 'ready'
  | 'overdue'
  | 'delivered'
  | 'resolved'
  | 'superseded'
  | 'expired'
  | 'cancelled'
  | 'skipped';

/** Statuses in which an item still holds its Request open. */
export const ACTIVE_OPEN_ITEM_STATUSES: ReadonlySet<OpenItemStatus> = new Set<OpenItemStatus>(['open', 'waiting_owner', 'ready', 'overdue']);

/** One open item on a Request. */
export interface RequestOpenItem {
  /** Stable id (`<type-initial>-<message id prefix>-<n>`) */
  id: string;
  type: OpenItemType;
  /** The agent's own words (one sentence or line, clipped) */
  text: string;
  /** Agent session that made the promise / asked */
  agent: string;
  /** chat-v2 message the item was found in */
  sourceMessageId: string;
  /** ISO — when the agent said it */
  createdAt: string;
  status: OpenItemStatus;
  /** Commitment: when it is due (ISO, local time resolved at extraction) */
  due?: string;
  /** Commitment: whether `due` came from the text or is the default */
  dueSource?: 'text' | 'default';
  /** Commitment: the follow-up WorkItem queued for the agent */
  workItemId?: string;
  /** Commitment: delegated child WorkItems it waits on */
  childWorkItemIds?: string[];
  /** Commitment: when every child was finished (ISO) */
  readyAt?: string;
  /** Commitment: when the agent was woken because the work was ready (ISO) */
  wokeAt?: string;
  /** Commitment: when the agent was nudged after the due time (ISO) */
  nudgedAt?: string;
  /** Commitment: made in an interim note; the agent's next substantive reply in the thread delivers it */
  fromInterim?: boolean;
  /** Commitment: when a restart reminder was sent for it (ISO); sent at most once, and it counts as the nudge */
  restartRemindedAt?: string;
  /** Commitment: when the owner was told it is late (ISO) */
  ownerNotifiedAt?: string;
  /** Commitment waiting on the owner: the ask-owner decision whose answer opens it, if any */
  gateDecisionId?: string;
  /** Commitment waiting on the owner: the question item from the same message whose answer opens it (CREW-440) */
  gateItemId?: string;
  /** Question: the decision card it became (`D-<n>`) */
  decisionId?: string;
  /** Question: the owner's answer (option label or words) */
  answer?: string;
  /** ISO — when it stopped being active */
  closedAt?: string;
  /** Why it was closed (delivered by message X, answered D-7, …) */
  closedReason?: string;
}
