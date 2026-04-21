/**
 * Focused tests for TriggerEngine idempotency + startup dedup.
 *
 * The pre-existing `trigger-engine.service.test.ts` uses vitest imports and
 * doesn't run under this project's Jest setup. Rather than rewrite the whole
 * suite, we add a separate file for the dedup behaviour, which is small and
 * self-contained.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TriggerEngine } from './trigger-engine.service.js';
import type { Trigger } from '../../types/v2/trigger.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trig-engine-'));
  fs.mkdirSync(path.join(dir, '.crewly'), { recursive: true });
  return dir;
}

function seedTriggerFile(projectPath: string, triggers: Partial<Trigger>[]): void {
  const full: Trigger[] = triggers.map((t, i) => ({
    id: t.id ?? `seed-${i}`,
    type: 'time',
    config: t.config ?? { type: 'time', cronExpression: '*/5 * * * *' },
    action: t.action ?? { runReconciler: true },
    status: t.status ?? 'active',
    createdBy: t.createdBy ?? 'system',
    createdAt: t.createdAt ?? new Date(2026, 0, i + 1).toISOString(),
    fireCount: t.fireCount ?? 0,
    maxIdleFires: t.maxIdleFires ?? 3,
    consecutiveIdleFires: t.consecutiveIdleFires ?? 0,
    name: t.name,
    teamId: t.teamId,
  }));
  const dir = path.join(projectPath, '.crewly', 'triggers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'triggers.json'), JSON.stringify(full), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TriggerEngine idempotency + dedup', () => {
  let projectPath: string;

  beforeEach(() => {
    TriggerEngine.resetInstance();
    projectPath = makeProject();
  });

  afterEach(() => {
    TriggerEngine.resetInstance();
    try {
      fs.rmSync(projectPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // create() idempotency by (createdBy, name)
  // -------------------------------------------------------------------------

  describe('create() idempotency', () => {
    it('returns the existing trigger when called twice with the same name+createdBy', async () => {
      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const a = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '*/5 * * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        name: 'system:escalation',
      });

      const b = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '*/5 * * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        name: 'system:escalation',
      });

      expect(b.id).toBe(a.id);
      expect(engine.list().filter((t) => t.name === 'system:escalation')).toHaveLength(1);

      engine.stop();
    });

    it('allows distinct createdBy values to share a name', async () => {
      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const byUser = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'user',
        name: 'daily-check',
      });
      const bySystem = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        name: 'daily-check',
      });

      expect(byUser.id).not.toBe(bySystem.id);
      expect(engine.list()).toHaveLength(2);

      engine.stop();
    });

    it('does not collapse into a cancelled trigger (only active dedupes)', async () => {
      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const first = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        name: 'reusable',
      });
      // Cancel the first — a subsequent create should produce a brand new one.
      await engine.cancel(first.id);

      const second = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        name: 'reusable',
      });

      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('active');

      engine.stop();
    });

    it('treats unnamed triggers as always distinct (no accidental merging)', async () => {
      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const a = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 * * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
      });
      const b = await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 * * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
      });

      expect(b.id).not.toBe(a.id);

      engine.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Startup cleanup of structural duplicates
  // -------------------------------------------------------------------------

  describe('startup dedup', () => {
    it('collapses structurally-identical active triggers, keeping the oldest', async () => {
      // Seed 5 copies of the same runReconciler cron, plus one unrelated trigger.
      seedTriggerFile(projectPath, [
        { id: 'dup-1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'dup-2', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'dup-3', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'dup-4', createdAt: '2026-01-04T00:00:00.000Z' },
        { id: 'dup-5', createdAt: '2026-01-05T00:00:00.000Z' },
        {
          id: 'unique-1',
          config: { type: 'time', cronExpression: '0 9 * * *' },
          action: { runReconciler: true },
        },
      ]);

      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const all = engine.list();
      const active = all.filter((t) => t.status === 'active');
      const cancelled = all.filter((t) => t.status === 'cancelled');

      // One survivor from the duplicate group + the unrelated trigger = 2 active.
      expect(active).toHaveLength(2);
      // Keeper is the earliest createdAt.
      expect(active.map((t) => t.id).sort()).toEqual(['dup-1', 'unique-1']);
      // The four extras are now cancelled.
      expect(cancelled.map((t) => t.id).sort()).toEqual(['dup-2', 'dup-3', 'dup-4', 'dup-5']);

      engine.stop();
    });

    it('leaves triggers with different config untouched even if createdBy matches', async () => {
      seedTriggerFile(projectPath, [
        {
          id: 'cron-5min',
          config: { type: 'time', cronExpression: '*/5 * * * *' },
        },
        {
          id: 'cron-daily',
          config: { type: 'time', cronExpression: '0 9 * * *' },
        },
      ]);

      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      expect(engine.list().filter((t) => t.status === 'active')).toHaveLength(2);

      engine.stop();
    });

    it('does not cancel already-cancelled or exhausted duplicates a second time', async () => {
      seedTriggerFile(projectPath, [
        { id: 'active-keep' },
        { id: 'cancelled-already', status: 'cancelled' },
        { id: 'exhausted-already', status: 'exhausted' },
      ]);

      const engine = TriggerEngine.getInstance(projectPath);
      await engine.start();

      const all = engine.list();
      expect(all.find((t) => t.id === 'active-keep')!.status).toBe('active');
      expect(all.find((t) => t.id === 'cancelled-already')!.status).toBe('cancelled');
      expect(all.find((t) => t.id === 'exhausted-already')!.status).toBe('exhausted');

      engine.stop();
    });

    it('persists the cancellation so a subsequent boot sees the cleaned state', async () => {
      seedTriggerFile(projectPath, [
        { id: 'dup-a', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'dup-b', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'dup-c', createdAt: '2026-01-03T00:00:00.000Z' },
      ]);

      const first = TriggerEngine.getInstance(projectPath);
      await first.start();
      first.stop();

      // Reset singleton + create a new engine reading the same file.
      TriggerEngine.resetInstance();
      const second = TriggerEngine.getInstance(projectPath);
      await second.start();

      const all = second.list();
      const active = all.filter((t) => t.status === 'active');
      expect(active.map((t) => t.id)).toEqual(['dup-a']);
      expect(all.filter((t) => t.status === 'cancelled')).toHaveLength(2);

      second.stop();
    });
  });
});
