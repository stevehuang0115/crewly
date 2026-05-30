/**
 * Tests for WikiReflectTriggerService.
 *
 * Uses fake-time control + a stub queue service so we never hit disk.
 *
 * @module services/wiki/wiki-reflect-trigger.service.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
let fireFn: ReturnType<typeof vi.fn>;
let now = 0;

beforeEach(() => {
  now = Date.UTC(2026, 4, 24, 12, 0, 0); // fixed point in time
  fireFn = vi.fn();
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
    const fire1 = vi.fn();
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
    const fire2 = vi.fn();
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
