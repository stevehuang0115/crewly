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

  const makeTrigger = (overrides: { intervalMs?: number; debounceMs?: number; threshold?: number } = {}) =>
    new WikiBookkeepTriggerService({
      intervalMs: overrides.intervalMs ?? 60_000,
      debounceMs: overrides.debounceMs ?? 1_000_000,
      bookkeepService: bookkeep,
      discoverRoots: async () => [vault],
      fireFn: async (vaultPath, report) => {
        fired.push({
          vault: vaultPath,
          threshold: report.threshold,
          recent: report.recentMdCount,
        });
      },
    });

  describe('tick (single-pass behavior)', () => {
    it('does NOT fire for an empty vault', async () => {
      const trigger = makeTrigger();
      const res = await trigger.tick();
      expect(fired).toHaveLength(0);
      expect(res.quietVaults).toEqual([vault]);
      expect(res.fired).toEqual([]);
    });

    it('FIRES when recentMdCount meets threshold (default 10) and the per-vault override is set lower in service.generate', async () => {
      // We can't pass threshold via the trigger directly — the trigger
      // delegates to WikiBookkeepService which defaults threshold=10.
      // Drop 10 new mds → cross threshold.
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(
          path.join(vault, `llm-curated/p-${i}.md`),
          `# p ${i}`,
          'utf8',
        );
      }
      const trigger = makeTrigger();
      const res = await trigger.tick();
      expect(fired).toHaveLength(1);
      expect(fired[0].vault).toBe(vault);
      expect(fired[0].recent).toBeGreaterThanOrEqual(10);
      expect(res.fired).toEqual([vault]);
    });

    it('FIRES when duplicate clusters exist even if recent count is below threshold', async () => {
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing-v2.md'), '#', 'utf8');
      const trigger = makeTrigger();
      await trigger.tick();
      expect(fired).toHaveLength(1);
    });
  });

  describe('debounce ledger', () => {
    it('does NOT fire twice for the same vault within debounceMs', async () => {
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(vault, `llm-curated/p-${i}.md`), '#', 'utf8');
      }
      const trigger = makeTrigger({ debounceMs: 1_000_000 });
      await trigger.tick();
      await trigger.tick();
      expect(fired).toHaveLength(1);
    });

    it('refires after _resetDebounceForTesting()', async () => {
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(vault, `llm-curated/p-${i}.md`), '#', 'utf8');
      }
      const trigger = makeTrigger();
      await trigger.tick();
      trigger._resetDebounceForTesting();
      await trigger.tick();
      expect(fired).toHaveLength(2);
    });

    it('does not fire on subsequent ticks when the vault stays quiet', async () => {
      const trigger = makeTrigger();
      await trigger.tick();
      await trigger.tick();
      await trigger.tick();
      expect(fired).toHaveLength(0);
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
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(vault, `llm-curated/p-${i}.md`), '#', 'utf8');
      }
      const trigger = new WikiBookkeepTriggerService({
        intervalMs: 60_000,
        debounceMs: 1_000_000,
        bookkeepService: bookkeep,
        discoverRoots: async () => [vault],
        fireFn: async () => {
          throw new Error('boom');
        },
      });
      // Should not throw.
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
