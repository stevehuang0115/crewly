/**
 * Tests for Reconcile Rules
 *
 * @module services/reconciler/reconcile-rules.test
 */

import { describe, it, expect } from 'vitest';
import {
  detectStuckWorkItems,
  detectExpiredClaims,
  reconcileRequestStatus,
  detectOrphanWorkItems,
  detectTTLExpiredWorkItems,
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
import type { WorkItem, Request, TaskClaim } from '../../types/v2/index.js';

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
    const wi = makeWorkItem({ status: 'running', target: 'agent-1', startedAt: oldStart });
    const agentMap = makeAgentMap([['agent-1', { status: 'active' }]]);

    const { stuckIds } = detectStuckWorkItems([wi], agentMap, 600_000);
    expect(stuckIds).toContain(wi.id);
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

  it('should detect children of failed parents', () => {
    const parent = makeWorkItem({ id: 'parent-1', status: 'failed' });
    const child = makeWorkItem({ id: 'child-1', status: 'queued', parentWorkItemId: 'parent-1' });
    const workItemMap = new Map([[parent.id, parent], [child.id, child]]);

    const { orphanIds } = detectOrphanWorkItems([child], workItemMap);
    expect(orphanIds).toContain('child-1');
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

  it('should exclude agents in excludeAgents set', () => {
    const wi = makeWorkItem({ target: 'agent-1', type: 'delegate' });
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
});
