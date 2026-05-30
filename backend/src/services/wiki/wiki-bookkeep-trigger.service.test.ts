/**
 * Tests for WikiBookkeepTriggerService.
 *
 * Each test stands up a tmp vault to control the bookkeep threshold,
 * passes a fake fireFn so we can assert "was the agent notified?", and
 * exercises the per-vault debounce ledger.
 *
 * @module services/wiki/wiki-bookkeep-trigger.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiQueueService } from './wiki-queue.service.js';
import { WikiBookkeepService } from './wiki-bookkeep.service.js';
import { WikiBookkeepTriggerService } from './wiki-bookkeep-trigger.service.js';

const SCHEMA = `
vault_scope: project
vault_id: crewly-test
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: []
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader]
  proposed_only: []
  schema_writer: [steve]
`;

describe('WikiBookkeepTriggerService', () => {
  let vault: string;
  let queueRoot: string;
  let bookkeep: WikiBookkeepService;
  let fired: Array<{ vault: string; threshold: number; recent: number }>;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-bookkeep-trigger-vault-'));
    queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-bookkeep-trigger-queue-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), SCHEMA, 'utf8');
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    bookkeep = new WikiBookkeepService(undefined, new WikiQueueService(queueRoot));
    fired = [];
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(queueRoot, { recursive: true, force: true });
    WikiBookkeepTriggerService.setInstance(null);
  });

  const makeTrigger = (overrides: { intervalMs?: number; debounceMs?: number; statePath?: string | null } = {}) =>
    new WikiBookkeepTriggerService({
      intervalMs: overrides.intervalMs ?? 60_000,
      debounceMs: overrides.debounceMs ?? 1_000_000,
      statePath: overrides.statePath ?? null,
      bookkeepService: bookkeep,
      discoverRoots: async () => [vault],
      fireFn: async (vaultPath, report) => {
        fired.push({
          vault: vaultPath,
          threshold: report.threshold,
          recent: report.netNewMdCount,
        });
      },
    });

  const writeMds = async (n: number, prefix = 'p') => {
    for (let i = 0; i < n; i++) {
      await fs.writeFile(path.join(vault, `llm-curated/${prefix}-${i}.md`), `# ${prefix} ${i}`, 'utf8');
    }
  };

  describe('tick (net-new baseline behavior)', () => {
    it('does NOT fire for an empty vault', async () => {
      const trigger = makeTrigger();
      const res = await trigger.tick();
      expect(fired).toHaveLength(0);
      expect(res.quietVaults).toEqual([vault]);
      expect(res.fired).toEqual([]);
    });

    it('first sight establishes a baseline and does NOT fire — even with a large backlog', async () => {
      // Mirrors a freshly-migrated vault: many files, all mtime-recent. The
      // old mtime-window logic would fire on the whole backlog; net-new does not.
      await writeMds(15);
      const trigger = makeTrigger();
      const res = await trigger.tick();
      expect(fired).toHaveLength(0);
      expect(res.quietVaults).toEqual([vault]);
    });

    it('FIRES when >= threshold NET-NEW mds are added after the baseline', async () => {
      const trigger = makeTrigger();
      await trigger.tick(); // establish baseline at 0
      expect(fired).toHaveLength(0);
      await writeMds(10); // 10 net-new (default threshold 10)
      const res = await trigger.tick();
      expect(res.fired).toEqual([vault]);
      expect(fired).toHaveLength(1);
      expect(fired[0].vault).toBe(vault);
      expect(fired[0].recent).toBeGreaterThanOrEqual(10); // netNewMdCount
    });

    it('does NOT fire on duplicate clusters alone (below net-new threshold)', async () => {
      const trigger = makeTrigger();
      await trigger.tick(); // baseline
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing-v2.md'), '#', 'utf8');
      await trigger.tick(); // 2 net-new < 10, duplicates present
      expect(fired).toHaveLength(0);
    });
  });

  describe('debounce + baseline advance', () => {
    it('does NOT refire until another threshold of net-new accumulates', async () => {
      const trigger = makeTrigger();
      await trigger.tick(); // baseline 0
      await writeMds(10);
      await trigger.tick(); // fire 1; baseline advances to 10
      expect(fired).toHaveLength(1);
      await trigger.tick(); // no new files → netNew 0
      expect(fired).toHaveLength(1);
    });

    it('debounces a second fire even when net-new is still >= threshold', async () => {
      const trigger = makeTrigger({ debounceMs: 1_000_000 });
      await trigger.tick(); // baseline 0
      await writeMds(10, 'a');
      await trigger.tick(); // fire 1; baseline → 10
      expect(fired).toHaveLength(1);
      // Add 10 MORE so net-new is again >= threshold, but stay inside debounce.
      await writeMds(10, 'b');
      const res = await trigger.tick();
      expect(res.skippedByDebounce).toEqual([vault]);
      expect(fired).toHaveLength(1);
    });

    it('does not fire on subsequent ticks when the vault stays quiet', async () => {
      const trigger = makeTrigger();
      await trigger.tick();
      await trigger.tick();
      await trigger.tick();
      expect(fired).toHaveLength(0);
    });
  });

  describe('persistence (survives restart)', () => {
    it('persists the baseline so a new instance does not re-fire the backlog', async () => {
      const statePath = path.join(queueRoot, 'bookkeep-state.json');
      await writeMds(15);
      const t1 = makeTrigger({ statePath });
      await t1.tick(); // baseline = 15, no fire
      expect(fired).toHaveLength(0);
      // Simulate a restart: a brand-new instance reading the same state file.
      const t2 = makeTrigger({ statePath });
      const res = await t2.tick();
      expect(fired).toHaveLength(0); // backlog already baselined — no burst
      expect(res.quietVaults).toEqual([vault]);
    });
  });

  describe('vault discovery override + error tolerance', () => {
    it('skips a vault whose bookkeep fails (no SCHEMA.md)', async () => {
      // Remove SCHEMA so generate returns schema_missing.
      await fs.unlink(path.join(vault, 'SCHEMA.md'));
      const trigger = makeTrigger();
      const res = await trigger.tick();
      expect(fired).toHaveLength(0);
      expect(res.scanned).toEqual([vault]);
      expect(res.fired).toEqual([]);
    });

    it('swallows fireFn errors so one bad vault does not break the scan', async () => {
      const trigger = new WikiBookkeepTriggerService({
        intervalMs: 60_000,
        debounceMs: 1_000_000,
        statePath: null,
        bookkeepService: bookkeep,
        discoverRoots: async () => [vault],
        fireFn: async () => {
          throw new Error('boom');
        },
      });
      await trigger.tick(); // establish baseline at 0
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(vault, `llm-curated/p-${i}.md`), '#', 'utf8');
      }
      // Net-new now crosses threshold → fireFn fires and throws; must not throw out.
      await expect(trigger.tick()).resolves.toBeDefined();
    });
  });

  describe('lifecycle (start/stop)', () => {
    it('start() is idempotent — only one timer registered', () => {
      const trigger = makeTrigger({ intervalMs: 1_000_000 });
      trigger.start();
      trigger.start(); // no-op
      trigger.stop();
    });

    it('stop() is safe before start()', () => {
      const trigger = makeTrigger();
      expect(() => trigger.stop()).not.toThrow();
    });

    it('singleton accessor setInstance(null) stops the previous instance', () => {
      const a = makeTrigger();
      WikiBookkeepTriggerService.setInstance(a);
      a.start();
      WikiBookkeepTriggerService.setInstance(null);
      // Setting null should have stopped a. Calling stop() again is safe.
      expect(() => a.stop()).not.toThrow();
    });
  });
});
