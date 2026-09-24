/**
 * Tests for the ticket claim policy (specs/ticket-loop.md, Phase 3).
 */

import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import {
  CLAIM_TIER,
  claimTier,
  isReworkItem,
  openTicketsOf,
  orderForAgent,
  ticketLockReason,
  type ClaimTicketLookup,
  type ClaimTicketView,
} from './ticket-claim-policy.js';

/**
 * WorkItem with a fixed age.
 *
 * @param overrides - Fields
 * @param ageMin - Minutes old
 * @returns WorkItem
 */
function wi(overrides: Partial<WorkItem> & { title: string }, ageMin = 10): WorkItem {
  const item = createWorkItem({ type: 'delegate', owner: 'agent', title: overrides.title });
  return { ...item, ...overrides, createdAt: new Date(Date.now() - ageMin * 60_000).toISOString() };
}

/**
 * Ticket snapshot.
 *
 * @param list - Tickets
 * @returns Lookup
 */
function tickets(...list: ClaimTicketView[]): ClaimTicketLookup {
  return new Map(list.map((t) => [t.id, t]));
}

describe('isReworkItem', () => {
  it('recognises board rework and reviewer retries', () => {
    expect(isReworkItem(wi({ title: 'x', metadata: { ticketRework: true } }))).toBe(true);
    expect(isReworkItem(wi({ title: 'x', id: 'a:retry:1' }))).toBe(true);
    expect(isReworkItem(wi({ title: 'x', metadata: { retryAttempt: 2 } }))).toBe(true);
    expect(isReworkItem(wi({ title: 'x' }))).toBe(false);
  });
});

describe('claimTier', () => {
  const T = tickets({ id: 'r0', priority: 'urgent' }, { id: 'r3', priority: 'low' });

  it('own rejected < own unblocked < queue rejected < P0..P3', () => {
    expect(claimTier(wi({ title: 'x', target: 'ann', metadata: { ticketRework: true } }), 'ann', T)).toBe(CLAIM_TIER.OWN_REJECTED);
    expect(claimTier(wi({ title: 'x', target: 'ann', metadata: { unblockedAt: 'now' } }), 'ann', T)).toBe(CLAIM_TIER.OWN_UNBLOCKED);
    expect(claimTier(wi({ title: 'x', id: 'q:retry:1' }), 'ann', T)).toBe(CLAIM_TIER.QUEUE_REJECTED);
    expect(claimTier(wi({ title: 'x', requestId: 'r0' }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE);
    expect(claimTier(wi({ title: 'x', requestId: 'r3' }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE + 3);
  });

  it('non-ticket items use metadata.priority (unknown = P2)', () => {
    expect(claimTier(wi({ title: 'x', metadata: { priority: 'critical' } }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE);
    expect(claimTier(wi({ title: 'x', metadata: { priority: 'high' } }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE + 1);
    expect(claimTier(wi({ title: 'x' }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE + 2);
  });

  it('someone else’s rework is plain priority work for me', () => {
    expect(claimTier(wi({ title: 'x', target: 'bob', metadata: { ticketRework: true } }), 'ann', T)).toBe(CLAIM_TIER.PRIORITY_BASE + 2);
  });
});

describe('lock — one ticket per agent', () => {
  const T = tickets({ id: 'rA', priority: 'normal' }, { id: 'rB', priority: 'urgent' }, { id: 'rC', priority: 'normal', assignee: 'bob' });

  it('openTicketsOf counts only open items targeted at the agent', () => {
    const pool = [
      wi({ title: 'a', requestId: 'rA', target: 'ann', status: 'running' }),
      wi({ title: 'b', requestId: 'rB', target: 'ann', status: 'done_by_worker' }),
      wi({ title: 'c', requestId: 'rB', target: 'bob', status: 'running' }),
      wi({ title: 'd', requestId: 'not-a-ticket', target: 'ann', status: 'running' }),
    ];
    expect([...openTicketsOf(pool, 'ann', T)]).toEqual(['rA']);
  });

  it('an assignee owns the untargeted items of its ticket', () => {
    expect(ticketLockReason(wi({ title: 'x', requestId: 'rC' }), 'ann', T, new Set())).toBe('ticket_owned_by_other');
    expect(ticketLockReason(wi({ title: 'x', requestId: 'rC' }), 'bob', T, new Set())).toBeNull();
  });

  it('an agent busy on one ticket does not self-claim another; targeted work is never held back', () => {
    const busy = new Set(['rA']);
    expect(ticketLockReason(wi({ title: 'x', requestId: 'rB' }), 'ann', T, busy)).toBe('agent_on_other_ticket');
    expect(ticketLockReason(wi({ title: 'x', requestId: 'rA' }), 'ann', T, busy)).toBeNull();
    expect(ticketLockReason(wi({ title: 'x', requestId: 'rB', target: 'ann' }), 'ann', T, busy)).toBeNull();
    expect(ticketLockReason(wi({ title: 'x' }), 'ann', T, busy)).toBeNull();
  });
});

describe('orderForAgent', () => {
  it('orders by tier then age and drops locked items', () => {
    const T = tickets({ id: 'p0', priority: 'urgent' }, { id: 'p3', priority: 'low' }, { id: 'mine', priority: 'normal', assignee: 'bob' });
    const oldP3 = wi({ title: 'old P3', requestId: 'p3' }, 60);
    const newP0 = wi({ title: 'new P0', requestId: 'p0' }, 1);
    const rework = wi({ title: 'my rework', target: 'ann', metadata: { ticketRework: true } }, 1);
    const locked = wi({ title: 'bob’s', requestId: 'mine' }, 90);
    const plain = wi({ title: 'plain', metadata: { priority: 'medium' } }, 30);
    const order = orderForAgent([oldP3, newP0, rework, locked, plain], 'ann', [], T).map((w) => w.title);
    expect(order).toEqual(['my rework', 'new P0', 'plain', 'old P3']);
  });
});
