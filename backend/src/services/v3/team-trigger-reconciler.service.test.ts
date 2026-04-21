/**
 * Unit tests for TeamTriggerReconciler.
 *
 * Uses a minimal hand-rolled fake in place of the full TriggerEngine — the
 * real engine owns timers, EventBus wiring, and disk persistence we don't
 * need here. The fake implements the three methods the reconciler depends
 * on (`list`, `create`, `delete`) and tracks stored triggers in a Map.
 */

import { TeamTriggerReconciler } from './team-trigger-reconciler.service.js';
import type { TriggerEngine } from './trigger-engine.service.js';
import type { Team, TeamTriggerSpec } from '../../types/index.js';
import {
  type Trigger,
  type CreateTriggerInput,
  createTrigger,
} from '../../types/v2/trigger.types.js';

// ---------------------------------------------------------------------------
// Logger silencer — reconciler uses LoggerService; keep tests quiet.
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
// Fakes
// ---------------------------------------------------------------------------

class FakeTriggerEngine {
  private store = new Map<string, Trigger>();

  list(): Trigger[] {
    return Array.from(this.store.values());
  }

  async create(input: CreateTriggerInput): Promise<Trigger> {
    const trigger = createTrigger(input);
    this.store.set(trigger.id, trigger);
    return trigger;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  // Helper for tests — not used by reconciler.
  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<TeamTriggerSpec> = {}): TeamTriggerSpec {
  return {
    name: 'daily-eod',
    description: 'Daily end-of-day reflection',
    config: { type: 'time', cronExpression: '0 17 * * *' },
    action: {
      createWorkItem: {
        title: 'EOD reflect',
        type: 'review',
        owner: 'agent',
      },
    },
    ...overrides,
  };
}

function makeTeam(triggers: TeamTriggerSpec[]): Team {
  return {
    id: 'team-abc',
    name: 'Marketing',
    members: [],
    projectIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    triggers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamTriggerReconciler', () => {
  let engine: FakeTriggerEngine;
  let reconciler: TeamTriggerReconciler;

  beforeEach(() => {
    engine = new FakeTriggerEngine();
    reconciler = new TeamTriggerReconciler(engine as unknown as TriggerEngine);
  });

  // -------------------------------------------------------------------------

  describe('reconcile', () => {
    it('creates triggers on first reconcile', async () => {
      const team = makeTeam([
        makeSpec({ name: 'daily-eod' }),
        makeSpec({ name: 'weekly-review', config: { type: 'time', cronExpression: '0 9 * * 1' } }),
      ]);

      const summary = await reconciler.reconcile(team);

      expect(summary.created.sort()).toEqual(['daily-eod', 'weekly-review']);
      expect(summary.deleted).toEqual([]);
      expect(summary.replaced).toEqual([]);
      expect(engine.size()).toBe(2);

      // Runtime triggers should carry the team identity.
      for (const t of engine.list()) {
        expect(t.teamId).toBe('team-abc');
        expect(t.createdBy).toBe('system');
      }
    });

    it('is idempotent — running twice with the same spec changes nothing', async () => {
      const team = makeTeam([makeSpec()]);

      const first = await reconciler.reconcile(team);
      const second = await reconciler.reconcile(team);

      expect(first.created).toEqual(['daily-eod']);
      expect(second.created).toEqual([]);
      expect(second.unchanged).toEqual(['daily-eod']);
      expect(engine.size()).toBe(1);
    });

    it('replaces a trigger when its config drifts', async () => {
      const team = makeTeam([makeSpec({ name: 'daily-eod' })]);
      await reconciler.reconcile(team);
      const originalId = engine.list()[0].id;

      // Update the cron and reconcile again
      team.triggers = [
        makeSpec({ name: 'daily-eod', config: { type: 'time', cronExpression: '0 18 * * *' } }),
      ];
      const summary = await reconciler.reconcile(team);

      expect(summary.replaced).toEqual(['daily-eod']);
      expect(engine.size()).toBe(1);
      const replaced = engine.list()[0];
      expect(replaced.id).not.toBe(originalId);
      if (replaced.config.type === 'time') {
        expect(replaced.config.cronExpression).toBe('0 18 * * *');
      }
    });

    it('deletes triggers whose name is no longer in the spec', async () => {
      const team = makeTeam([
        makeSpec({ name: 'daily-eod' }),
        makeSpec({ name: 'obsolete' }),
      ]);
      await reconciler.reconcile(team);
      expect(engine.size()).toBe(2);

      // Remove "obsolete" from spec
      team.triggers = [makeSpec({ name: 'daily-eod' })];
      const summary = await reconciler.reconcile(team);

      expect(summary.deleted).toEqual(['obsolete']);
      expect(engine.size()).toBe(1);
      expect(engine.list()[0].name).toBe('daily-eod');
    });

    it('skips disabled specs and removes their running trigger if any', async () => {
      const team = makeTeam([makeSpec({ name: 'daily-eod' })]);
      await reconciler.reconcile(team);
      expect(engine.size()).toBe(1);

      team.triggers = [makeSpec({ name: 'daily-eod', enabled: false })];
      const summary = await reconciler.reconcile(team);

      expect(summary.skipped).toEqual(['daily-eod']);
      expect(summary.deleted).toEqual(['daily-eod']);
      expect(engine.size()).toBe(0);
    });

    it('leaves triggers owned by other teams alone', async () => {
      // Pre-populate a trigger owned by another team
      await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        teamId: 'other-team',
        name: 'other-cron',
      });

      const team = makeTeam([makeSpec()]);
      await reconciler.reconcile(team);

      expect(engine.size()).toBe(2);
      const names = engine.list().map((t) => t.name).sort();
      expect(names).toEqual(['daily-eod', 'other-cron']);
    });

    it('warns and skips spec entries with missing name', async () => {
      const team = makeTeam([
        { ...makeSpec(), name: '' } as TeamTriggerSpec,
        makeSpec({ name: 'daily-eod' }),
      ]);

      const summary = await reconciler.reconcile(team);
      expect(summary.created).toEqual(['daily-eod']);
      expect(engine.size()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------

  describe('unregisterAll', () => {
    it('removes every trigger belonging to the team', async () => {
      const team = makeTeam([
        makeSpec({ name: 'daily-eod' }),
        makeSpec({ name: 'weekly-review' }),
      ]);
      await reconciler.reconcile(team);

      // Also add a trigger for another team
      await engine.create({
        type: 'time',
        config: { type: 'time', cronExpression: '0 9 * * *' },
        action: { runReconciler: true },
        createdBy: 'system',
        teamId: 'other-team',
        name: 'other',
      });

      expect(engine.size()).toBe(3);

      const removed = await reconciler.unregisterAll('team-abc');
      expect(removed).toBe(2);
      expect(engine.size()).toBe(1);
      expect(engine.list()[0].teamId).toBe('other-team');
    });

    it('returns 0 when the team has no running triggers', async () => {
      expect(await reconciler.unregisterAll('ghost-team')).toBe(0);
    });
  });
});
