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
      const upstream = makeWorkItem({ title: 'upstream' });
      await service.addToPool(upstream);

      const downstream = makeWorkItem({
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
      const depA = makeWorkItem({ title: 'dep-a' });
      const depB = makeWorkItem({ title: 'dep-b' });
      await service.addToPool(depA);
      await service.addToPool(depB);

      const downstream = makeWorkItem({
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
      const otherUpstream = makeWorkItem({ title: 'other' });
      const unrelatedDownstream = makeWorkItem({
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

  describe('completeItem', () => {
    it('marks item as done and releases claim', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id, { output: 'success' });

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done');
      expect(items[0].completedAt).toBeDefined();
      expect(items[0].result).toEqual({ output: 'success' });
    });

    it('throws when item not found', async () => {
      await expect(service.completeItem('ghost')).rejects.toThrow(
        'WorkItem not found',
      );
    });

    it('throws when item is not running', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      await expect(service.completeItem(wi.id)).rejects.toThrow(
        "status must be 'running'",
      );
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
});
