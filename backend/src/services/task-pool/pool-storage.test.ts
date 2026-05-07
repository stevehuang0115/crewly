/**
 * Pool Storage Tests
 *
 * @module services/task-pool/pool-storage.test
 */

import { PoolStorage, createEmptyPoolData } from './pool-storage.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import { createTaskClaim } from '../../types/v2/claim.types.js';
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
// Test Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory for each test. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pool-storage-test-'));
}

/** Creates a sample queued WorkItem. */
function sampleWorkItem(overrides?: Record<string, unknown>) {
  const wi = createWorkItem({
    type: 'delegate',
    owner: 'agent',
    title: 'Test task',
    target: 'agent-1',
  });
  return { ...wi, ...overrides };
}

/** Creates a sample active TaskClaim. */
function sampleClaim(workItemId: string, agentId = 'agent-1') {
  return createTaskClaim({ workItemId, agentId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PoolStorage', () => {
  let storage: PoolStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    storage = new PoolStorage({ dataDir: tempDir });
  });

  afterEach(async () => {
    await storage.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // createEmptyPoolData
  // -----------------------------------------------------------------------

  describe('createEmptyPoolData', () => {
    it('returns empty arrays and a timestamp', () => {
      const data = createEmptyPoolData();
      expect(data.workItems).toEqual([]);
      expect(data.claims).toEqual([]);
      expect(typeof data.lastUpdatedAt).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // load
  // -----------------------------------------------------------------------

  describe('load', () => {
    it('returns empty pool data when file does not exist', async () => {
      const data = await storage.load();
      expect(data.workItems).toEqual([]);
      expect(data.claims).toEqual([]);
    });

    it('returns cached data on subsequent calls', async () => {
      const d1 = await storage.load();
      const d2 = await storage.load();
      expect(d1).toBe(d2);
    });

    // F-CYCLE7-3 (2026-05-07) — defensive normalization. A partial /
    // pre-migration on-disk shape (missing one or both arrays) caused
    // ".filter() on undefined" downstream in ReconcilerDataProvider.
    // load() now coerces missing arrays to [] once, so every consumer
    // can rely on the PoolData invariant.
    describe('F-CYCLE7-3: partial on-disk shape normalization', () => {
      it('normalizes missing workItems field to []', async () => {
        const filePath = path.join(tempDir, 'pool.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ claims: [], lastUpdatedAt: new Date().toISOString() }),
        );

        const fresh = new PoolStorage({ dataDir: tempDir });
        const data = await fresh.load();

        expect(data.workItems).toEqual([]);
        expect(Array.isArray(data.workItems)).toBe(true);
        await fresh.destroy();
      });

      it('normalizes missing claims field to []', async () => {
        const filePath = path.join(tempDir, 'pool.json');
        await fs.writeFile(
          filePath,
          JSON.stringify({ workItems: [], lastUpdatedAt: new Date().toISOString() }),
        );

        const fresh = new PoolStorage({ dataDir: tempDir });
        const data = await fresh.load();

        expect(data.claims).toEqual([]);
        expect(Array.isArray(data.claims)).toBe(true);
        await fresh.destroy();
      });

      it('normalizes both fields when on-disk shape is just `{}`', async () => {
        const filePath = path.join(tempDir, 'pool.json');
        await fs.writeFile(filePath, JSON.stringify({}));

        const fresh = new PoolStorage({ dataDir: tempDir });
        const data = await fresh.load();

        expect(data.workItems).toEqual([]);
        expect(data.claims).toEqual([]);
        await fresh.destroy();
      });

      it('getWorkItems() / getClaims() never return undefined even on partial shape', async () => {
        const filePath = path.join(tempDir, 'pool.json');
        await fs.writeFile(filePath, JSON.stringify({ lastUpdatedAt: 'x' }));

        const fresh = new PoolStorage({ dataDir: tempDir });
        // The downstream regression: .filter() on whatever this returns.
        const items = await fresh.getWorkItems();
        const claims = await fresh.getClaims();

        expect(() => items.filter(() => true)).not.toThrow();
        expect(() => claims.filter(() => true)).not.toThrow();
        expect(items).toEqual([]);
        expect(claims).toEqual([]);
        await fresh.destroy();
      });
    });
  });

  // -----------------------------------------------------------------------
  // addWorkItem / getWorkItems / findWorkItem
  // -----------------------------------------------------------------------

  describe('work item operations', () => {
    it('adds and retrieves a work item', async () => {
      const wi = sampleWorkItem();
      await storage.addWorkItem(wi);

      const items = await storage.getWorkItems();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(wi.id);
    });

    it('finds a work item by ID', async () => {
      const wi = sampleWorkItem();
      await storage.addWorkItem(wi);

      const found = await storage.findWorkItem(wi.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Test task');
    });

    it('returns undefined for non-existent ID', async () => {
      const found = await storage.findWorkItem('non-existent');
      expect(found).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // updateWorkItem
  // -----------------------------------------------------------------------

  describe('updateWorkItem', () => {
    it('updates an existing work item', async () => {
      const wi = sampleWorkItem();
      await storage.addWorkItem(wi);

      const updated = await storage.updateWorkItem(wi.id, (item) => {
        item.status = 'running';
        item.startedAt = new Date().toISOString();
      });

      expect(updated).toBe(true);
      const found = await storage.findWorkItem(wi.id);
      expect(found!.status).toBe('running');
      expect(found!.startedAt).toBeDefined();
    });

    it('returns false for non-existent item', async () => {
      const updated = await storage.updateWorkItem('ghost', () => {});
      expect(updated).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // removeWorkItem
  // -----------------------------------------------------------------------

  describe('removeWorkItem', () => {
    it('removes an existing work item', async () => {
      const wi = sampleWorkItem();
      await storage.addWorkItem(wi);
      expect(await storage.getWorkItems()).toHaveLength(1);

      const removed = await storage.removeWorkItem(wi.id);
      expect(removed).toBe(true);
      expect(await storage.getWorkItems()).toHaveLength(0);
    });

    it('returns false for non-existent item', async () => {
      const removed = await storage.removeWorkItem('ghost');
      expect(removed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Claim operations
  // -----------------------------------------------------------------------

  describe('claim operations', () => {
    it('adds and retrieves claims', async () => {
      const claim = sampleClaim('wi-1');
      await storage.addClaim(claim);

      const claims = await storage.getClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].workItemId).toBe('wi-1');
    });

    it('finds active claim by work item ID', async () => {
      const claim = sampleClaim('wi-1');
      await storage.addClaim(claim);

      const found = await storage.findActiveClaimByWorkItem('wi-1');
      expect(found).toBeDefined();
      expect(found!.agentId).toBe('agent-1');
    });

    it('does not find released claims as active', async () => {
      const claim = sampleClaim('wi-1');
      claim.status = 'released';
      await storage.addClaim(claim);

      const found = await storage.findActiveClaimByWorkItem('wi-1');
      expect(found).toBeUndefined();
    });

    it('finds active claim by agent ID', async () => {
      const claim = sampleClaim('wi-1', 'agent-leo');
      await storage.addClaim(claim);

      const found = await storage.findActiveClaimByAgent('agent-leo');
      expect(found).toBeDefined();
      expect(found!.workItemId).toBe('wi-1');
    });

    it('updates a claim', async () => {
      const claim = sampleClaim('wi-1');
      await storage.addClaim(claim);

      const updated = await storage.updateClaim(claim.id, (c) => {
        c.status = 'released';
        c.endedAt = new Date().toISOString();
      });

      expect(updated).toBe(true);
      const claims = await storage.getClaims();
      expect(claims[0].status).toBe('released');
    });

    it('returns false when updating non-existent claim', async () => {
      const updated = await storage.updateClaim('ghost', () => {});
      expect(updated).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // flush / persistence
  // -----------------------------------------------------------------------

  describe('flush', () => {
    it('persists data to disk and reloads correctly', async () => {
      const wi = sampleWorkItem();
      await storage.addWorkItem(wi);
      await storage.flush();

      // Create new storage instance pointing to same dir
      const storage2 = new PoolStorage({ dataDir: tempDir });
      const items = await storage2.getWorkItems();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(wi.id);
      await storage2.destroy();
    });

    it('does nothing when not dirty', async () => {
      await storage.load();
      // flush without changes should not throw
      await storage.flush();
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('removes all data', async () => {
      await storage.addWorkItem(sampleWorkItem());
      await storage.addClaim(sampleClaim('wi-1'));

      await storage.clear();
      expect(await storage.getWorkItems()).toHaveLength(0);
      expect(await storage.getClaims()).toHaveLength(0);
    });
  });
});
