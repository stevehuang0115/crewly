// Updated: 2026-04-13T15:54:17Z - request title summarization + dangling fix
/**
 * Tests for Reconcile Rules
 *
 * @module services/reconciler/reconcile-rules.test
 */

import {
  detectStuckWorkItems,
  detectExpiredClaims,
  reconcileRequestStatus,
  detectOrphanWorkItems,
  detectTTLExpiredWorkItems,
  detectUnverifiedWorkItems,
  DEFAULT_VERIFY_ESCALATE_MS,
  VERIFY_ESCALATED_AT_KEY,
  detectRecoverableWorkItems,
  cascadeCancelChildren,
  detectStaleQueuedWorkItems,
  detectUnclaimedTasks,
  selectBestAgent,
  computeAgentScore,
  runPruningPass,
  UNCLAIMED_THRESHOLD_MS,
  MAX_WAKE_ACTIONS_PER_PASS,
} from './reconcile-rules.js';
import type { AgentHealth } from './reconcile-rules.js';
import { createWorkItem, createRequest, createTaskClaim } from '../../types/v2/index.js';
import type { WorkItem, WorkItemStatus, Request, TaskClaim } from '../../types/v2/index.js';
import { WORK_ITEM_TRANSITIONS } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a WorkItem with overrides. */
function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'agent', title: 'Test', target: 'agent-1' }),
    ...overrides,
  };
}

/** Creates a Request with overrides. */
function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    ...createRequest({ sourceConversationItemId: 'conv-1', title: 'Test', description: 'Test desc' }),
    ...overrides,
  };
}

/** Creates a healthy agent map. */
function makeAgentMap(entries: Array<[string, Partial<AgentHealth>]>): Map<string, AgentHealth> {
  return new Map(entries.map(([name, overrides]) => [name, {
    sessionName: name,
    status: 'active',
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  }]));
}

