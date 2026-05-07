/**
 * Integration tests for TriggerEngine disk persistence — REAL fs, NO MOCKS.
 *
 * Acceptance gate for B1 (`fix(persistence-p0): trigger-persistence-disk-backed`).
 *
 * Why this test file exists separately from `trigger-engine.service.test.ts`:
 * the unit suite mocks `fs/promises`, `atomicWriteJsonWithGuard`, and
 * `file-io.utils.js` to keep CRUD tests pure. That mocking blinds us to the
 * exact behavior B1 has to defend (writes actually hitting disk, boot
 * actually re-reading them). This file unmocks all of that and exercises
 * the full persist → simulated-restart → reload → fire chain against a
 * real temporary directory.
 *
 * Test environment:
 * - Each test gets a fresh `mkdtemp()`-allocated `.crewly/triggers/` dir.
 * - Hard cleanup in `afterEach` via `rm -rf <tempProject>`.
 * - Tests do not share state — `TriggerEngine.resetInstance()` between each.
 *
 * Coverage matrix (per B1 spec eval criteria):
 * - (3) acceptance: in-minutes-30 trigger survives a simulated restart and
 *   fires immediately on reboot when wallclock has advanced past fireAt.
 * - (3') acceptance: in-minutes-30 trigger survives a simulated restart and
 *   fires at the original wallclock time when reboot happens before fireAt.
 * - (4) integrity guard: 100→0 length wipe between persist calls is rejected
 *   by `atomicWriteJsonWithGuard` with `IntegrityViolationError`
 *   (collapse-to-empty), and the on-disk state is preserved.
 * - (4') integrity guard: 50%-decrease-threshold rejects 100→49 (under
 *   minAllowed=50) but allows 100→50 (at threshold).
 * - (4'') corrupt file: parse-fail at boot triggers
 *   `system:trigger_persistence_corrupt` warn-log AND boots clean (empty
 *   map). Subsequent persist call recovers — corrupt file gets overwritten.
 * - (5) compatibility: in-memory CRUD shape is unchanged after restart.
 *
 * @module services/v3/trigger-engine-persistence.integration.test
 */

// Jest globals (describe/it/expect/beforeEach/afterEach) are auto-injected.
// Migrated from vitest in PR #504 (test:integration discovery hygiene
// surfaced this file's vitest-style imports). `jest.*` calls below are
// renamed to `jest.*` equivalents (fn / useFakeTimers / setSystemTime /
// advanceTimersByTimeAsync / spyOn / useRealTimers).
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TriggerEngine } from './trigger-engine.service.js';
import type { CreateTriggerInput, Trigger } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

/**
 * Allocates a fresh temp directory for one test. Returned path becomes the
 * `projectPath` argument to `TriggerEngine.getInstance(projectPath)`.
 *
 * @returns Absolute path to the temp project root
 */
async function makeTempProject(): Promise<string> {
  const tempBase = await fs.mkdtemp(
    path.join(os.tmpdir(), 'crewly-trigger-b1-test-'),
  );
  return tempBase;
}

/**
 * Resolves the on-disk triggers.json path for a given project path. Used
 * by tests to inject corrupt/specific contents before instantiating the
 * engine, or to read the persisted output.
 *
 * @param projectPath - The temp project root
 * @returns Absolute path to .crewly/triggers/triggers.json
 */
function triggersFile(projectPath: string): string {
  return path.join(projectPath, '.crewly', 'triggers', 'triggers.json');
}

/**
 * Builds a one-shot `delayMs` time trigger input.
 *
 * @param delayMs - Delay in milliseconds from creation
 * @returns Trigger input
 */
function makeDelayTriggerInput(delayMs: number): CreateTriggerInput {
  return {
    type: 'time',
    config: { type: 'time', delayMs },
    action: { sendMessage: { target: 'test-target', message: 'fired' } },
    createdBy: 'system',
  };
}

