/**
 * Tests for WikiReflectTriggerService.
 *
 * Uses fake-time control + a stub queue service so we never hit disk.
 * (Runs under jest; the file originally imported vitest and never executed.)
 *
 * @module services/wiki/wiki-reflect-trigger.service.test
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { WikiReflectTriggerService, WikiReflectFireMeta } from './wiki-reflect-trigger.service.js';
import type { WikiQueueService, WikiQueueItem } from './wiki-queue.service.js';
import type { WikiSourceType } from './wiki-ingest.service.js';

/**
 * Build a minimal fake `WikiQueueService` whose `list()` returns the
 * caller-supplied records. Only `list` is exercised; other methods throw.
 */
function makeFakeQueueService(items: WikiQueueItem[]): WikiQueueService {
  const fake = {
    async list(filter: { vaultPath?: string }): Promise<WikiQueueItem[]> {
      if (!filter.vaultPath) return items;
      return items.filter((i) => i.vaultPath === filter.vaultPath);
    },
  } as unknown as WikiQueueService;
  return fake;
}

function makeItem(vaultPath: string, queuedAt: string, id = 'item-' + queuedAt): WikiQueueItem {
  return {
    id,
    vaultPath,
    queuedAt,
    queuedBy: 'test',
    sourceType: 'user_chat' as WikiSourceType,
    sourceRef: 'ref',
    content: 'c',
    reason: 'r',
    status: 'pending',
  };
}

const VAULT_A = '/tmp/vault-a';
const VAULT_B = '/tmp/vault-b';

let trigger: WikiReflectTriggerService;
let fireFn: jest.Mock;
let now = 0;

beforeEach(() => {
  now = Date.UTC(2026, 4, 24, 12, 0, 0); // fixed point in time
  fireFn = jest.fn();
});

afterEach(() => {
  trigger?.stop();
});

describe('WikiReflectTriggerService.tick', () => {
  it('fires for a vault with zero queue items', async () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    const result = await trigger.tick();
    expect(result.fired).toEqual([VAULT_A]);
    expect(result.skippedByActivity).toEqual([]);
    expect(fireFn).toHaveBeenCalledTimes(1);
    const meta = fireFn.mock.calls[0][0] as WikiReflectFireMeta;
    expect(meta.vaultPath).toBe(VAULT_A);
    expect(meta.totalQueueItems).toBe(0);
    expect(meta.msSinceLastQueueAdd).toBe(Number.POSITIVE_INFINITY);
  });

  it('skips a vault that had a queue-add within the quiet window', async () => {
    const recent = new Date(now - 30 * 60 * 1000).toISOString(); // 30m ago
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      quietWindowMs: 4 * 60 * 60 * 1000,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([makeItem(VAULT_A, recent)]),
      now: () => now,
    });
    const result = await trigger.tick();
    expect(result.fired).toEqual([]);
    expect(result.skippedByActivity).toEqual([VAULT_A]);
    expect(fireFn).not.toHaveBeenCalled();
  });

  it('fires when the last queue-add is older than the quiet window', async () => {
    const old = new Date(now - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      quietWindowMs: 4 * 60 * 60 * 1000,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([makeItem(VAULT_A, old)]),
      now: () => now,
    });
    const result = await trigger.tick();
    expect(result.fired).toEqual([VAULT_A]);
    const meta = fireFn.mock.calls[0][0] as WikiReflectFireMeta;
    expect(meta.totalQueueItems).toBe(1);
    expect(Math.round(meta.msSinceLastQueueAdd / (60 * 60 * 1000))).toBe(5);
  });

  // 2026-09-16: each message to ORC is a full model turn; six vaults used
  // to cost six turns per reflect cycle. With batchFireFn the tick hands
  // every fired vault over in ONE call.
  it('batchFireFn receives every fired vault in a single call per tick', async () => {
    const batchFireFn = jest.fn();
    trigger = new WikiReflectTriggerService({
      statePath: null,
      batchFireFn,
      discoverRoots: async () => [VAULT_A, VAULT_B],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    const res = await trigger.tick();
    expect(res.fired).toEqual([VAULT_A, VAULT_B]);
    expect(batchFireFn).toHaveBeenCalledTimes(1);
    const metas = batchFireFn.mock.calls[0][0] as WikiReflectFireMeta[];
    expect(metas.map((m) => m.vaultPath)).toEqual([VAULT_A, VAULT_B]);
    // Nothing fired on the next tick (debounced) → batchFireFn not called again.
    await trigger.tick();
    expect(batchFireFn).toHaveBeenCalledTimes(1);
  });

  it('batchFireFn takes precedence over fireFn, and a throwing batchFireFn is swallowed', async () => {
    const batchFireFn = jest.fn(async () => {
      throw new Error('boom');
    });
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      batchFireFn,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    await expect(trigger.tick()).resolves.toMatchObject({ fired: [VAULT_A] });
    expect(batchFireFn).toHaveBeenCalledTimes(1);
    expect(fireFn).not.toHaveBeenCalled();
  });

  it('refuses construction without any notifier', () => {
    expect(
      () =>
        new WikiReflectTriggerService({
          statePath: null,
          discoverRoots: async () => [],
          queueService: makeFakeQueueService([]),
        }),
    ).toThrow(/fireFn or batchFireFn/);
  });

  it('tick({ ignoreDebounce: true }) fires even within the debounce window (manual trigger-now)', async () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      debounceMs: 4 * 60 * 60 * 1000,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    await trigger.tick(); // fire 1, sets lastFiredAt
    expect(fireFn).toHaveBeenCalledTimes(1);
    // Only 1h later — inside debounce — but ignoreDebounce forces it.
    now += 60 * 60 * 1000;
    const res = await trigger.tick({ ignoreDebounce: true });
    expect(res.fired).toEqual([VAULT_A]);
    expect(res.skippedByDebounce).toEqual([]);
    expect(fireFn).toHaveBeenCalledTimes(2);
  });

  it('debounces — does not refire within the debounce window', async () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      debounceMs: 4 * 60 * 60 * 1000,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    await trigger.tick();
    expect(fireFn).toHaveBeenCalledTimes(1);

    // Advance only 1h — still inside debounce.
    now += 60 * 60 * 1000;
    const result = await trigger.tick();
    expect(result.fired).toEqual([]);
    expect(result.skippedByDebounce).toEqual([VAULT_A]);
    expect(fireFn).toHaveBeenCalledTimes(1);
  });

  it('refires after the debounce window elapses', async () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      debounceMs: 4 * 60 * 60 * 1000,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    await trigger.tick();
    now += 5 * 60 * 60 * 1000;
    const result = await trigger.tick();
    expect(result.fired).toEqual([VAULT_A]);
    expect(fireFn).toHaveBeenCalledTimes(2);
  });

  it('scans multiple vaults independently', async () => {
    const recent = new Date(now - 10 * 60 * 1000).toISOString(); // 10m ago in vault B
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      discoverRoots: async () => [VAULT_A, VAULT_B],
      queueService: makeFakeQueueService([makeItem(VAULT_B, recent)]),
      now: () => now,
    });
    const result = await trigger.tick();
    expect(result.fired).toEqual([VAULT_A]);
    expect(result.skippedByActivity).toEqual([VAULT_B]);
  });

  it('swallows fireFn errors so one bad notifier does not stop the scan', async () => {
    fireFn.mockImplementationOnce(() => {
      throw new Error('fireFn boom');
    });
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      discoverRoots: async () => [VAULT_A, VAULT_B],
      queueService: makeFakeQueueService([]),
      now: () => now,
    });
    const result = await trigger.tick();
    // VAULT_A's fire threw, but the scan continued to VAULT_B.
    expect(fireFn).toHaveBeenCalledTimes(2);
    // Only VAULT_B successfully fired; VAULT_A is debounce-locked but not in `fired`.
    expect(result.fired).toEqual([VAULT_B]);
  });
});