// ---------------------------------------------------------------------------
// detectStuckWorkItems
// ---------------------------------------------------------------------------
describe('detectStuckWorkItems', () => {
  it('should detect WorkItems with dead agents', () => {
    const wi = makeWorkItem({ status: 'running', target: 'agent-dead', startedAt: new Date().toISOString() });
    const agentMap = makeAgentMap([['agent-dead', { status: 'inactive' }]]);

    const { corrections, stuckIds } = detectStuckWorkItems([wi], agentMap);
    expect(stuckIds).toContain(wi.id);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].newState).toBe('blocked'); // retryCount < maxRetries
  });

  it('should mark as failed when retries exhausted', () => {
    const wi = makeWorkItem({
      status: 'running',
      target: 'agent-dead',
      startedAt: new Date().toISOString(),
      retryCount: 3,
      maxRetries: 3,
    });
    const agentMap = makeAgentMap([['agent-dead', { status: 'inactive' }]]);

    const { corrections } = detectStuckWorkItems([wi], agentMap);
    expect(corrections[0].newState).toBe('failed');
  });

  it('should detect WorkItems with unknown agents', () => {
    const wi = makeWorkItem({ status: 'running', target: 'agent-missing', startedAt: new Date().toISOString() });
    const agentMap = new Map<string, AgentHealth>();

    const { stuckIds } = detectStuckWorkItems([wi], agentMap);
    expect(stuckIds).toContain(wi.id);
  });

  it('should detect timed-out WorkItems even with active agents', () => {
    const oldStart = new Date(Date.now() - 700_000).toISOString(); // 11+ min ago
    // type='project_task' falls back to the default 600_000ms timeout;
    // 'delegate' / 'review' / 'confirm' have per-type overrides that would
    // skip this case (see DEFAULT_PER_TYPE_TIMEOUT_MS).
    const wi = makeWorkItem({
      type: 'project_task',
      status: 'running',
      target: 'agent-1',
      startedAt: oldStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toContain(wi.id);
  });

  it('SW-1: mark as failed immediately when maxRetries is 0', () => {
    const wi = makeWorkItem({
      status: 'running',
      target: 'agent-dead',
      startedAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 0,
    });
    const agentMap = makeAgentMap([['agent-dead', { status: 'inactive' }]]);

    const { corrections } = detectStuckWorkItems([wi], agentMap);
    expect(corrections[0].newState).toBe('failed');
    expect(corrections[0].reason).toContain('inactive');
  });

  it('should skip non-running WorkItems', () => {
    const wi = makeWorkItem({ status: 'queued', target: 'agent-1' });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap);
    expect(stuckIds).toHaveLength(0);
  });

  it('should skip WorkItems without target', () => {
    const wi = makeWorkItem({ status: 'running', target: undefined });
    const agentMap = new Map<string, AgentHealth>();

    const { stuckIds } = detectStuckWorkItems([wi], agentMap);
    expect(stuckIds).toHaveLength(0);
  });

  it('should not flag healthy running WorkItems', () => {
    const wi = makeWorkItem({ status: 'running', target: 'agent-1', startedAt: new Date().toISOString() });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap);
    expect(stuckIds).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Per-type timeout (2026-05-06 dogfood regression — see DEFAULT_PER_TYPE_TIMEOUT_MS)
  // -------------------------------------------------------------------------
  it('should NOT timeout delegate-type WIs at the default 10min threshold', () => {
    // 11 minutes of running — past the legacy 10min default but well within
    // the 4h delegate-type override. A TL umbrella WI must not flip to failed
    // here, otherwise the cascade-cancel rules will wipe its children.
    const oldStart = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const wi = makeWorkItem({
      type: 'delegate',
      status: 'running',
      target: 'agent-1',
      startedAt: oldStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toHaveLength(0);
  });

  it('should NOT timeout review-type WIs at the default 10min threshold', () => {
    const oldStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const wi = makeWorkItem({
      type: 'review',
      status: 'running',
      target: 'agent-1',
      startedAt: oldStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toHaveLength(0);
  });

  it('should still timeout delegate WIs once the 4h ceiling is exceeded', () => {
    const oldStart = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h
    const wi = makeWorkItem({
      type: 'delegate',
      status: 'running',
      target: 'agent-1',
      startedAt: oldStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toContain(wi.id);
  });

  it('should NEVER timeout confirm-type WIs (waiting on user)', () => {
    const ancientStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h
    const wi = makeWorkItem({
      type: 'confirm',
      status: 'running',
      target: 'agent-1',
      startedAt: ancientStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toHaveLength(0);
  });

  it('should honor caller-provided per-type timeout overrides', () => {
    const oldStart = new Date(Date.now() - 30_000).toISOString(); // 30s
    const wi = makeWorkItem({
      type: 'project_task',
      status: 'running',
      target: 'agent-1',
      startedAt: oldStart,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    // Override default 10min → 10s for project_task; the 30s-old WI should now timeout.
    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000, { project_task: 10_000 });
    expect(stuckIds).toContain(wi.id);
  });
});

// ---------------------------------------------------------------------------
// detectExpiredClaims
// ---------------------------------------------------------------------------
describe('detectExpiredClaims', () => {
  it('should detect lease-expired active claims', () => {
    const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
    // Simulate lease expired
    const expiredClaim: TaskClaim = {
      ...claim,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };

    const { expiringIds } = detectExpiredClaims([expiredClaim]);
    expect(expiringIds).toContain(claim.id);
  });

  it('should detect grace-period-exceeded expiring claims', () => {
    const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
    const expiringClaim: TaskClaim = {
      ...claim,
      status: 'expiring',
      leaseExpiresAt: new Date(Date.now() - 200_000).toISOString(), // 200s ago > 180s grace
    };

    const { revokedIds } = detectExpiredClaims([expiringClaim], 180_000);
    expect(revokedIds).toContain(claim.id);
  });

  it('should not flag fresh active claims', () => {
    const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
    const { expiringIds, revokedIds } = detectExpiredClaims([claim]);
    expect(expiringIds).toHaveLength(0);
    expect(revokedIds).toHaveLength(0);
  });

  it('should skip released/revoked claims', () => {
    const claim = createTaskClaim({ workItemId: 'wi-1', agentId: 'agent-1' });
    const released: TaskClaim = { ...claim, status: 'released' };
    const { expiringIds } = detectExpiredClaims([released]);
    expect(expiringIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reconcileRequestStatus
// ---------------------------------------------------------------------------
describe('reconcileRequestStatus', () => {
  it('should transition running request to done when all WorkItems done', () => {
    const request = makeRequest({ status: 'running', workItemIds: ['wi-1', 'wi-2'] });
    const workItems = [
      makeWorkItem({ id: 'wi-1', status: 'done' }),
      makeWorkItem({ id: 'wi-2', status: 'done' }),
    ];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).not.toBeNull();
    expect(correction!.newState).toBe('done');
  });

  it('should transition to waiting_confirmation when requiresConfirmation', () => {
    const request = makeRequest({
      status: 'running',
      requiresConfirmation: true,
      workItemIds: ['wi-1'],
    });
    const workItems = [makeWorkItem({ id: 'wi-1', status: 'done' })];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).not.toBeNull();
    expect(correction!.newState).toBe('waiting_confirmation');
  });

  it('should transition to blocked when all WorkItems blocked/failed', () => {
    const request = makeRequest({ status: 'running', workItemIds: ['wi-1', 'wi-2'] });
    const workItems = [
      makeWorkItem({ id: 'wi-1', status: 'blocked' }),
      makeWorkItem({ id: 'wi-2', status: 'failed' }),
    ];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).not.toBeNull();
    expect(correction!.newState).toBe('blocked');
  });

  it('should keep running if mix of running and done', () => {
    const request = makeRequest({ status: 'running', workItemIds: ['wi-1', 'wi-2'] });
    const workItems = [
      makeWorkItem({ id: 'wi-1', status: 'done' }),
      makeWorkItem({ id: 'wi-2', status: 'running' }),
    ];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).toBeNull(); // already running
  });

  it('should transition ready to running when WorkItems are running', () => {
    const request = makeRequest({ status: 'ready', workItemIds: ['wi-1'] });
    const workItems = [makeWorkItem({ id: 'wi-1', status: 'running' })];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).not.toBeNull();
    expect(correction!.newState).toBe('running');
  });

  it('should not touch terminal requests', () => {
    const doneRequest = makeRequest({ status: 'done' });
    expect(reconcileRequestStatus(doneRequest, [])).toBeNull();

    const cancelledRequest = makeRequest({ status: 'cancelled' });
    expect(reconcileRequestStatus(cancelledRequest, [])).toBeNull();
  });

  it('should not touch open request with no WorkItems', () => {
    const request = makeRequest({ status: 'open' });
    expect(reconcileRequestStatus(request, [])).toBeNull();
  });

  it('should count cancelled WorkItems as done for completion', () => {
    const request = makeRequest({ status: 'running', workItemIds: ['wi-1', 'wi-2'] });
    const workItems = [
      makeWorkItem({ id: 'wi-1', status: 'done' }),
      makeWorkItem({ id: 'wi-2', status: 'cancelled' }),
    ];

    const correction = reconcileRequestStatus(request, workItems);
    expect(correction).not.toBeNull();
    expect(correction!.newState).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// detectOrphanWorkItems
// ---------------------------------------------------------------------------
describe('detectOrphanWorkItems', () => {
  it('should detect children of cancelled parents', () => {
    const parent = makeWorkItem({ id: 'parent-1', status: 'cancelled' });
    const child = makeWorkItem({ id: 'child-1', status: 'running', parentWorkItemId: 'parent-1' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toContain('child-1');
  });

  it('should detect children of permanently-failed parents (retries exhausted)', () => {
    const parent = makeWorkItem({
      id: 'parent-1',
      status: 'failed',
      retryCount: 3,
      maxRetries: 3,
    });
    const child = makeWorkItem({ id: 'child-1', status: 'queued', parentWorkItemId: 'parent-1' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toContain('child-1');
  });

  it('should NOT cascade-cancel when parent is failed but retries remain', () => {
    // Regression: 2026-05-06 dogfood — umbrella WI hit a 10min timeout, was
    // marked failed, all 6 children got cancelled, then auto-retry resurrected
    // the parent leaving it childless. The cascade must skip retry-eligible
    // parents so the auto-retry pass can revive the whole subtree.
    const parent = makeWorkItem({
      id: 'parent-retryable',
      status: 'failed',
      retryCount: 0,
      maxRetries: 3,
    });
    const child = makeWorkItem({ id: 'child-1', status: 'queued', parentWorkItemId: 'parent-retryable' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds, corrections } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toHaveLength(0);
    expect(corrections).toHaveLength(0);
  });

  it('should skip children with active parents', () => {
    const parent = makeWorkItem({ id: 'parent-1', status: 'running' });
    const child = makeWorkItem({ id: 'child-1', status: 'running', parentWorkItemId: 'parent-1' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toHaveLength(0);
  });

  it('should skip terminal children', () => {
    const parent = makeWorkItem({ id: 'parent-1', status: 'cancelled' });
    const child = makeWorkItem({ id: 'child-1', status: 'done', parentWorkItemId: 'parent-1' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toHaveLength(0);
  });

  it('should skip WorkItems without parent', () => {
    const wi = makeWorkItem({ id: 'wi-1', status: 'running' });
    const workItemMap = new Map([[wi.id, wi]]);

    const { orphanIds } = detectOrphanWorkItems([wi], workItemMap);
    expect(orphanIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectTTLExpiredWorkItems
// ---------------------------------------------------------------------------
describe('detectTTLExpiredWorkItems', () => {
  it('should detect WorkItems older than TTL', () => {
    const old = makeWorkItem({
      status: 'queued',
      createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // 25h ago
    });

    const { expiredIds } = detectTTLExpiredWorkItems([old], 24 * 3600 * 1000);
    expect(expiredIds).toContain(old.id);
  });

  it('should not flag fresh WorkItems', () => {
    const fresh = makeWorkItem({ status: 'queued' });
    const { expiredIds } = detectTTLExpiredWorkItems([fresh]);
    expect(expiredIds).toHaveLength(0);
  });

  it('should skip terminal WorkItems', () => {
    const done = makeWorkItem({
      status: 'done',
      createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    });
    const { expiredIds } = detectTTLExpiredWorkItems([done]);
    expect(expiredIds).toHaveLength(0);
  });

  // 2026-05-12 dogfood: 10 done_by_worker WIs sat unreviewable for 86h
  // because the TTL correction was illegal per WORK_ITEM_TRANSITIONS
  // (`done_by_worker` only has edges to `verified` / `rejected`, not
  // `cancelled`). Reconciler logged ERROR every minute, never cleaned up.
  it('routes expired `done_by_worker` to `verified` (the legal terminal edge), not `cancelled`', () => {
    const stale = makeWorkItem({
      status: 'done_by_worker',
      createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
    });

    const { corrections, expiredIds } = detectTTLExpiredWorkItems([stale]);

    expect(expiredIds).toContain(stale.id);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].newState).toBe('verified');
    expect(corrections[0].previousState).toBe('done_by_worker');
  });

  it('keeps `cancelled` as the default expiry target for non-done_by_worker statuses', () => {
    // queued, running, blocked, scheduled, proposed, accepted, escalated
    // — all of these have a `→ cancelled` edge in WORK_ITEM_TRANSITIONS,
    // and `cancelled` is the right "abandoned work" semantic. Verify the
    // picker doesn't accidentally over-generalise to other statuses.
    const old = (status: WorkItemStatus) => makeWorkItem({
      status,
      createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
    });
    const items = [
      old('queued'),
      old('running'),
      old('blocked'),
      old('scheduled'),
    ];

    const { corrections } = detectTTLExpiredWorkItems(items);

    expect(corrections).toHaveLength(4);
    for (const c of corrections) {
      expect(c.newState).toBe('cancelled');
    }
  });
});

// ---------------------------------------------------------------------------
// detectRecoverableWorkItems
// ---------------------------------------------------------------------------
describe('detectRecoverableWorkItems', () => {
  it('should detect blocked WorkItems with agent back online', () => {
    const wi = makeWorkItem({
      status: 'blocked',
      target: 'agent-1',
      retryCount: 1,
      maxRetries: 3,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { recoverableIds } = detectRecoverableWorkItems([wi], agentMap);
    expect(recoverableIds).toContain(wi.id);
  });

  it('should not recover if max retries exhausted', () => {
    const wi = makeWorkItem({
      status: 'blocked',
      target: 'agent-1',
      retryCount: 3,
      maxRetries: 3,
    });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { recoverableIds } = detectRecoverableWorkItems([wi], agentMap);
    expect(recoverableIds).toHaveLength(0);
  });

  it('should not recover if agent still dead', () => {
    const wi = makeWorkItem({
      status: 'blocked',
      target: 'agent-dead',
      retryCount: 0,
      maxRetries: 3,
    });
    const agentMap = makeAgentMap([['agent-dead', { status: 'inactive' }]]);

    const { recoverableIds } = detectRecoverableWorkItems([wi], agentMap);
    expect(recoverableIds).toHaveLength(0);
  });

  it('should skip non-blocked WorkItems', () => {
    const wi = makeWorkItem({ status: 'running', target: 'agent-1' });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { recoverableIds } = detectRecoverableWorkItems([wi], agentMap);
    expect(recoverableIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F4: cascadeCancelChildren
// ---------------------------------------------------------------------------
describe('cascadeCancelChildren', () => {
  it('should cascade cancel direct children', () => {
    const parent = makeWorkItem({ id: 'p1', status: 'cancelled' });
    const child = makeWorkItem({ id: 'c1', status: 'running', parentWorkItemId: 'p1' });

    const { cascadedIds } = cascadeCancelChildren(new Set(['p1']), [parent, child]);
    expect(cascadedIds).toContain('c1');
  });

  it('should cascade cancel grandchildren (deep cascade)', () => {
    const gp = makeWorkItem({ id: 'gp', status: 'cancelled' });
    const parent = makeWorkItem({ id: 'p', status: 'running', parentWorkItemId: 'gp' });
    const child = makeWorkItem({ id: 'c', status: 'queued', parentWorkItemId: 'p' });

    const { cascadedIds } = cascadeCancelChildren(new Set(['gp']), [gp, parent, child]);
    expect(cascadedIds).toContain('p');
    expect(cascadedIds).toContain('c');
  });

  it('should not cascade to terminal children', () => {
    const parent = makeWorkItem({ id: 'p1', status: 'cancelled' });
    const child = makeWorkItem({ id: 'c1', status: 'done', parentWorkItemId: 'p1' });

    const { cascadedIds } = cascadeCancelChildren(new Set(['p1']), [parent, child]);
    expect(cascadedIds).toHaveLength(0);
  });

  it('should not cascade when no parent is cancelled', () => {
    const parent = makeWorkItem({ id: 'p1', status: 'running' });
    const child = makeWorkItem({ id: 'c1', status: 'queued', parentWorkItemId: 'p1' });

    const { cascadedIds } = cascadeCancelChildren(new Set(), [parent, child]);
    expect(cascadedIds).toHaveLength(0);
  });

  it('should handle empty inputs', () => {
    const { cascadedIds } = cascadeCancelChildren(new Set(), []);
    expect(cascadedIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F4: detectStaleQueuedWorkItems
// ---------------------------------------------------------------------------
describe('detectStaleQueuedWorkItems', () => {
  it('should detect WorkItems queued for too long', () => {
    const old = makeWorkItem({
      status: 'queued',
      createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2h ago
    });

    const { staleIds } = detectStaleQueuedWorkItems([old], 60 * 60 * 1000); // 1h threshold
    expect(staleIds).toContain(old.id);
  });

  it('should not flag recently queued WorkItems', () => {
    const fresh = makeWorkItem({ status: 'queued' });
    const { staleIds } = detectStaleQueuedWorkItems([fresh], 60 * 60 * 1000);
    expect(staleIds).toHaveLength(0);
  });

  it('should only check queued status', () => {
    const running = makeWorkItem({
      status: 'running',
      createdAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    });
    const { staleIds } = detectStaleQueuedWorkItems([running], 60 * 60 * 1000);
    expect(staleIds).toHaveLength(0);
  });

  // 2026-05-16 policy change — stale-queued WIs MUST NOT be auto-cancelled.
  // The pre-2026-05-16 behavior emitted `queued→cancelled` corrections
  // when a WI sat queued past staleThresholdMs. That destroyed real
  // user work on 2026-05-16 (Steve's X-article task dispatched to
  // inactive Atlas → cancelled at 60min). PR #585 (eviction-under-
  // memory-pressure) is the right mechanism to actually make progress
  // on stale queued WIs. The function now returns staleIds for
  // observability only; corrections is always empty.
  describe('2026-05-16 no-auto-cancel policy', () => {
    it('emits NO corrections — staleIds is observability-only', () => {
      const stale = makeWorkItem({
        status: 'queued',
        createdAt: new Date(Date.now() - 16 * 3600 * 1000).toISOString(), // 16h ago
      });

      const { corrections, staleIds } = detectStaleQueuedWorkItems([stale], 60 * 60 * 1000);

      expect(corrections).toEqual([]);
      // Still surfaced for callers that want to log/escalate.
      expect(staleIds).toEqual([stale.id]);
    });

    it('emits no corrections even for very-long-queued WIs (945min real-world case)', () => {
      const stale = makeWorkItem({
        status: 'queued',
        createdAt: new Date(Date.now() - 945 * 60 * 1000).toISOString(), // 945min — earlier real-world case
      });

      const { corrections, staleIds } = detectStaleQueuedWorkItems([stale], 60 * 60 * 1000);

      // Old behaviour cancelled this; new behaviour keeps it queued
      // so the target agent can eventually pick it up via the wake /
      // eviction-under-pressure path.
      expect(corrections).toHaveLength(0);
      expect(staleIds).toContain(stale.id);
    });

    it('does not mutate caller-supplied WorkItem objects', () => {
      const stale = makeWorkItem({
        status: 'queued',
        createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      });
      const before = { ...stale };
      detectStaleQueuedWorkItems([stale], 60 * 60 * 1000);
      expect(stale).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------
// F4: runPruningPass
// ---------------------------------------------------------------------------
describe('runPruningPass', () => {
  it('should combine TTL + orphan + cascade + stale detection', () => {
    const now = Date.now();
    const workItems = [
      // TTL expired
      makeWorkItem({ id: 'ttl-1', status: 'queued', createdAt: new Date(now - 25 * 3600000).toISOString() }),
      // Orphan (parent cancelled)
      makeWorkItem({ id: 'parent-x', status: 'cancelled' }),
      makeWorkItem({ id: 'orphan-1', status: 'running', parentWorkItemId: 'parent-x' }),
      // Stale queued
      makeWorkItem({ id: 'stale-1', status: 'queued', createdAt: new Date(now - 2 * 3600000).toISOString() }),
      // Normal active item
      makeWorkItem({ id: 'ok-1', status: 'running' }),
    ];

    const result = runPruningPass(workItems, 24 * 3600000, 60 * 60 * 1000);
    expect(result.ttlExpiredCount).toBe(1);
    expect(result.orphanCancelledCount).toBe(1);
    // stale-1 is stale (2h old), ttl-1 is also queued and old (25h) so it's also stale
    expect(result.staleQueuedCount).toBe(2);
    expect(result.totalCorrections.length).toBeGreaterThan(0);
  });

  it('should return zero counts when nothing to prune', () => {
    const workItems = [
      makeWorkItem({ id: 'ok-1', status: 'running' }),
      makeWorkItem({ id: 'ok-2', status: 'queued' }),
    ];

    const result = runPruningPass(workItems);
    expect(result.ttlExpiredCount).toBe(0);
    expect(result.orphanCancelledCount).toBe(0);
    expect(result.cascadeCancelledCount).toBe(0);
    expect(result.staleQueuedCount).toBe(0);
  });

  it('should handle empty WorkItems array', () => {
    const result = runPruningPass([]);
    expect(result.totalCorrections).toHaveLength(0);
  });

  it('REGRESSION 2026-05-06: failed-but-retryable parent must NOT cascade-cancel its children', () => {
    // Reproduces the dogfood data-loss: umbrella WI hits running-timeout →
    // status='failed' (retryCount=0/max=3). Same reconciler pass runs the
    // pruning loop; before the fix this cancelled all 6 P0 children. After
    // the fix, the children stay queued so the auto-retry can revive the
    // whole subtree.
    const parent = makeWorkItem({
      id: 'umbrella',
      status: 'failed',
      retryCount: 0,
      maxRetries: 3,
    });
    const children = [
      makeWorkItem({ id: 'p0-1', status: 'queued', parentWorkItemId: 'umbrella' }),
      makeWorkItem({ id: 'p0-2', status: 'queued', parentWorkItemId: 'umbrella' }),
      makeWorkItem({ id: 'p0-3', status: 'queued', parentWorkItemId: 'umbrella' }),
      makeWorkItem({ id: 'p0-4', status: 'queued', parentWorkItemId: 'umbrella' }),
      makeWorkItem({ id: 'p0-5', status: 'queued', parentWorkItemId: 'umbrella' }),
      makeWorkItem({ id: 'p0-6', status: 'queued', parentWorkItemId: 'umbrella' }),
    ];

    const result = runPruningPass([parent, ...children]);
    expect(result.orphanCancelledCount).toBe(0);
    expect(result.cascadeCancelledCount).toBe(0);
  });

  it('should still cascade-cancel children when parent has exhausted retries', () => {
    const parent = makeWorkItem({
      id: 'umbrella-dead',
      status: 'failed',
      retryCount: 3,
      maxRetries: 3,
    });
    const child = makeWorkItem({ id: 'c1', status: 'queued', parentWorkItemId: 'umbrella-dead' });

    const result = runPruningPass([parent, child]);
    expect(result.orphanCancelledCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H3: computeAgentScore
// ---------------------------------------------------------------------------
describe('computeAgentScore', () => {
  it('should give max skillMatch when target matches agent', () => {
    const wi = makeWorkItem({ target: 'agent-1', type: 'delegate' });
    const agent: AgentHealth = {
      sessionName: 'agent-1',
      status: 'suspended',
      role: 'developer',
    };

    const score = computeAgentScore(wi, agent, 5 * 60_000);
    expect(score.skillMatch).toBe(40);
    expect(score.contextFamiliarity).toBe(20);
  });

  it('should score tag matches for agents with tags', () => {
    const wi = makeWorkItem({ type: 'delegate', title: 'Fix backend API issue' });
    const agent: AgentHealth = {
      sessionName: 'agent-2',
      status: 'suspended',
      tags: ['backend', 'api'],
    };

    const score = computeAgentScore(wi, agent, 3 * 60_000);
    expect(score.skillMatch).toBeGreaterThan(10); // base + tag matches
  });

  it('should scale urgency based on wait time', () => {
    const wi = makeWorkItem({ type: 'delegate' });
    const agent: AgentHealth = { sessionName: 'agent-1', status: 'suspended' };

    const shortWait = computeAgentScore(wi, agent, 2 * 60_000); // 2min
    const longWait = computeAgentScore(wi, agent, 10 * 60_000); // 10min

    expect(longWait.urgency).toBeGreaterThan(shortWait.urgency);
    expect(longWait.urgency).toBe(30); // Max urgency at 10min
  });

  it('should apply load penalty for busy agents', () => {
    const wi = makeWorkItem({ type: 'delegate' });
    const idle: AgentHealth = { sessionName: 'agent-1', status: 'suspended', activeWorkItemCount: 0 };
    const busy: AgentHealth = { sessionName: 'agent-2', status: 'suspended', activeWorkItemCount: 4 };

    const idleScore = computeAgentScore(wi, idle, 5 * 60_000);
    const busyScore = computeAgentScore(wi, busy, 5 * 60_000);

    expect(idleScore.loadPenalty).toBe(0);
    expect(busyScore.loadPenalty).toBe(20); // capped at 20
  });

  it('should give developers moderate skill match for delegate type', () => {
    const wi = makeWorkItem({ type: 'delegate', target: undefined });
    const agent: AgentHealth = { sessionName: 'agent-dev', status: 'inactive', role: 'developer' };

    const score = computeAgentScore(wi, agent, 3 * 60_000);
    expect(score.skillMatch).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// H3: selectBestAgent
// ---------------------------------------------------------------------------
describe('selectBestAgent', () => {
  it('should select agent with highest score', () => {
    const wi = makeWorkItem({ target: 'agent-1', type: 'delegate' });
    const agents: AgentHealth[] = [
      { sessionName: 'agent-1', status: 'suspended', role: 'developer' },
      { sessionName: 'agent-2', status: 'inactive', role: 'developer' },
    ];

    const result = selectBestAgent(wi, agents, 5 * 60_000);
    expect(result).not.toBeNull();
    expect(result!.agent.sessionName).toBe('agent-1'); // target match = highest score
  });

  it('should exclude agents in excludeAgents set (no-target WI falls back to others)', () => {
    // No `target` on the WI → fall back to skill-based scoring across all agents.
    // `makeWorkItem` defaults `target: 'agent-1'`, so we explicitly clear it
    // to exercise the no-target branch.
    const wi = { ...makeWorkItem({ type: 'delegate' }), target: undefined } as WorkItem;
    const agents: AgentHealth[] = [
      { sessionName: 'agent-1', status: 'suspended', role: 'developer' },
      { sessionName: 'agent-2', status: 'inactive', role: 'developer' },
    ];

    const result = selectBestAgent(wi, agents, 5 * 60_000, new Set(['agent-1']));
    expect(result).not.toBeNull();
    expect(result!.agent.sessionName).toBe('agent-2');
  });

  it('should return null when no agents available', () => {
    const wi = makeWorkItem({ type: 'delegate' });
    const result = selectBestAgent(wi, [], 5 * 60_000);
    expect(result).toBeNull();
  });

  it('should return null when all agents excluded', () => {
    const wi = makeWorkItem({ type: 'delegate' });
    const agents: AgentHealth[] = [
      { sessionName: 'agent-1', status: 'suspended', role: 'developer' },
    ];
    const result = selectBestAgent(wi, agents, 5 * 60_000, new Set(['agent-1']));
    expect(result).toBeNull();
  });

  // 2026-05-17 — when a WorkItem has an explicit `target`, the reconciler
  // must ONLY wake that exact agent. The previous "best-score across all
  // agents" fallback was substituting unrelated agents (Quinn / Reed /
  // Victor) for SLA-tracker `respond_to_user` WIs targeted at crewly-orc,
  // causing the team to spin up on every restart with no actual work.
  describe('2026-05-17 target-strict policy', () => {
    it('only considers the explicit target when wi.target is set', () => {
      const wi = makeWorkItem({ target: 'agent-1', type: 'delegate' });
      const agents: AgentHealth[] = [
        { sessionName: 'agent-1', status: 'suspended', role: 'developer' },
        { sessionName: 'agent-2', status: 'inactive', role: 'developer' },
      ];
      const result = selectBestAgent(wi, agents, 5 * 60_000);
      expect(result?.agent.sessionName).toBe('agent-1');
    });

    it('returns null when the explicit target is excluded — does NOT substitute another agent', () => {
      const wi = makeWorkItem({ target: 'agent-1', type: 'delegate' });
      const agents: AgentHealth[] = [
        { sessionName: 'agent-1', status: 'suspended', role: 'developer' },
        { sessionName: 'agent-2', status: 'inactive', role: 'developer' },
      ];
      const result = selectBestAgent(wi, agents, 5 * 60_000, new Set(['agent-1']));
      expect(result).toBeNull();
    });

    it('returns null when the explicit target is not in the wakable list', () => {
      const wi = makeWorkItem({ target: 'crewly-orc', type: 'review' });
      const agents: AgentHealth[] = [
        { sessionName: 'product-quinn', status: 'inactive', role: 'developer' },
        { sessionName: 'support-reed', status: 'inactive', role: 'customer-support' },
      ];
      const result = selectBestAgent(wi, agents, 5 * 60_000);
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// H3: detectUnclaimedTasks (Hybrid Wake)
// ---------------------------------------------------------------------------
describe('detectUnclaimedTasks', () => {
  const TWO_MIN_AGO = new Date(Date.now() - 3 * 60_000).toISOString(); // 3min ago (past threshold)
  const JUST_NOW = new Date().toISOString();

  it('should detect unclaimed tasks past threshold and select dormant agent', () => {
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: TWO_MIN_AGO,
      type: 'delegate',
      // 2026-05-17 target-strict policy: explicit target must match a wakable
      // agent. Earlier this test relied on skill-based fallback when target
      // was 'agent-1' (the makeWorkItem default) and no such agent existed —
      // that fallback is gone. Target the actual wakable agent.
      target: 'agent-suspended',
    });
    const agentMap = makeAgentMap([
      ['agent-suspended', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions, unclaimedWorkItemIds } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(1);
    expect(wakeActions[0].agentSessionName).toBe('agent-suspended');
    expect(wakeActions[0].strategy).toBe('rehydrate');
    expect(unclaimedWorkItemIds).toContain(wi.id);
  });

  it('should use start strategy for inactive agents', () => {
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: TWO_MIN_AGO,
      type: 'delegate',
      target: 'agent-off', // target-strict policy
    });
    const agentMap = makeAgentMap([
      ['agent-off', { status: 'inactive', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(1);
    expect(wakeActions[0].strategy).toBe('start');
  });

  it('should not wake if there are no unclaimed tasks past threshold', () => {
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: JUST_NOW, // just created
      type: 'delegate',
    });
    const agentMap = makeAgentMap([
      ['agent-suspended', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(0);
  });

  it('should not wake if there are no dormant agents', () => {
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: TWO_MIN_AGO,
      type: 'delegate',
    });
    const agentMap = makeAgentMap([
      ['agent-active', { status: 'active' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(0);
  });

  it('should skip non-queued WorkItems', () => {
    const wi = makeWorkItem({
      status: 'running',
      createdAt: TWO_MIN_AGO,
      type: 'delegate',
    });
    const agentMap = makeAgentMap([
      ['agent-suspended', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(0);
  });

  it('should not wake same agent for multiple items', () => {
    const wi1 = makeWorkItem({ status: 'queued', createdAt: TWO_MIN_AGO, type: 'delegate' });
    const wi2 = makeWorkItem({ status: 'queued', createdAt: TWO_MIN_AGO, type: 'delegate' });
    const agentMap = makeAgentMap([
      ['agent-1', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi1, wi2], agentMap);
    // Only one agent available, so max 1 wake action
    expect(wakeActions).toHaveLength(1);
  });

  it('should limit wake actions per pass', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeWorkItem({
        status: 'queued',
        createdAt: TWO_MIN_AGO,
        type: 'delegate',
      })
    );
    const agents: Array<[string, Partial<AgentHealth>]> = Array.from({ length: 10 }, (_, i) => [
      `agent-${i}`,
      { status: 'suspended' as const, role: 'developer' },
    ]);
    const agentMap = makeAgentMap(agents);

    const { wakeActions } = detectUnclaimedTasks(items, agentMap);
    expect(wakeActions.length).toBeLessThanOrEqual(MAX_WAKE_ACTIONS_PER_PASS);
  });

  it('should use higher threshold when active agents exist', () => {
    // WorkItem only 3min old — below the 5min effective threshold when active agents exist
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      type: 'delegate',
    });
    const agentMap = makeAgentMap([
      ['agent-active', { status: 'active' }],
      ['agent-suspended', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(0); // Below 5min threshold
  });

  it('should wake when items exceed elevated threshold with active agents', () => {
    // WorkItem 6min old — above the 5min effective threshold
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      type: 'delegate',
      target: 'agent-suspended', // target-strict policy
    });
    const agentMap = makeAgentMap([
      ['agent-active', { status: 'active' }],
      ['agent-suspended', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(1);
    expect(wakeActions[0].agentSessionName).toBe('agent-suspended');
  });

  it('should handle empty inputs', () => {
    const { wakeActions } = detectUnclaimedTasks([], new Map());
    expect(wakeActions).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2026-05-23 Atlas case — explicit-target + target-inactive bypass threshold
  //
  // Background: 3 RESEARCH BRIEF WIs created by orchestrator with
  // target=think-tank-atlas sat stuck for 30 min+ each. The
  // delegate-task skill pre-claims the WI before atlas is spawned,
  // pushing it to `running`. detectStuckWorkItems then marks it
  // `blocked`. The wake-rule never fires because the WI is no longer
  // `queued`. Fix #1 (task-pool agent-liveness gate) keeps the WI in
  // `queued`. Fix #2 (here) ensures the wake-rule fires *immediately*
  // for that case — not after a 2- or 5-min wait — since the named
  // target is provably dead and no live agent is going to claim it.
  // -----------------------------------------------------------------------

  describe('explicit-target-inactive bypasses threshold (Atlas 2026-05-23)', () => {
    const JUST_NOW_ISO = new Date(Date.now() - 5_000).toISOString(); // 5s old, well under any threshold

    it('wakes immediately when WI target is inactive and other agents are active', () => {
      // The Atlas scenario: ORC is active, Atlas is inactive, WI just queued.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: JUST_NOW_ISO,
        type: 'delegate',
        target: 'atlas',
      });
      const agentMap = makeAgentMap([
        ['orc', { status: 'active', role: 'orchestrator' }],
        ['atlas', { status: 'inactive', role: 'developer' }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(1);
      expect(wakeActions[0].agentSessionName).toBe('atlas');
      expect(wakeActions[0].strategy).toBe('start');
    });

    it('wakes immediately when WI target is suspended', () => {
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: JUST_NOW_ISO,
        type: 'delegate',
        target: 'paused-agent',
      });
      const agentMap = makeAgentMap([
        ['paused-agent', { status: 'suspended', role: 'developer' }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(1);
      expect(wakeActions[0].agentSessionName).toBe('paused-agent');
      expect(wakeActions[0].strategy).toBe('rehydrate');
    });

    it('does NOT bypass threshold when target is active (redeliver path waits)', () => {
      // Active-but-idle targets still wait for the full threshold —
      // they might be mid-startup-banner; redeliver after 2 min is fine.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: JUST_NOW_ISO,
        type: 'delegate',
        target: 'live-agent',
      });
      const agentMap = makeAgentMap([
        ['live-agent', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });

    it('does NOT bypass threshold for untargeted WI even if dormant agents exist', () => {
      // Strict target-only policy (2026-05-17) still holds — never wake
      // for untargeted WIs, regardless of dormant-agent presence.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: JUST_NOW_ISO,
        type: 'delegate',
        // no target
      });
      const agentMap = makeAgentMap([
        ['atlas', { status: 'inactive', role: 'developer' }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });
  });

  it('should include score breakdown in wake actions', () => {
    const wi = makeWorkItem({
      status: 'queued',
      createdAt: TWO_MIN_AGO,
      type: 'delegate',
    });
    const agentMap = makeAgentMap([
      ['agent-1', { status: 'suspended', role: 'developer' }],
    ]);

    const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
    expect(wakeActions).toHaveLength(1);
    expect(wakeActions[0].scoreBreakdown).toBeDefined();
    expect(wakeActions[0].scoreBreakdown.skillMatch).toBeGreaterThanOrEqual(0);
    expect(wakeActions[0].scoreBreakdown.urgency).toBeGreaterThanOrEqual(0);
    expect(wakeActions[0].score).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2026-05-20 Sora case — redeliver strategy for active-but-idle targets
  // -----------------------------------------------------------------------

  describe('redeliver strategy (active-but-idle target)', () => {
    // Active-but-idle agents only act AFTER the 5-min effective threshold
    // when any active agent is in the map. Make WIs ~7min old.
    const SEVEN_MIN_AGO = new Date(Date.now() - 7 * 60_000).toISOString();

    it('emits redeliver when WI target is active with no active claims', () => {
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'sora',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions, unclaimedWorkItemIds } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(1);
      expect(wakeActions[0].strategy).toBe('redeliver');
      expect(wakeActions[0].agentSessionName).toBe('sora');
      expect(wakeActions[0].workItemId).toBe(wi.id);
      expect(wakeActions[0].score).toBe(0);
      expect(unclaimedWorkItemIds).toContain(wi.id);
    });

    it('does NOT redeliver when target is active but has active claims', () => {
      // active-but-busy: the agent already has work and presumably saw
      // the WI; not a banner-drop scenario.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'sora',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 2 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });

    it('does NOT redeliver when WI has no target', () => {
      // Untargeted WIs never trigger ANY wake (2026-05-17 strict policy).
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: undefined,
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });

    it('does NOT redeliver before the effective threshold', () => {
      // 4min old < 5min effective threshold when an active agent exists.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        type: 'delegate',
        target: 'sora',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });

    it('prefers redeliver over start when target is active-but-idle and another inactive agent exists', () => {
      // The target should ALWAYS get the work — never substitute by score
      // (2026-05-17 strict-target policy). Verifies redeliver takes
      // precedence over best-score search.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'sora',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
        // Another developer is inactive — the OLD behaviour would have
        // tried to start them. The new behaviour must redeliver to sora.
        ['other-dev', { status: 'inactive', role: 'developer' }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(1);
      expect(wakeActions[0].strategy).toBe('redeliver');
      expect(wakeActions[0].agentSessionName).toBe('sora');
    });

    it('does NOT redeliver to the same agent twice in a single pass', () => {
      const wi1 = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'sora',
      });
      const wi2 = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'sora',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi1, wi2], agentMap);
      // One redeliver per pass per agent; the oldest WI wins.
      expect(wakeActions).toHaveLength(1);
      expect(wakeActions[0].strategy).toBe('redeliver');
    });

    it('returns empty when only active-but-idle agents exist but no targeted WIs match', () => {
      // Defensive — verifies the early-return path doesn't skip the
      // active-idle bucket. WI targets a different (absent) agent.
      const wi = makeWorkItem({
        status: 'queued',
        createdAt: SEVEN_MIN_AGO,
        type: 'delegate',
        target: 'someone-else',
      });
      const agentMap = makeAgentMap([
        ['sora', { status: 'active', role: 'developer', activeWorkItemCount: 0 }],
      ]);

      const { wakeActions } = detectUnclaimedTasks([wi], agentMap);
      expect(wakeActions).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// detectUnverifiedWorkItems — verification enforcement (P1)
// ---------------------------------------------------------------------------

describe('detectUnverifiedWorkItems', () => {
  const PAST = (ms: number) => new Date(Date.now() - ms).toISOString();
  const NOW = Date.now();

  it('flags a done_by_worker item awaiting verification past the deadline', () => {
    const stale = makeWorkItem({
      status: 'done_by_worker',
      completedAt: PAST(DEFAULT_VERIFY_ESCALATE_MS + 60_000),
    });
    const { items, unverifiedIds } = detectUnverifiedWorkItems([stale], NOW);
    expect(unverifiedIds).toContain(stale.id);
    expect(items).toHaveLength(1);
  });

  it('does NOT flag a freshly-done item still within the deadline', () => {
    const fresh = makeWorkItem({
      status: 'done_by_worker',
      completedAt: PAST(60_000), // 1 min ago
    });
    const { unverifiedIds } = detectUnverifiedWorkItems([fresh], NOW);
    expect(unverifiedIds).toHaveLength(0);
  });

  it('ignores items that are not done_by_worker', () => {
    const running = makeWorkItem({ status: 'running', startedAt: PAST(DEFAULT_VERIFY_ESCALATE_MS * 5) });
    const verified = makeWorkItem({ status: 'verified', completedAt: PAST(DEFAULT_VERIFY_ESCALATE_MS * 5) });
    const { unverifiedIds } = detectUnverifiedWorkItems([running, verified], NOW);
    expect(unverifiedIds).toHaveLength(0);
  });

  it('fires once per item — skips items already escalated', () => {
    const alreadyEscalated = makeWorkItem({
      status: 'done_by_worker',
      completedAt: PAST(DEFAULT_VERIFY_ESCALATE_MS * 10),
      metadata: { [VERIFY_ESCALATED_AT_KEY]: new Date().toISOString() },
    });
    const { unverifiedIds } = detectUnverifiedWorkItems([alreadyEscalated], NOW);
    expect(unverifiedIds).toHaveLength(0);
  });

  it('honours a custom escalation deadline', () => {
    const wi = makeWorkItem({ status: 'done_by_worker', completedAt: PAST(90_000) }); // 90s ago
    // 60s deadline → flagged; 120s deadline → not flagged.
    expect(detectUnverifiedWorkItems([wi], NOW, 60_000).unverifiedIds).toContain(wi.id);
    expect(detectUnverifiedWorkItems([wi], NOW, 120_000).unverifiedIds).toHaveLength(0);
  });

  it('falls back to startedAt / createdAt when completedAt is absent', () => {
    const wi = makeWorkItem({
      status: 'done_by_worker',
      completedAt: undefined,
      startedAt: PAST(DEFAULT_VERIFY_ESCALATE_MS + 60_000),
    });
    const { unverifiedIds } = detectUnverifiedWorkItems([wi], NOW);
    expect(unverifiedIds).toContain(wi.id);
  });
});
