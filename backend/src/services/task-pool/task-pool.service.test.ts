/**
 * Task Pool Service Tests
 *
 * @module services/task-pool/task-pool.service.test
 */

import { TaskPoolService } from './task-pool.service.js';
import { PoolStorage } from './pool-storage.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-pool-test-'));
}

function makeWorkItem(overrides?: Record<string, unknown>) {
  return createWorkItem({
    type: 'delegate',
    owner: 'agent',
    title: 'Test task',
    target: 'agent-1',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskPoolService', () => {
  let service: TaskPoolService;
  let storage: PoolStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    storage = new PoolStorage({ dataDir: tempDir });
    service = new TaskPoolService(storage);
  });

  afterEach(async () => {
    TaskPoolService.resetInstance();
    await service.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // addToPool
  // -----------------------------------------------------------------------

  describe('addToPool', () => {
    it('adds a queued WorkItem to the pool', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(wi.id);
    });

    it('rejects non-queued items', async () => {
      const wi = makeWorkItem();
      wi.status = 'running';

      await expect(service.addToPool(wi)).rejects.toThrow(
        "status must be 'queued'",
      );
    });

    it('rejects invalid WorkItem objects', async () => {
      const invalid = { id: 'x' } as any;
      await expect(service.addToPool(invalid)).rejects.toThrow('Invalid WorkItem');
    });

    it('skips duplicate items silently', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.addToPool(wi); // duplicate

      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
    });

    it('accepts a blocked WorkItem (waiting on deps)', async () => {
      const wi = makeWorkItem({ dependsOn: ['upstream-1'] });
      // makeWorkItem builds via createWorkItem, so dependsOn → blocked
      expect(wi.status).toBe('blocked');

      await service.addToPool(wi);
      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('blocked');
    });
  });

  // -----------------------------------------------------------------------
  // Dependency resolution (auto-unblock)
  // -----------------------------------------------------------------------

  describe('dependency resolution', () => {
    it('promotes a blocked dependent to queued when its single dep completes', async () => {
      const upstream = makeWorkItem({ type: 'cron_run', title: 'upstream' });
      await service.addToPool(upstream);

      const downstream = makeWorkItem({
        type: 'cron_run',
        title: 'downstream',
        dependsOn: [upstream.id],
      });
      await service.addToPool(downstream);

      // Claim + complete upstream — should auto-unblock downstream
      const claim = await service.claimFromPool('agent-a');
      expect(claim!.workItem.id).toBe(upstream.id);
      await service.completeItem(upstream.id);

      const items = await service.getAllItems();
      const after = items.find((wi) => wi.id === downstream.id)!;
      expect(after.status).toBe('queued');
    });

    it('keeps the dependent blocked until ALL deps complete', async () => {
      const depA = makeWorkItem({ type: 'cron_run', title: 'dep-a' });
      const depB = makeWorkItem({ type: 'cron_run', title: 'dep-b' });
      await service.addToPool(depA);
      await service.addToPool(depB);

      const downstream = makeWorkItem({
        type: 'cron_run',
        title: 'downstream',
        dependsOn: [depA.id, depB.id],
      });
      await service.addToPool(downstream);

      // Complete only depA first
      await service.claimFromPool('agent-a');
      await service.completeItem(depA.id);

      let items = await service.getAllItems();
      expect(items.find((wi) => wi.id === downstream.id)!.status).toBe('blocked');

      // Now complete depB — downstream should unblock
      await service.claimFromPool('agent-b');
      await service.completeItem(depB.id);

      items = await service.getAllItems();
      expect(items.find((wi) => wi.id === downstream.id)!.status).toBe('queued');
    });

    it('does not touch dependents that list a different upstream', async () => {
      const otherUpstream = makeWorkItem({ type: 'cron_run', title: 'other' });
      const unrelatedDownstream = makeWorkItem({
        type: 'cron_run',
        title: 'unrelated',
        dependsOn: ['some-other-id'],
      });
      await service.addToPool(otherUpstream);
      await service.addToPool(unrelatedDownstream);

      await service.claimFromPool('agent-a');
      await service.completeItem(otherUpstream.id);

      const items = await service.getAllItems();
      expect(items.find((wi) => wi.id === unrelatedDownstream.id)!.status).toBe(
        'blocked',
      );
    });
  });

  // -----------------------------------------------------------------------
  // claimFromPool
  // -----------------------------------------------------------------------

  describe('claimFromPool', () => {
    it('claims the oldest available item (FIFO)', async () => {
      const wi1 = makeWorkItem({ title: 'First' });
      const wi2 = makeWorkItem({ title: 'Second' });
      // Ensure wi1 is older
      wi1.createdAt = new Date(Date.now() - 10000).toISOString();
      wi2.createdAt = new Date().toISOString();

      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo');
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('First');
      expect(result!.workItem.status).toBe('running');
      expect(result!.claim.agentId).toBe('agent-leo');
    });

    it('returns null when pool is empty', async () => {
      const result = await service.claimFromPool('agent-leo');
      expect(result).toBeNull();
    });

    it('returns null when all items are claimed', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const result = await service.claimFromPool('agent-max');
      expect(result).toBeNull();
    });

    it('prevents agent from claiming when they already have a claim', async () => {
      const wi1 = makeWorkItem({ title: 'First' });
      const wi2 = makeWorkItem({ title: 'Second' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      await service.claimFromPool('agent-leo');
      const second = await service.claimFromPool('agent-leo');
      expect(second).toBeNull();
    });

    it('filters by type', async () => {
      const wi1 = makeWorkItem({ type: 'delegate', title: 'Delegate' });
      const wi2 = makeWorkItem({ type: 'check', title: 'Check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        types: ['check'],
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('Check');
    });

    it('filters by owner', async () => {
      const wi1 = makeWorkItem({ owner: 'agent', title: 'Agent task' });
      const wi2 = makeWorkItem({ owner: 'system', title: 'System task' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        owner: 'system',
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('System task');
    });

    it('filters by missionId', async () => {
      const wi1 = makeWorkItem({ title: 'No mission' });
      const wi2 = makeWorkItem({ title: 'With mission' });
      wi2.missionId = 'mission-123';
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        missionId: 'mission-123',
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('With mission');
    });

    it('throws on empty agentId', async () => {
      await expect(service.claimFromPool('')).rejects.toThrow('agentId is required');
    });

    it('serializes concurrent claims so only one agent wins a given WorkItem', async () => {
      // Single queued item — two agents race to claim it concurrently.
      const wi = makeWorkItem({ title: 'Contested' });
      await service.addToPool(wi);

      const [a, b] = await Promise.all([
        service.claimFromPool('agent-a'),
        service.claimFromPool('agent-b'),
      ]);

      // Exactly one of the two must have won.
      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.workItem.id).toBe(wi.id);

      // Storage must reflect a single active claim, not two.
      const snapshot = await service.getPoolStatus();
      expect(snapshot.claimed).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // releaseBack
  // -----------------------------------------------------------------------

  describe('releaseBack', () => {
    it('releases a claimed item back to queued', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.releaseBack(wi.id, 'agent busy');

      const items = await service.getAvailableItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('queued');
      expect(items[0].retryCount).toBe(1);
    });

    it('throws when item not found', async () => {
      await expect(service.releaseBack('ghost', 'test')).rejects.toThrow(
        'WorkItem not found',
      );
    });

    it('throws when item is not running', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      await expect(service.releaseBack(wi.id, 'test')).rejects.toThrow(
        "status must be 'running'",
      );
    });

    it('allows another agent to claim after release', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.releaseBack(wi.id, 'busy');

      const result = await service.claimFromPool('agent-max');
      expect(result).not.toBeNull();
      expect(result!.claim.agentId).toBe('agent-max');
    });
  });

  // -----------------------------------------------------------------------
  // completeItem
  // -----------------------------------------------------------------------

  describe('completeItem (facade — VERIF-1 routing)', () => {
    it('routes a non-delegate item through completeSimpleItem (status → done)', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id, { output: 'success' });

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done');
      expect(items[0].completedAt).toBeDefined();
      expect(items[0].result).toEqual({ output: 'success' });
    });

    it('routes a delegate item through submitForVerification (status → done_by_worker)', async () => {
      // delegate items default to "requires verification" so the worker's
      // implicit completeItem call should park the item in done_by_worker
      // and wake the TL — never auto-advance to done.
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id, { output: 'draft' });

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done_by_worker');
      expect(items[0].result).toEqual({ output: 'draft' });
    });

    it('respects metadata.requiresVerification=false on a delegate item (F-H — review WIs do not self-verify)', async () => {
      // F-H: REVIEW-1's review WorkItems are themselves the verification
      // step, so they MUST opt out of the delegate-default to avoid a
      // TL-self-verification loop. This is the explicit override path.
      const wi = makeWorkItem({
        type: 'delegate',
        metadata: { requiresVerification: false },
      });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id);

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done');
    });

    it('respects metadata.requiresVerification=true on a non-delegate item (explicit opt-in)', async () => {
      const wi = makeWorkItem({
        type: 'cron_run',
        metadata: { requiresVerification: true },
      });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id);

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done_by_worker');
    });

    it('throws when item not found', async () => {
      await expect(service.completeItem('ghost')).rejects.toThrow(
        'WorkItem not found',
      );
    });

    it('throws when item is not running (delegate path surfaces TRANS-1 invalid-transition error)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);

      // queued → done_by_worker is rejected by the state machine
      await expect(service.completeItem(wi.id)).rejects.toThrow(
        /Invalid status transition/,
      );
    });

    it('throws when item is not running (simple path surfaces TRANS-1 invalid-transition error)', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);

      await expect(service.completeItem(wi.id)).rejects.toThrow(
        /Invalid status transition/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // submitForVerification (VERIF-1)
  // -----------------------------------------------------------------------

  describe('submitForVerification', () => {
    it('transitions running → done_by_worker for an agent actor', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.submitForVerification(wi.id, 'agent', { output: 'draft' });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('done_by_worker');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.result).toEqual({ output: 'draft' });
    });

    it('releases the active claim with endReason="submitted_for_verification"', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.submitForVerification(wi.id, 'agent');

      const active = await service.getActiveClaims();
      // The submitted item's claim is released — no longer active
      expect(active).toHaveLength(0);
    });

    it('rejects a non-agent actor (e.g. team_lead self-submission) via TRANS-1 actor gate', async () => {
      // TRANSITION_PERMISSIONS limits running→done_by_worker to 'agent'.
      // A TL trying to submit on a worker's behalf must throw.
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await expect(service.submitForVerification(wi.id, 'team_lead'))
        .rejects.toThrow(/Forbidden transition.*actor='team_lead'/);
    });

    it('rejects when the item is not in running status (state-machine gate)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);

      await expect(service.submitForVerification(wi.id, 'agent'))
        .rejects.toThrow(/Invalid status transition/);
    });
  });

  // -----------------------------------------------------------------------
  // completeSimpleItem (VERIF-1)
  // -----------------------------------------------------------------------

  describe('completeSimpleItem', () => {
    it('transitions running → done for an agent actor', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.completeSimpleItem(wi.id, 'agent', { output: 'tick' });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('done');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.result).toEqual({ output: 'tick' });
    });

    it('promotes blocked dependents whose deps are now satisfied', async () => {
      const upstream = makeWorkItem({ type: 'cron_run' });
      const downstream = makeWorkItem({ type: 'cron_run', dependsOn: [upstream.id] });
      await service.addToPool(upstream);
      await service.addToPool(downstream);
      // downstream starts blocked because upstream is not yet terminal
      const downstreamBefore = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamBefore?.status).toBe('blocked');

      await service.claimFromPool('agent-leo');
      await service.completeSimpleItem(upstream.id, 'agent');

      const downstreamAfter = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamAfter?.status).toBe('queued');
    });

    it('accepts the "system" actor (Reconciler path bypasses actor check)', async () => {
      const wi = makeWorkItem({ type: 'reconcile' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.completeSimpleItem(wi.id, 'system');

      expect(updated!.status).toBe('done');
    });
  });

  // -----------------------------------------------------------------------
  // verifyItem (VERIF-1)
  // -----------------------------------------------------------------------

  describe('verifyItem', () => {
    /**
     * Drives a WorkItem through `running → done_by_worker` so the verify
     * tests can exercise the verdict transitions in isolation.
     */
    async function makeAwaitingVerification(opts?: { type?: 'delegate' | 'cron_run' }) {
      const wi = makeWorkItem({ type: opts?.type ?? 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.submitForVerification(wi.id, 'agent', { output: 'draft' });
      return wi;
    }

    it('transitions done_by_worker → verified for a team_lead actor', async () => {
      const wi = await makeAwaitingVerification();

      const updated = await service.verifyItem(wi.id, 'team_lead', 'verified');

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('verified');
    });

    it('transitions done_by_worker → rejected for a team_lead actor with a reviewer comment', async () => {
      const wi = await makeAwaitingVerification();

      const updated = await service.verifyItem(wi.id, 'team_lead', 'rejected', 'Output incomplete');

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('rejected');
      // Reviewer comment surfaced via the existing `error` field — see JSDoc
      expect(updated!.error).toBe('Output incomplete');
    });

    it('rejects an agent actor calling verifyItem (workers cannot self-verify)', async () => {
      const wi = await makeAwaitingVerification();

      await expect(service.verifyItem(wi.id, 'agent', 'verified'))
        .rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('rejects an invalid verdict before touching the state machine', async () => {
      const wi = await makeAwaitingVerification();

      await expect(
        service.verifyItem(wi.id, 'team_lead', 'cancelled' as 'verified'),
      ).rejects.toThrow(/Invalid verdict/);
    });

    it('promotes blocked dependents on verified (terminal-success unblocks waiters)', async () => {
      const upstream = makeWorkItem({ type: 'delegate' });
      const downstream = makeWorkItem({ type: 'cron_run', dependsOn: [upstream.id] });
      await service.addToPool(upstream);
      await service.addToPool(downstream);
      await service.claimFromPool('agent-leo');
      await service.submitForVerification(upstream.id, 'agent');

      await service.verifyItem(upstream.id, 'team_lead', 'verified');

      const downstreamAfter = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamAfter?.status).toBe('queued');
    });

    it('rejects a verdict on an item that is not in done_by_worker (state-machine gate)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      // never claimed / submitted — still queued

      await expect(service.verifyItem(wi.id, 'team_lead', 'verified'))
        .rejects.toThrow(/Invalid status transition/);
    });
  });

  // -----------------------------------------------------------------------
  // failItem
  // -----------------------------------------------------------------------

  describe('failItem', () => {
    it('marks item as failed with error', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.failItem(wi.id, 'agent crashed');

      const items = await service.getAllItems();
      expect(items[0].status).toBe('failed');
      expect(items[0].error).toBe('agent crashed');
    });

    it('throws when item not found', async () => {
      await expect(service.failItem('ghost', 'error')).rejects.toThrow(
        'WorkItem not found',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getPoolStatus
  // -----------------------------------------------------------------------

  describe('getPoolStatus', () => {
    it('returns correct snapshot for empty pool', async () => {
      const status = await service.getPoolStatus();
      expect(status.total).toBe(0);
      expect(status.available).toBe(0);
      expect(status.claimed).toBe(0);
      expect(status.avgWaitTimeMs).toBe(0);
    });

    it('counts available and claimed correctly', async () => {
      const wi1 = makeWorkItem({ title: 'One' });
      const wi2 = makeWorkItem({ title: 'Two' });
      const wi3 = makeWorkItem({ title: 'Three' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);
      await service.addToPool(wi3);

      await service.claimFromPool('agent-leo');

      const status = await service.getPoolStatus();
      expect(status.total).toBe(3);
      expect(status.available).toBe(2);
      expect(status.claimed).toBe(1);
    });

    it('computes average wait time', async () => {
      const wi = makeWorkItem();
      wi.createdAt = new Date(Date.now() - 5000).toISOString();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const status = await service.getPoolStatus();
      expect(status.avgWaitTimeMs).toBeGreaterThan(0);
    });

    it('breaks down by type and status', async () => {
      const wi1 = makeWorkItem({ type: 'delegate' });
      const wi2 = makeWorkItem({ type: 'check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const status = await service.getPoolStatus();
      expect(status.byType['delegate']).toBe(1);
      expect(status.byType['check']).toBe(1);
      expect(status.byStatus['queued']).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getAvailableItems
  // -----------------------------------------------------------------------

  describe('getAvailableItems', () => {
    it('returns only unclaimed queued items', async () => {
      const wi1 = makeWorkItem({ title: 'Available' });
      const wi2 = makeWorkItem({ title: 'Claimed' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);
      await service.claimFromPool('agent-leo');

      const available = await service.getAvailableItems();
      expect(available).toHaveLength(1);
    });

    it('respects filters', async () => {
      const wi1 = makeWorkItem({ type: 'delegate' });
      const wi2 = makeWorkItem({ type: 'check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const available = await service.getAvailableItems({ types: ['check'] });
      expect(available).toHaveLength(1);
      expect(available[0].type).toBe('check');
    });
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('singleton', () => {
    it('returns same instance', () => {
      const a = TaskPoolService.getInstance();
      const b = TaskPoolService.getInstance();
      expect(a).toBe(b);
      TaskPoolService.resetInstance();
    });

    it('resets instance', () => {
      const a = TaskPoolService.getInstance();
      TaskPoolService.resetInstance();
      const b = TaskPoolService.getInstance();
      expect(a).not.toBe(b);
      TaskPoolService.resetInstance();
    });
  });

  // -----------------------------------------------------------------------
  // getActiveClaims (V3 integration)
  // -----------------------------------------------------------------------

  describe('getActiveClaims', () => {
    it('returns active claims after claiming', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].agentId).toBe('agent-leo');
      expect(claims[0].status).toBe('active');
    });

    it('returns empty when no claims', async () => {
      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(0);
    });

    it('excludes released claims', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.completeItem(wi.id);

      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateItemStatus (V3 integration — used by Reconciler)
  // -----------------------------------------------------------------------

  describe('updateItemStatus', () => {
    it('updates running item to blocked', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.updateItemStatus(wi.id, 'blocked');

      const items = await service.getAllItems();
      const updated = items.find(i => i.id === wi.id);
      expect(updated!.status).toBe('blocked');
    });

    it('throws for nonexistent item', async () => {
      await expect(service.updateItemStatus('ghost-id', 'blocked'))
        .rejects.toThrow('WorkItem not found');
    });

    it('throws for invalid transition', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      // queued → done is not a valid direct transition
      await expect(service.updateItemStatus(wi.id, 'done'))
        .rejects.toThrow('Invalid status transition');
    });
  });

  // -----------------------------------------------------------------------
  // markClaimExpiring (V3 integration — used by Reconciler)
  // -----------------------------------------------------------------------

  describe('markClaimExpiring', () => {
    it('marks an active claim as expiring', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const result = await service.claimFromPool('agent-leo');
      expect(result).not.toBeNull();

      await service.markClaimExpiring(result!.claim.id);

      // Claim should now be 'expiring' — verify via getActiveClaims
      // (expiring claims are still considered active for reconciliation)
      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('expiring');
    });
  });

  // =========================================================================
  // TRANS-1: transitionStatus + role-based permission enforcement (V3)
  // =========================================================================

  describe('transitionStatus — TRANS-1 V3 enforcement', () => {
    /**
     * Helper: add a WorkItem to the pool and claim it so it reaches 'running'
     * status, mirroring the steady-state of an in-flight task. Used by the
     * verification gate tests.
     */
    async function makeRunning(): Promise<{ id: string; agent: string }> {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const result = await service.claimFromPool('agent-test');
      expect(result).not.toBeNull();
      return { id: result!.workItem.id, agent: 'agent-test' };
    }

    it('throws when WorkItem does not exist', async () => {
      await expect(
        service.transitionStatus('does-not-exist', 'done', 'system'),
      ).rejects.toThrow(/WorkItem not found/);
    });

    it('throws on illegal state-machine transition (e.g. done → running)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-test');
      // Drive to terminal 'done' first via the legitimate path.
      await service.transitionStatus(wi.id, 'done', 'system');
      // Now attempt to revert — disallowed by WORK_ITEM_TRANSITIONS.
      await expect(
        service.transitionStatus(wi.id, 'running', 'system'),
      ).rejects.toThrow(/Invalid status transition/);
    });

    it('agent CANNOT verify their own work (running → verified blocked for agent)', async () => {
      const { id } = await makeRunning();
      // Move to done_by_worker via agent — this is allowed.
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      // Attempt agent self-verification — must throw.
      await expect(
        service.transitionStatus(id, 'verified', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('team_lead CAN verify worker output (done_by_worker → verified)', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      const verified = await service.transitionStatus(id, 'verified', 'team_lead');
      expect(verified).not.toBeNull();
      expect(verified!.status).toBe('verified');
    });

    it('team_lead CAN reject worker output with custom mutator carrying the error', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      const rejected = await service.transitionStatus(id, 'rejected', 'team_lead', (wi) => {
        wi.error = 'Did not meet acceptance criteria';
      });
      expect(rejected!.status).toBe('rejected');
      expect(rejected!.error).toBe('Did not meet acceptance criteria');
    });

    // -----------------------------------------------------------------------
    // F-F: rejected → queued is gated to TL/orchestrator/system only
    // -----------------------------------------------------------------------

    it('F-F: agent CANNOT self-revive a rejected WorkItem (rejected → queued)', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      // Attempt agent self-revival — must throw per F-F.
      await expect(
        service.transitionStatus(id, 'queued', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('F-F: team_lead CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'team_lead');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: orchestrator CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'orchestrator');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: system actor (Reconciler) CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'system');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: agent CANNOT self-revive a failed WorkItem (failed → queued)', async () => {
      const { id } = await makeRunning();
      // Move to failed via the existing failItem path.
      await service.failItem(id, 'simulated failure');
      // Attempt agent self-revival — must throw per F-F.
      await expect(
        service.transitionStatus(id, 'queued', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('system actor passes through any legal transition (Reconciler exemption)', async () => {
      const { id } = await makeRunning();
      // Reconciler stuck-running corrective: running → blocked.
      const blocked = await service.transitionStatus(id, 'blocked', 'system');
      expect(blocked!.status).toBe('blocked');
    });

    // -----------------------------------------------------------------------
    // mutator atomicity
    // -----------------------------------------------------------------------

    it('mutator runs atomically with the status update', async () => {
      const { id } = await makeRunning();
      const updated = await service.transitionStatus(id, 'done', 'system', (wi) => {
        wi.result = { reportPath: '/tmp/done.md' };
        wi.cost = 0.42;
      });
      expect(updated!.status).toBe('done');
      expect(updated!.result).toEqual({ reportPath: '/tmp/done.md' });
      expect(updated!.cost).toBe(0.42);
      expect(updated!.completedAt).toBeDefined();
    });

    it('refreshes startedAt on transition into running', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const before = new Date().toISOString();
      const updated = await service.transitionStatus(wi.id, 'running', 'system');
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeDefined();
      expect(updated!.startedAt! >= before).toBe(true);
    });
  });

  // =========================================================================
  // TRANS-1: updateItemStatus actor-role gate (Reconciler legacy entry)
  // =========================================================================

  describe('updateItemStatus — TRANS-1 V3 actor gate', () => {
    it('defaults actorRole to "system" when omitted (Reconciler default)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      // No third arg — defaults to system per backwards compat.
      await service.updateItemStatus(wi.id, 'running');
      const items = await service.getAvailableItems();
      // Legacy callers continue to work unchanged.
      expect(items.find((x) => x.id === wi.id)).toBeUndefined(); // no longer queued
    });

    it('rejects an agent attempting an unauthorised transition via updateItemStatus', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-test');
      // agent moves to done_by_worker (allowed).
      await service.updateItemStatus(wi.id, 'done_by_worker', 'agent');
      // agent now attempts to verify themselves — must throw.
      await expect(
        service.updateItemStatus(wi.id, 'verified', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });
  });
});