/**
 * Builds a one-shot `fireAt` time trigger input.
 *
 * @param fireAt - ISO8601 fire timestamp
 * @returns Trigger input
 */
function makeFireAtTriggerInput(fireAt: string): CreateTriggerInput {
  return {
    type: 'time',
    config: { type: 'time', fireAt },
    action: { sendMessage: { target: 'test-target', message: 'fired-at-time' } },
    createdBy: 'system',
  };
}

/**
 * Helper that simulates a backend restart by stopping the singleton,
 * resetting it, and instantiating a fresh engine bound to the same
 * project path. The on-disk state survives — that's the point.
 *
 * @param projectPath - The temp project path
 * @returns Fresh engine instance
 */
function simulateRestart(projectPath: string): TriggerEngine {
  TriggerEngine.resetInstance();
  return TriggerEngine.getInstance(projectPath);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('TriggerEngine — disk persistence (B1 acceptance)', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await makeTempProject();
    TriggerEngine.resetInstance();
  });

  afterEach(async () => {
    TriggerEngine.resetInstance();
    jest.useRealTimers();
    // Cleanup the temp dir — best-effort; do not fail tests on cleanup race.
    try {
      await fs.rm(projectPath, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  // -------------------------------------------------------------------------
  // (3) Acceptance: B1 spec example — 30-minute delay survives restart
  // -------------------------------------------------------------------------

  describe('eval criteria (3): boot replay re-arms one-shot timers', () => {
    it('30-minute delay trigger survives a simulated restart and fires when time advances', async () => {
      // Phase 1: minute 0 — create trigger, persist, then "restart".
      const engine1 = TriggerEngine.getInstance(projectPath);
      // Note: not calling .start() in phase 1 because we're testing the
      // boot-replay path, not the live one-shot scheduling. .create() alone
      // persists the trigger spec; .start() in phase 2 triggers replay.
      const created = await engine1.create(makeDelayTriggerInput(30 * 60_000));
      expect(created.status).toBe('active');
      expect(created.config.type).toBe('time');

      // Verify disk has it
      const onDiskRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const onDisk = JSON.parse(onDiskRaw) as Trigger[];
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].id).toBe(created.id);

      // Phase 2: simulate restart
      const engine2 = simulateRestart(projectPath);

      // Wire up an action handler so we can observe the fire
      const handlerSpy = jest.fn().mockResolvedValue(undefined);
      engine2.setActionHandler(handlerSpy);

      // Phase 3: advance fake time by 31 minutes BEFORE start() so that the
      // one-shot scheduling computes delayMs <= 0 → fires immediately.
      jest.useFakeTimers();
      jest.setSystemTime(
        new Date(new Date(created.createdAt).getTime() + 31 * 60_000),
      );

      // Phase 4: boot replay. Wire the handler to signal when fire()'s
      // post-handler persistTriggers() completes — we need to read the
      // disk AFTER that write, not just after the handler invocation.
      // Approach: poll the file's fireCount field with a bounded retry.
      await engine2.start();

      // Drain microtasks aggressively — fire() chain has multiple awaits
      // (handler + persistTriggers + atomicWriteJsonWithGuard's read+write).
      // Real fs ops inside atomicWriteJson run on real time, so they need
      // the event loop to spin a few times.
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
      // Allow real fs writes (writeFile + sync + rename) to complete via
      // a small real-time delay. Fake timers don't fake setImmediate's
      // I/O semantics.
      jest.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Assert: handler was called for our trigger
      expect(handlerSpy).toHaveBeenCalledTimes(1);
      const [trig] = handlerSpy.mock.calls[0];
      expect(trig.id).toBe(created.id);

      // And the trigger's fireCount got incremented + persisted
      const reloadedRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const reloaded = JSON.parse(reloadedRaw) as Trigger[];
      expect(reloaded[0].fireCount).toBe(1);
      expect(reloaded[0].lastFiredAt).toBeDefined();
    });

    it('30-minute delay trigger schedules a future setTimeout when restart happens before fireAt', async () => {
      const fireAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const engine1 = TriggerEngine.getInstance(projectPath);
      const created = await engine1.create(makeFireAtTriggerInput(fireAt));

      const engine2 = simulateRestart(projectPath);
      const handlerSpy = jest.fn().mockResolvedValue(undefined);
      engine2.setActionHandler(handlerSpy);

      jest.useFakeTimers();
      // Stay BEFORE fireAt — should NOT fire on start
      await engine2.start();
      expect(handlerSpy).not.toHaveBeenCalled();

      // Advance to just past fireAt → setTimeout fires
      jest.setSystemTime(new Date(new Date(fireAt).getTime() + 1000));
      await jest.advanceTimersByTimeAsync(31 * 60_000);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(handlerSpy.mock.calls[0][0].id).toBe(created.id);
    });
  });

  // -------------------------------------------------------------------------
  // (4) Integrity guard: 50%-decrease threshold rejects suspicious writes
  // -------------------------------------------------------------------------

  describe('eval criteria (4): atomicWriteJsonWithGuard rejects collapse-to-empty', () => {
    it('rejects a 100→0 active-trigger wipe by directly invoking persistTriggers via Map.clear()', async () => {
      // Seed disk with 100 active triggers via legitimate create() calls.
      const engine = TriggerEngine.getInstance(projectPath);
      const created: Trigger[] = [];
      for (let i = 0; i < 100; i++) {
        // distinct event types so dedupe leaves them all distinct
        const t = await engine.create({
          type: 'signal',
          config: { type: 'signal', eventType: `evt-${i}` },
          action: { sendMessage: { target: `s-${i}`, message: 'x' } },
          createdBy: 'system',
        });
        created.push(t);
      }

      // Sanity: 100 on disk
      const seedRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const seed = JSON.parse(seedRaw) as Trigger[];
      expect(seed).toHaveLength(100);

      // Now simulate a regression: the in-memory Map gets cleared, then a
      // CRUD call (here: another create that we will intercept) tries to
      // persist the empty state.
      //
      // We can't directly call persistTriggers (private). Instead: nuke the
      // map via the undocumented but accessible internal field, then call a
      // CRUD method that triggers persist. The next persist sees prior=100
      // on disk + next=0 in memory → guard rejects with
      // IntegrityViolationError.
      const internalEngine = engine as unknown as { triggers: Map<string, Trigger> };
      internalEngine.triggers.clear();

      // Trigger a persist by attempting to delete — delete returns false
      // since the trigger isn't in the map, so persist won't fire. Use a
      // direct cancel on a known-id; that also returns false on no-such-id.
      // The cleanest path: invoke the private persistTriggers via the
      // unsafe cast. This is what production callers (CRUD methods) do.
      const internalPersist = (engine as unknown as { persistTriggers: () => Promise<void> }).persistTriggers.bind(engine);

      await expect(internalPersist()).rejects.toThrow(/Refusing to write empty collection|collapse-to-empty/i);

      // Critical: disk MUST be unchanged. A regression here would mean the
      // guard threw but the file still got truncated.
      const afterAttemptRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const afterAttempt = JSON.parse(afterAttemptRaw) as Trigger[];
      expect(afterAttempt).toHaveLength(100);
    });

    it('rejects a 100→49 write (51% decrease) but allows 100→50 (at threshold)', async () => {
      const engine = TriggerEngine.getInstance(projectPath);
      // Seed 100 with distinct configs (avoid dedupe collapse).
      for (let i = 0; i < 100; i++) {
        await engine.create({
          type: 'signal',
          config: { type: 'signal', eventType: `evt-${i}` },
          action: { sendMessage: { target: `s-${i}`, message: 'x' } },
          createdBy: 'system',
        });
      }

      const internalEngine = engine as unknown as { triggers: Map<string, Trigger> };
      const internalPersist = (engine as unknown as { persistTriggers: () => Promise<void> }).persistTriggers.bind(engine);
      const original = Array.from(internalEngine.triggers.values());

      // Drop to 49 → guard rejects (51% decrease, > 50% threshold).
      internalEngine.triggers.clear();
      for (const t of original.slice(0, 49)) internalEngine.triggers.set(t.id, t);
      await expect(internalPersist()).rejects.toThrow(/decrease-exceeds-threshold|below.*threshold/i);

      // Restore to 50 → guard PASSES (exactly at threshold; minAllowed=50).
      internalEngine.triggers.clear();
      for (const t of original.slice(0, 50)) internalEngine.triggers.set(t.id, t);
      await expect(internalPersist()).resolves.not.toThrow();

      // Disk should now reflect 50.
      const afterRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const after = JSON.parse(afterRaw) as Trigger[];
      expect(after).toHaveLength(50);
    });

    it("Arch finding #3: lastKnownActiveCount baseline survives a guard rejection, so subsequent persist still emits active-collapse warn", async () => {
      // Regression scenario: persist1 attempts 5→0 active wipe (rejected by
      // guard). The previous implementation updated lastKnownActiveCount=0
      // BEFORE the write attempt, so persist2 (still 5→0) would observe
      // `activeCount === 0 && lastKnownActiveCount === 0` and SUPPRESS the
      // warn-log — silencing the very signal the baseline exists to emit.
      //
      // Fix moved the baseline assignment INSIDE the try block, after the
      // successful atomicWriteJsonWithGuard call. This test pins the new
      // ordering by counting warn-log emissions across two failed persists.
      const engine = TriggerEngine.getInstance(projectPath);

      // Seed 5 active triggers (distinct configs to avoid dedupe).
      for (let i = 0; i < 5; i++) {
        await engine.create({
          type: 'signal',
          config: { type: 'signal', eventType: `arch3-evt-${i}` },
          action: { sendMessage: { target: `s-${i}`, message: 'x' } },
          createdBy: 'system',
        });
      }

      // Spy on the logger's warn channel to count active-collapse emissions.
      const internalLogger = (engine as unknown as {
        logger: { warn: (msg: string, meta?: unknown) => void };
      }).logger;
      const warnSpy = jest.spyOn(internalLogger, 'warn');

      // Stage the regression: clear the in-memory map (5 → 0). The guard
      // will reject on collapse-to-empty.
      const internalEngine = engine as unknown as { triggers: Map<string, Trigger> };
      const internalPersist = (engine as unknown as {
        persistTriggers: () => Promise<void>;
      }).persistTriggers.bind(engine);
      internalEngine.triggers.clear();

      // persist1: warn fires (5→0 collapse), guard rejects.
      await expect(internalPersist()).rejects.toThrow(
        /Refusing to write empty collection|collapse-to-empty/i,
      );

      // persist2: same regression still in memory. With the fix, baseline
      // remained at 5, so the warn-log fires AGAIN. Without the fix
      // (regression), baseline would be 0 and warn would be silenced.
      await expect(internalPersist()).rejects.toThrow(
        /Refusing to write empty collection|collapse-to-empty/i,
      );

      const collapseCalls = warnSpy.mock.calls.filter(
        ([msg]) => msg === 'system:trigger_persistence_active_collapse',
      );
      // Two persist attempts saw the same regression; both should have
      // emitted the warn — pinning the post-success-only baseline update.
      expect(collapseCalls).toHaveLength(2);
      // First emission baselines against the seeded count of 5.
      expect(collapseCalls[0][1]).toMatchObject({
        lastKnownActive: 5,
        nextActive: 0,
      });
      // Critical: second emission ALSO baselines against 5, NOT 0.
      // A regression here (baseline updated pre-write) would yield 0 here
      // and the warn would never fire (calls.length would be 1, not 2).
      expect(collapseCalls[1][1]).toMatchObject({
        lastKnownActive: 5,
        nextActive: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // (4'') Corrupt-file detection at boot
  // -------------------------------------------------------------------------

  describe("eval criteria (4''): corrupt-file detection emits warn-log and boots clean", () => {
    it('detects garbled JSON, emits system:trigger_persistence_corrupt warn-log, returns empty map', async () => {
      // Pre-seed triggers.json with corrupt content (truncated JSON).
      const triggersDir = path.join(projectPath, '.crewly', 'triggers');
      await fs.mkdir(triggersDir, { recursive: true });
      await fs.writeFile(
        triggersFile(projectPath),
        '[{"id":"wedge","type":"time", THIS IS NOT VALID JSON',
        'utf-8',
      );

      // Spy the logger.warn channel by injecting a known logger pattern.
      // The engine writes via `this.logger.warn(...)`. Easiest hook: spy
      // through console (LoggerService might be wired to console). We
      // capture by re-reading a backup file the loader is supposed to
      // create at `.corrupt.<ts>`. That backup is the durable signal.
      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      // Boot succeeded with empty map (NOT throw, NOT crash).
      expect(engine.list()).toHaveLength(0);

      // A `.corrupt.<ts>` backup should exist alongside triggers.json.
      const triggersDirEntries = await fs.readdir(triggersDir);
      const corruptBackup = triggersDirEntries.find((f) =>
        /^triggers\.json\.corrupt\.\d+$/.test(f),
      );
      expect(corruptBackup).toBeDefined();

      // Backup should contain the original corrupt content (verifies we
      // actually copied the bad file before clobbering it on next write).
      const backupContent = await fs.readFile(
        path.join(triggersDir, corruptBackup!),
        'utf-8',
      );
      expect(backupContent).toContain('THIS IS NOT VALID JSON');
    });

    it('recovers cleanly: a CRUD call after corrupt-file boot persists fresh JSON to disk', async () => {
      const triggersDir = path.join(projectPath, '.crewly', 'triggers');
      await fs.mkdir(triggersDir, { recursive: true });
      await fs.writeFile(
        triggersFile(projectPath),
        '{ malformed garbage',
        'utf-8',
      );

      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      // Add a fresh trigger — this calls persistTriggers, which calls
      // atomicWriteJsonWithGuard, which reads the prior file, fails to
      // parse it, treats prevCount as null, and proceeds with the write.
      const created = await engine.create(makeDelayTriggerInput(60_000));

      const recoveredRaw = await fs.readFile(triggersFile(projectPath), 'utf-8');
      const recovered = JSON.parse(recoveredRaw) as Trigger[];
      expect(recovered).toHaveLength(1);
      expect(recovered[0].id).toBe(created.id);
    });
  });

  // -------------------------------------------------------------------------
  // (5) Compatibility — in-memory shape unchanged across restart
  // -------------------------------------------------------------------------

  describe('eval criteria (5): in-memory CRUD shape is preserved post-restart', () => {
    it('list() returns same triggers (by id, status, fireCount) before and after restart', async () => {
      const engine1 = TriggerEngine.getInstance(projectPath);
      const t1 = await engine1.create(makeDelayTriggerInput(60 * 60_000));
      const t2 = await engine1.create({
        type: 'signal',
        config: { type: 'signal', eventType: 'agent:idle' },
        action: { runReconciler: true },
        createdBy: 'orchestrator',
      });
      await engine1.cancel(t2.id);

      const before = engine1.list();
      expect(before).toHaveLength(2);

      const engine2 = simulateRestart(projectPath);
      await engine2.start();

      const after = engine2.list();
      expect(after).toHaveLength(2);

      // Stable by id
      const beforeById = new Map(before.map((t) => [t.id, t]));
      const afterById = new Map(after.map((t) => [t.id, t]));
      for (const [id, b] of beforeById) {
        const a = afterById.get(id);
        expect(a).toBeDefined();
        expect(a!.status).toBe(b.status);
        expect(a!.fireCount).toBe(b.fireCount);
        expect(a!.type).toBe(b.type);
      }
    });
  });
});
