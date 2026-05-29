/**
 * Tests for WikiWorkItemBridgeService.
 *
 * Validates the per-tick behaviour:
 *   - pending queue items → exactly one drain WI per vault
 *   - migration scan with proposedPages > 0 → one migrate WI per project root
 *   - dedupe: re-running with a non-terminal WI in the pool is a no-op
 *   - terminal-status WIs (done / failed / cancelled / verified) DO NOT
 *     block a fresh WI from being created (new pending items can land)
 *   - empty queues / no legacy → no WIs created
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  WikiWorkItemBridgeService,
  META_KIND_WIKI_DRAIN,
  META_KIND_WIKI_MIGRATE,
  META_KIND_WIKI_CLEANUP,
  describeVaultScope,
} from './wiki-workitem-bridge.service.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { WikiQueueItem } from './wiki-queue.service.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pendingItem(vaultPath: string, idx: number): WikiQueueItem {
  return {
    id: `q-${idx}`,
    vaultPath,
    queuedAt: new Date(Date.now() - idx * 60_000).toISOString(),
    queuedBy: 'agent-x',
    sourceType: 'user_chat',
    sourceRef: `msg-${idx}`,
    content: `content ${idx}`,
    reason: 'worth saving',
    status: 'pending',
  };
}

function poolItem(overrides: Partial<WorkItem> & { metadata?: Record<string, unknown> }): WorkItem {
  return {
    id: overrides.id ?? `wi-${Math.random()}`,
    type: 'delegate',
    owner: 'orchestrator',
    title: 'unused',
    status: (overrides.status ?? 'queued') as WorkItemStatus,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  } as WorkItem;
}

function makeBridge(opts: {
  vaults?: string[];
  projects?: string[];
  pending?: WikiQueueItem[];
  pool?: WorkItem[];
  migrateScan?: (input: { projectRoot: string }) => Promise<unknown>;
  cleanupScan?: (input: { vaultPath: string }) => Promise<unknown>;
  maxCreatesPerTick?: number;
  cooldownMs?: number;
  now?: () => number;
  /** Set to a path to enable persistence; default null disables filesystem IO. */
  statePath?: string | null;
}) {
  const addedItems: WorkItem[] = [];
  const queueService = {
    list: jest.fn(async ({ vaultPath }: { vaultPath?: string }) => {
      return (opts.pending ?? []).filter((p) => !vaultPath || p.vaultPath === vaultPath);
    }),
  } as unknown as import('./wiki-queue.service.js').WikiQueueService;

  const migrateService = {
    scan: jest.fn(opts.migrateScan ?? (async () => ({ ok: true, legacyDetected: false, proposedPages: [] }))),
  } as unknown as import('./wiki-migrate.service.js').WikiMigrateService;

  const cleanupService = {
    scan: jest.fn(opts.cleanupScan ?? (async () => ({ ok: true, candidates: [], scannedCount: 0, truncated: false, summary: { lowConfidence: 0, agentMemoryDump: 0, perAgentCapped: 0 } }))),
  } as unknown as import('./wiki-cleanup.service.js').WikiCleanupService;

  // Mirror production behaviour: items added via `addToPool` show up in
  // subsequent `getAllItems` reads, so the bridge's inflight dedupe sees
  // them. Without this, tick 2 doesn't observe tick 1's additions.
  const pool = {
    getAllItems: jest.fn(async () => [...(opts.pool ?? []), ...addedItems]),
    addToPool: jest.fn(async (wi: WorkItem) => {
      addedItems.push(wi);
    }),
  } as unknown as import('../task-pool/task-pool.service.js').TaskPoolService;

  const bridge = new WikiWorkItemBridgeService({
    intervalMs: 60_000,
    targetAgent: 'crewly-orc',
    maxCreatesPerTick: opts.maxCreatesPerTick ?? 100,
    // Default test cooldown to 0 so existing cases don't accidentally
    // hit the cooldown skip. Cases that exercise the cooldown override
    // explicitly.
    cooldownMs: opts.cooldownMs ?? 0,
    now: opts.now,
    // null = no filesystem IO. Tests that exercise persistence pass a
    // concrete tmpdir path explicitly.
    statePath: opts.statePath ?? null,
    discoverRoots: async () => opts.vaults ?? [],
    discoverProjectRoots: async () => opts.projects ?? [],
    queueService,
    migrateService,
    cleanupService,
    taskPool: pool,
  });

  return { bridge, addedItems, pool, queueService, migrateService, cleanupService };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikiWorkItemBridgeService', () => {
  describe('queue drains', () => {
    it('creates one drain WI per vault with pending items', async () => {
      const vaultA = '/home/x/.crewly/global-wiki';
      const vaultB = '/home/x/proj/.crewly/wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vaultA, vaultB],
        pending: [
          pendingItem(vaultA, 1),
          pendingItem(vaultA, 2),
          pendingItem(vaultB, 1),
        ],
      });

      const result = await bridge.tick();

      expect(result.createdForVault).toEqual(expect.arrayContaining([vaultA, vaultB]));
      expect(addedItems).toHaveLength(2);
      const drainWIs = addedItems.filter(
        (w) => (w.metadata as { kind?: string })?.kind === META_KIND_WIKI_DRAIN,
      );
      expect(drainWIs).toHaveLength(2);
      const vaultsCreated = new Set(
        drainWIs.map((w) => (w.metadata as { vaultPath: string }).vaultPath),
      );
      expect(vaultsCreated).toEqual(new Set([vaultA, vaultB]));
      // pendingCount carries the right count per vault for UX.
      const aWi = drainWIs.find((w) => (w.metadata as { vaultPath: string }).vaultPath === vaultA);
      expect((aWi?.metadata as { pendingCount: number }).pendingCount).toBe(2);
    });

    it('skips vaults that have NO pending items', async () => {
      const vault = '/home/x/.crewly/global-wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [], // queue empty
      });

      const result = await bridge.tick();

      expect(result.scannedVaults).toEqual([vault]);
      expect(result.createdForVault).toEqual([]);
      expect(addedItems).toHaveLength(0);
    });

    it('does not duplicate when a non-terminal drain WI already exists for the vault', async () => {
      const vault = '/home/x/.crewly/global-wiki';
      const existing = poolItem({
        status: 'queued',
        metadata: { kind: META_KIND_WIKI_DRAIN, vaultPath: vault },
      });
      const { bridge, addedItems, queueService } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        pool: [existing],
      });

      const result = await bridge.tick();

      expect(result.skippedInflightVaults).toEqual([vault]);
      expect(addedItems).toHaveLength(0);
      // Importantly, we don't even bother listing the queue for an
      // already-in-flight vault — the work is already represented.
      expect(queueService.list).not.toHaveBeenCalled();
    });

    it('CREATES a fresh drain WI when the prior one for the vault is terminal', async () => {
      const vault = '/home/x/.crewly/global-wiki';
      // Two prior WIs, both terminal — neither blocks a new one.
      const done = poolItem({
        status: 'done',
        metadata: { kind: META_KIND_WIKI_DRAIN, vaultPath: vault },
      });
      const failed = poolItem({
        status: 'failed',
        metadata: { kind: META_KIND_WIKI_DRAIN, vaultPath: vault },
      });
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        pool: [done, failed],
      });

      const result = await bridge.tick();

      expect(result.createdForVault).toEqual([vault]);
      expect(addedItems).toHaveLength(1);
    });
  });

  describe('migrations', () => {
    it('creates a migrate WI when the scan reports proposed > 0', async () => {
      const projectRoot = '/Users/me/projects/closie';
      const { bridge, addedItems } = makeBridge({
        projects: [projectRoot],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [
            { sourceId: 's1', targetRelativePath: 'a.md' },
            { sourceId: 's2', targetRelativePath: 'b.md' },
          ],
        }),
      });

      const result = await bridge.tick();

      expect(result.createdForProject).toEqual([projectRoot]);
      expect(addedItems).toHaveLength(1);
      const meta = addedItems[0].metadata as { kind?: string; projectRoot?: string; proposedCount?: number };
      expect(meta.kind).toBe(META_KIND_WIKI_MIGRATE);
      expect(meta.projectRoot).toBe(projectRoot);
      expect(meta.proposedCount).toBe(2);
    });

    it('skips when scan reports no legacy / zero proposed pages', async () => {
      const projectRoot = '/Users/me/projects/quiet-project';
      const { bridge, addedItems } = makeBridge({
        projects: [projectRoot],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [], // detected but everything already migrated
        }),
      });

      await bridge.tick();
      expect(addedItems).toHaveLength(0);
    });

    it('skips when every proposed page is already migrated (no net-new) — churn-loop guard', async () => {
      // Regression: a fully-migrated vault keeps already-migrated entries in
      // proposedPages (tagged skipReason 'already migrated'). The gate must count
      // net-new only, otherwise the bridge re-creates a no-op migrate WI every
      // cooldown. The third entry uses an apply-only reason (write_failed) to
      // assert the gate excludes ANY skipReason, not just 'already migrated' —
      // even though a real scan never emits write_failed (apply-phase only).
      const projectRoot = '/Users/me/projects/fully-migrated';
      const { bridge, addedItems } = makeBridge({
        projects: [projectRoot],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [
            { sourceId: 's1', targetRelativePath: 'a.md', skipReason: 'already migrated' },
            { sourceId: 's2', targetRelativePath: 'b.md', skipReason: 'already migrated' },
            { sourceId: 's3', targetRelativePath: 'c.md', skipReason: 'write_failed: x' },
          ],
        }),
      });

      const result = await bridge.tick();
      expect(result.createdForProject).toEqual([]);
      expect(addedItems).toHaveLength(0);
    });

    it('counts only net-new pages (ignores already-migrated) in proposedCount', async () => {
      const projectRoot = '/Users/me/projects/partly-migrated';
      const { bridge, addedItems } = makeBridge({
        projects: [projectRoot],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [
            { sourceId: 's1', targetRelativePath: 'a.md' }, // net-new
            { sourceId: 's2', targetRelativePath: 'b.md', skipReason: 'already migrated' },
            { sourceId: 's3', targetRelativePath: 'c.md', skipReason: 'already migrated' },
          ],
        }),
      });

      const result = await bridge.tick();
      expect(result.createdForProject).toEqual([projectRoot]);
      expect(addedItems).toHaveLength(1);
      const meta = addedItems[0].metadata as { proposedCount?: number };
      expect(meta.proposedCount).toBe(1);
    });

    it('skips when an in-flight migrate WI exists for the project', async () => {
      const projectRoot = '/Users/me/projects/closie';
      const inflight = poolItem({
        status: 'running',
        metadata: { kind: META_KIND_WIKI_MIGRATE, projectRoot },
      });
      const { bridge, addedItems, migrateService } = makeBridge({
        projects: [projectRoot],
        pool: [inflight],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [{ sourceId: 's1', targetRelativePath: 'a.md' }],
        }),
      });

      const result = await bridge.tick();

      expect(result.skippedInflightProjects).toEqual([projectRoot]);
      expect(addedItems).toHaveLength(0);
      // Don't even invoke the (potentially expensive) migrate scan when
      // a WI is already in flight for that project.
      expect(migrateService.scan).not.toHaveBeenCalled();
    });
  });

  describe('targeting + metadata', () => {
    it('targets the configured agent for both kinds', async () => {
      const vault = '/home/x/.crewly/global-wiki';
      const projectRoot = '/Users/me/projects/closie';
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        projects: [projectRoot],
        pending: [pendingItem(vault, 1)],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [{ sourceId: 's1', targetRelativePath: 'a.md' }],
        }),
      });

      await bridge.tick();

      expect(addedItems).toHaveLength(2);
      for (const wi of addedItems) {
        expect(wi.target).toBe('crewly-orc');
        expect(wi.owner).toBe('orchestrator');
        expect(wi.type).toBe('delegate');
        expect((wi.metadata as { autoCreated?: boolean }).autoCreated).toBe(true);
      }
    });
  });

  describe('throttle', () => {
    it('publishes at most maxCreatesPerTick WIs per tick and defers the rest', async () => {
      // Reproduces 2026-05-27 incident: 11 WIs in 0.97s overloaded ORC's
      // PTY paste buffer. Throttle keeps a single tick to N creates so the
      // worker can actually process them.
      const vA = '/h/x/.crewly/global-wiki';
      const vB = '/h/x/proj/.crewly/wiki';
      const vC = '/h/x/.crewly/teams/t1/wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vA, vB, vC],
        pending: [pendingItem(vA, 1), pendingItem(vB, 1), pendingItem(vC, 1)],
        maxCreatesPerTick: 2,
      });

      const result = await bridge.tick();

      expect(addedItems).toHaveLength(2);
      expect(result.createdForVault).toHaveLength(2);
      expect(result.deferredByThrottle).toHaveLength(1);
      // The deferred vault must be one of the three discovered.
      expect([vA, vB, vC]).toContain(result.deferredByThrottle[0]);
    });

    it('continues progress across ticks (deferred items get picked up next time)', async () => {
      const vA = '/h/x/.crewly/global-wiki';
      const vB = '/h/x/proj/.crewly/wiki';
      const vC = '/h/x/.crewly/teams/t1/wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vA, vB, vC],
        pending: [pendingItem(vA, 1), pendingItem(vB, 1), pendingItem(vC, 1)],
        maxCreatesPerTick: 2,
      });

      // First tick: 2 created (still queued), 1 deferred by throttle.
      await bridge.tick();
      expect(addedItems).toHaveLength(2);

      // Second tick: the two created WIs are still non-terminal so dedupe
      // skips their vaults; only the previously-deferred vault is eligible.
      // With budget=2 it's still well within the cap → exactly 1 created.
      const result2 = await bridge.tick();
      expect(result2.createdForVault).toHaveLength(1);
      expect(addedItems).toHaveLength(3);
      // And the third tick is a no-op because every vault is now inflight.
      const result3 = await bridge.tick();
      expect(result3.createdForVault).toHaveLength(0);
    });

    it('counts drains AND migrates against the same per-tick budget', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const projectRoot = '/Users/me/p1';
      const { bridge, addedItems, migrateService } = makeBridge({
        vaults: [vault],
        projects: [projectRoot],
        pending: [pendingItem(vault, 1)],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [{ sourceId: 's1', targetRelativePath: 'a.md' }],
        }),
        maxCreatesPerTick: 1,
      });

      const result = await bridge.tick();
      // budget=1 → only the drain creates; migrate is deferred.
      expect(addedItems).toHaveLength(1);
      expect(addedItems[0].metadata).toMatchObject({ kind: META_KIND_WIKI_DRAIN });
      expect(result.deferredByThrottle).toContain(projectRoot);
      // Migrate scan was still invoked (we don't currently early-exit on
      // budget exhaustion for migrate; if we did, this would flip to
      // `not.toHaveBeenCalled` — but the work is cheap and the result
      // surfaces in `deferredByThrottle` either way).
      expect(migrateService.scan).toHaveBeenCalled();
    });
  });

  describe('cooldown (loop-breaker)', () => {
    it('refuses to re-create within the cooldown window even after pool delete', async () => {
      // Reproduces 2026-05-27 22:46:49: ORC's PTY-flood recovery
      // force-deletes wiki WIs to clear its inbox; the next tick saw
      // them gone, re-created → cycle. Cooldown blocks the second
      // create until the window elapses.
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_000_000 };
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 30 * 60 * 1000,
        now: () => clock.t,
      });

      const r1 = await bridge.tick();
      expect(r1.createdForVault).toEqual([vault]);
      expect(addedItems).toHaveLength(1);

      // Simulate ORC's force-delete by clearing the pool snapshot.
      addedItems.splice(0, addedItems.length);

      // Advance only 5 min — still inside the cooldown.
      clock.t += 5 * 60 * 1000;
      const r2 = await bridge.tick();
      expect(r2.createdForVault).toEqual([]);
      expect(r2.skippedByCooldown).toEqual([vault]);
      expect(addedItems).toHaveLength(0);
    });

    it('allows re-create once the cooldown elapses', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_000_000 };
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 10 * 60 * 1000,
        now: () => clock.t,
      });

      await bridge.tick();
      expect(addedItems).toHaveLength(1);

      // Force-delete (simulate ORC cleanup).
      addedItems.splice(0, addedItems.length);

      // Advance past cooldown.
      clock.t += 11 * 60 * 1000;
      const r2 = await bridge.tick();
      expect(r2.createdForVault).toEqual([vault]);
      expect(addedItems).toHaveLength(1);
    });

    it('applies cooldown independently per (kind, key)', async () => {
      // Cooling down vault A must not block creating for project P or
      // for a different vault.
      const vaultA = '/h/x/.crewly/global-wiki';
      const vaultB = '/h/x/proj/.crewly/wiki';
      const projectRoot = '/Users/me/p1';
      const clock = { t: 1_000_000 };
      const { bridge, addedItems } = makeBridge({
        vaults: [vaultA, vaultB],
        projects: [projectRoot],
        pending: [pendingItem(vaultA, 1), pendingItem(vaultB, 1)],
        migrateScan: async () => ({
          ok: true,
          legacyDetected: true,
          proposedPages: [{ sourceId: 's1', targetRelativePath: 'a.md' }],
        }),
        cooldownMs: 30 * 60 * 1000,
        maxCreatesPerTick: 10,
        now: () => clock.t,
      });

      // Tick 1: vaultA + vaultB + project all created.
      await bridge.tick();
      expect(addedItems).toHaveLength(3);

      // Force-delete vaultA WI only.
      const idxA = addedItems.findIndex(
        (w) => (w.metadata as { vaultPath?: string }).vaultPath === vaultA,
      );
      addedItems.splice(idxA, 1);
      // Tick 2 right after — vaultA cooldown blocks, vaultB + project still
      // dedupe via pool. Net: zero creates.
      const r2 = await bridge.tick();
      expect(r2.createdForVault).toEqual([]);
      expect(r2.createdForProject).toEqual([]);
      expect(r2.skippedByCooldown).toContain(vaultA);
    });
  });

  describe('cleanup WIs', () => {
    function manyCandidates(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        relPath: `llm-curated/patterns/x${i}.md`,
        reasons: ['confidence 0.3 < 0.5'],
        confidence: 0.3,
        originalAuthor: 'alice',
        migratedFrom: null,
        originalId: `id-${i}`,
        bytes: 800,
      }));
    }

    it('creates a chunked cleanup WI when the vault has enough candidates', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        // 25 candidates, default chunk size = 10 → 1 WI per tick (10 in it).
        cleanupScan: async () => ({ ok: true, candidates: manyCandidates(25), scannedCount: 26, truncated: false, summary: { lowConfidence: 25, agentMemoryDump: 0, perAgentCapped: 0 } }),
      });

      const result = await bridge.tick();
      const cleanupWIs = addedItems.filter(
        (w) => (w.metadata as { kind?: string })?.kind === META_KIND_WIKI_CLEANUP,
      );
      expect(cleanupWIs).toHaveLength(1);
      expect(result.createdCleanupForVault).toEqual([vault]);

      const meta = cleanupWIs[0].metadata as {
        chunkSize: number;
        totalCandidates: number;
        candidates: Array<{ relPath: string }>;
        vaultPath: string;
      };
      expect(meta.chunkSize).toBe(10);
      expect(meta.totalCandidates).toBe(25);
      expect(meta.candidates).toHaveLength(10);
      expect(meta.vaultPath).toBe(vault);
    });

    it('does NOT create a cleanup WI when candidate count is below the minimum', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        cleanupScan: async () => ({ ok: true, candidates: manyCandidates(5), scannedCount: 6, truncated: false, summary: { lowConfidence: 5, agentMemoryDump: 0, perAgentCapped: 0 } }),
      });

      const result = await bridge.tick();
      const cleanupWIs = addedItems.filter(
        (w) => (w.metadata as { kind?: string })?.kind === META_KIND_WIKI_CLEANUP,
      );
      expect(cleanupWIs).toHaveLength(0);
      expect(result.createdCleanupForVault).toEqual([]);
    });

    it('skips when a non-terminal cleanup WI is already in flight for the vault', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const existing = poolItem({
        status: 'queued',
        metadata: { kind: META_KIND_WIKI_CLEANUP, vaultPath: vault },
      });
      const { bridge, addedItems, cleanupService } = makeBridge({
        vaults: [vault],
        pool: [existing],
        cleanupScan: async () => ({ ok: true, candidates: manyCandidates(50), scannedCount: 51, truncated: false, summary: { lowConfidence: 50, agentMemoryDump: 0, perAgentCapped: 0 } }),
      });

      await bridge.tick();
      expect(addedItems).toHaveLength(0);
      // Inflight skip happens before the scan — saves the read.
      expect(cleanupService.scan).not.toHaveBeenCalled();
    });

    it('cleanup cooldown works independently of drain/migrate cooldowns', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_000_000 };
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        cleanupScan: async () => ({ ok: true, candidates: manyCandidates(25), scannedCount: 26, truncated: false, summary: { lowConfidence: 25, agentMemoryDump: 0, perAgentCapped: 0 } }),
        cooldownMs: 30 * 60 * 1000,
        now: () => clock.t,
      });

      await bridge.tick();
      expect(addedItems).toHaveLength(1);
      // Simulate ORC force-delete (clear addedItems → next inflight scan sees nothing).
      addedItems.splice(0, addedItems.length);

      // Re-tick before cooldown elapses → cleanup is skippedByCooldown.
      clock.t += 5 * 60 * 1000;
      const r2 = await bridge.tick();
      expect(addedItems).toHaveLength(0);
      expect(r2.skippedByCooldown).toContain(`cleanup:${vault}`);
    });
  });

  describe('persisted cooldown (survives restart)', () => {
    let tmpDir: string;
    let statePath: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-bridge-state-'));
      statePath = path.join(tmpDir, 'state.json');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('persists lastCreatedAt to disk after a tick', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_700_000_000_000 };
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 30 * 60 * 1000,
        now: () => clock.t,
        statePath,
      });

      await bridge.tick();
      expect(addedItems).toHaveLength(1);

      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      const key = `${META_KIND_WIKI_DRAIN}:${vault}`;
      expect(parsed.lastCreatedAt[key]).toBe(clock.t);
    });

    it('reloads cooldown from disk on next instance, blocks immediate re-create', async () => {
      // Reproduces the 2026-05-27 restart-defeats-cancel pattern: an
      // operator cancels a WI, restarts OSS, and the bridge's in-memory
      // cooldown is empty → re-creates the cancelled WI within seconds.
      // Persistence breaks that loop.
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_700_000_000_000 };

      // First bridge instance — creates and persists.
      const first = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 30 * 60 * 1000,
        now: () => clock.t,
        statePath,
      });
      await first.bridge.tick();
      expect(first.addedItems).toHaveLength(1);

      // Simulate operator cancel: the WI is removed from the pool. Then
      // "restart" by building a fresh bridge against the same state file.
      // (Pool starts empty — the cancelled WI is gone.)
      clock.t += 60_000; // 1 min later
      const second = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 30 * 60 * 1000,
        now: () => clock.t,
        statePath,
      });
      const result = await second.bridge.tick();

      // Without persistence this would create a duplicate. With it, the
      // restored cooldown blocks the create.
      expect(result.skippedByCooldown).toEqual([vault]);
      expect(second.addedItems).toHaveLength(0);
    });

    it('does not reload entries whose cooldown has already expired', async () => {
      const vault = '/h/x/.crewly/global-wiki';
      const clock = { t: 1_700_000_000_000 };

      // Tick 1 at t0 with cooldown=10min.
      const first = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 10 * 60 * 1000,
        now: () => clock.t,
        statePath,
      });
      await first.bridge.tick();
      expect(first.addedItems).toHaveLength(1);

      // Jump past cooldown (11 min). Second instance must NOT honour the
      // expired entry — it should create freely.
      clock.t += 11 * 60 * 1000;
      const second = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 10 * 60 * 1000,
        now: () => clock.t,
        statePath,
      });
      const result = await second.bridge.tick();
      expect(result.createdForVault).toEqual([vault]);
      expect(second.addedItems).toHaveLength(1);
    });

    it('gracefully starts fresh when the state file is corrupt', async () => {
      // safeReadJson + version-check guard against operator-edited or
      // truncated state files. The bridge must never refuse to boot.
      await fs.writeFile(statePath, '{not valid json', 'utf8');
      const vault = '/h/x/.crewly/global-wiki';
      const { bridge, addedItems } = makeBridge({
        vaults: [vault],
        pending: [pendingItem(vault, 1)],
        cooldownMs: 30 * 60 * 1000,
        statePath,
      });
      await bridge.tick();
      expect(addedItems).toHaveLength(1);
    });
  });

  describe('describeVaultScope', () => {
    it('labels global / team / project vaults', () => {
      expect(describeVaultScope('/Users/me/.crewly/global-wiki')).toBe('global');
      const team = `${process.env['HOME'] ?? '/Users/me'}/.crewly/teams/team-abc-123/wiki`;
      expect(describeVaultScope(team)).toMatch(/^team /);
      expect(describeVaultScope('/Users/me/projects/closie/.crewly/wiki')).toBe('project closie');
    });
  });
});
