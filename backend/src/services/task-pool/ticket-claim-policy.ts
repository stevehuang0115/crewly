/**
 * Ticket claim policy — which queued WorkItem an agent takes next
 * (specs/ticket-loop.md, Phase 3).
 *
 * Pure functions over the pool and a snapshot of tickets, used by every
 * claim path (`claimFromPool`, `claimSpecificItem`, AutoClaim) so the order
 * and the lock are the same everywhere.
 *
 * **Order** (first tier wins, then oldest first):
 * 1. own rejected — rework / retry of this agent's work that was sent back
 * 2. own unblocked — this agent's work that was blocked and is free again
 * 3. queue rejected — rework / retry nobody owns yet
 * 4. everything else by priority: P0, P1, P2, P3 (ticket priority when the
 *    item belongs to a ticket, else the item's own `metadata.priority`)
 *
 * **Lock — one ticket per agent.**
 * - An untargeted item of a ticket that already has an assignee is only for
 *   that assignee (an explicit `target` still wins: a lead may hand one piece
 *   of a ticket to someone else).
 * - An agent that still has open work on one ticket does not self-claim an
 *   untargeted item of another ticket. Items targeted at it are never held
 *   back — someone deliberately gave it that work.
 *
 * @module services/task-pool/ticket-claim-policy
 */

import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { RequestPriority } from '../../types/v2/request.types.js';

/** What the policy needs to know about a ticket. */
export interface ClaimTicketView {
  id: string;
  priority: RequestPriority;
  /** Agent that owns the ticket, when any */
  assignee?: string;
}

/** Tickets by Request id (non-ticket Requests are simply absent). */
export type ClaimTicketLookup = ReadonlyMap<string, ClaimTicketView>;

/** Claim tiers, lowest first. */
export const CLAIM_TIER = {
  OWN_REJECTED: 0,
  OWN_UNBLOCKED: 1,
  QUEUE_REJECTED: 2,
  /** P0 … P3 follow: PRIORITY_BASE + 0..3 */
  PRIORITY_BASE: 3,
} as const;

/** WorkItem statuses that still hold an agent to a ticket. */
const OPEN_FOR_LOCK = new Set(['queued', 'running', 'blocked', 'rejected']);

/**
 * P-rank (0 = P0) of a ticket priority.
 *
 * @param p - Ticket priority
 * @returns 0..3
 */
function ticketRank(p: RequestPriority): number {
  switch (p) {
    case 'urgent':
      return 0;
    case 'high':
      return 1;
    case 'low':
      return 3;
    default:
      return 2;
  }
}

/**
 * P-rank of a WorkItem's own `metadata.priority` (delegate-task writes
 * critical / high / medium / low; decomposition writes the plan's value).
 *
 * @param value - Raw metadata value
 * @returns 0..3 (unknown → 2)
 */
function metadataRank(value: unknown): number {
  switch (typeof value === 'string' ? value.toLowerCase() : '') {
    case 'critical':
    case 'urgent':
    case 'p0':
      return 0;
    case 'high':
    case 'p1':
      return 1;
    case 'low':
    case 'p3':
      return 3;
    default:
      return 2;
  }
}

/**
 * Whether an item is a do-over of work that was sent back: a ticket rework
 * (打回 from the board) or a reviewer's retry.
 *
 * @param wi - WorkItem
 * @returns True for rework / retry items
 */
export function isReworkItem(wi: Pick<WorkItem, 'id' | 'metadata'>): boolean {
  return wi.metadata?.ticketRework === true || typeof wi.metadata?.retryAttempt === 'number' || wi.id.includes(':retry:');
}

/**
 * The tier of an item for one agent (see module docs).
 *
 * @param wi - Candidate WorkItem
 * @param agentId - The claiming agent
 * @param tickets - Ticket snapshot
 * @returns Tier number (lower is taken first)
 */
export function claimTier(wi: WorkItem, agentId: string, tickets: ClaimTicketLookup): number {
  const mine = wi.target === agentId;
  const rework = isReworkItem(wi);
  if (rework && mine) return CLAIM_TIER.OWN_REJECTED;
  if (mine && typeof wi.metadata?.unblockedAt === 'string') return CLAIM_TIER.OWN_UNBLOCKED;
  if (rework && !wi.target) return CLAIM_TIER.QUEUE_REJECTED;
  const ticket = wi.requestId ? tickets.get(wi.requestId) : undefined;
  const rank = ticket ? ticketRank(ticket.priority) : metadataRank(wi.metadata?.priority);
  return CLAIM_TIER.PRIORITY_BASE + rank;
}

/**
 * Tickets an agent is still working on: any ticket with an open (queued,
 * running, blocked, rejected) item targeted at the agent.
 *
 * @param pool - Every WorkItem
 * @param agentId - The agent
 * @param tickets - Ticket snapshot
 * @returns Ticket ids
 */
export function openTicketsOf(pool: readonly WorkItem[], agentId: string, tickets: ClaimTicketLookup): Set<string> {
  const out = new Set<string>();
  for (const wi of pool) {
    if (wi.target !== agentId || !wi.requestId || !tickets.has(wi.requestId)) continue;
    if (OPEN_FOR_LOCK.has(wi.status)) out.add(wi.requestId);
  }
  return out;
}

/**
 * Why an agent may not self-claim an item, or null when it may.
 *
 * @param wi - Candidate WorkItem
 * @param agentId - The claiming agent
 * @param tickets - Ticket snapshot
 * @param agentOpenTickets - {@link openTicketsOf} for this agent
 * @returns `'ticket_owned_by_other'`, `'agent_on_other_ticket'`, or null
 */
export function ticketLockReason(
  wi: WorkItem,
  agentId: string,
  tickets: ClaimTicketLookup,
  agentOpenTickets: ReadonlySet<string>,
): 'ticket_owned_by_other' | 'agent_on_other_ticket' | null {
  // Deliberately assigned work is never held back.
  if (wi.target) return null;
  const ticket = wi.requestId ? tickets.get(wi.requestId) : undefined;
  if (!ticket) return null;
  if (ticket.assignee && ticket.assignee !== agentId) return 'ticket_owned_by_other';
  for (const other of agentOpenTickets) {
    if (other !== ticket.id) return 'agent_on_other_ticket';
  }
  return null;
}

/**
 * Candidates in the order an agent should take them, lock applied.
 *
 * @param candidates - Queued, unclaimed items the agent may take (target already respected)
 * @param agentId - The claiming agent
 * @param pool - Every WorkItem (for the lock)
 * @param tickets - Ticket snapshot
 * @returns Ordered, lock-filtered candidates
 */
export function orderForAgent(
  candidates: readonly WorkItem[],
  agentId: string,
  pool: readonly WorkItem[],
  tickets: ClaimTicketLookup,
): WorkItem[] {
  const open = openTicketsOf(pool, agentId, tickets);
  return candidates
    .filter((wi) => ticketLockReason(wi, agentId, tickets, open) === null)
    .map((wi) => ({ wi, tier: claimTier(wi, agentId, tickets), at: Date.parse(wi.createdAt) || 0 }))
    .sort((a, b) => a.tier - b.tier || a.at - b.at)
    .map((x) => x.wi);
}