describe('WikiReflectTriggerService lifecycle', () => {
  it('start/stop is idempotent', () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      intervalMs: 60_000,
      discoverRoots: async () => [],
      queueService: makeFakeQueueService([]),
    });
    trigger.start();
    trigger.start(); // no-op
    trigger.stop();
    trigger.stop(); // no-op
    expect(true).toBe(true);
  });

  it('setInstance + getInstance singleton wiring', () => {
    trigger = new WikiReflectTriggerService({
      statePath: null,
      fireFn,
      discoverRoots: async () => [],
      queueService: makeFakeQueueService([]),
    });
    WikiReflectTriggerService.setInstance(trigger);
    expect(WikiReflectTriggerService.getInstance()).toBe(trigger);
    WikiReflectTriggerService.setInstance(null);
    expect(WikiReflectTriggerService.getInstance()).toBeNull();
  });
});

describe('WikiReflectTriggerService persistence (survives restart)', () => {
  it('a new instance loads the debounce ledger and does not re-burst within the window', async () => {
    const t0 = Date.UTC(2026, 4, 24, 12, 0, 0);
    const statePath = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'crewly-reflect-state-')),
      'reflect-state.json',
    );
    const fire1 = jest.fn();
    const t1 = new WikiReflectTriggerService({
      statePath,
      debounceMs: 4 * 60 * 60 * 1000,
      fireFn: fire1,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => t0,
    });
    const r1 = await t1.tick();
    expect(r1.fired).toEqual([VAULT_A]);
    t1.stop();

    // Simulate a restart 1h later (still inside the 4h debounce): a brand-new
    // instance must read the persisted lastFiredAt and NOT re-fire.
    const fire2 = jest.fn();
    const t2 = new WikiReflectTriggerService({
      statePath,
      debounceMs: 4 * 60 * 60 * 1000,
      fireFn: fire2,
      discoverRoots: async () => [VAULT_A],
      queueService: makeFakeQueueService([]),
      now: () => t0 + 60 * 60 * 1000,
    });
    const r2 = await t2.tick();
    expect(r2.skippedByDebounce).toEqual([VAULT_A]);
    expect(fire2).not.toHaveBeenCalled();
    t2.stop();
  });
});
