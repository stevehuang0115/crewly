/**
 * TeamTriggerReconciler — keeps the running TriggerEngine in sync with the
 * declarative `Team.triggers` spec.
 *
 * A team's operating cadence (monthly YouTube kickoff, weekly content review,
 * daily EOD reflection, ...) is authored as a list of `TeamTriggerSpec`s on
 * the Team config. This service diffs that spec against whatever the engine
 * currently holds for the given team and converges the two:
 *
 * - **spec-only**: create the trigger on the engine
 * - **engine-only (same team)**: delete the stale trigger
 * - **both**: if the effective config changed, replace; else leave alone
 *
 * Identity is the pair `(teamId, name)` — callers must give each spec a
 * stable `name`. Changing a `name` is treated as delete + create.
 *
 * @module services/v3/team-trigger-reconciler.service
 */

import type { Team, TeamTriggerSpec } from '../../types/index.js';
import type { Trigger, CreateTriggerInput } from '../../types/v2/trigger.types.js';
import { DEFAULT_MAX_IDLE_FIRES } from '../../types/v2/trigger.types.js';
import type { TriggerEngine } from './trigger-engine.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/**
 * Summary of what the reconciler changed for a single team.
 */
export interface ReconcileSummary {
  /** Team that was reconciled */
  teamId: string;
  /** Trigger names that were newly created */
  created: string[];
  /** Trigger names that were replaced due to config drift */
  replaced: string[];
  /** Trigger names that were deleted because the spec no longer lists them */
  deleted: string[];
  /** Trigger names left untouched because the spec matched the running state */
  unchanged: string[];
  /** Trigger names skipped because `enabled: false` */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Synchronises a team's declarative trigger spec with a running TriggerEngine.
 *
 * @example
 * ```typescript
 * const reconciler = new TeamTriggerReconciler(engine);
 * const summary = await reconciler.reconcile(team);
 * // later, when the team is archived:
 * await reconciler.unregisterAll(team.id);
 * ```
 */
export class TeamTriggerReconciler {
  private readonly engine: TriggerEngine;
  private readonly logger: ComponentLogger;

  constructor(engine: TriggerEngine) {
    this.engine = engine;
    this.logger = LoggerService.getInstance().createComponentLogger(
      'TeamTriggerReconciler',
    );
  }

  /**
   * Reconciles the engine's view of this team's triggers with the Team's
   * declarative spec. Idempotent — running twice with the same spec is a no-op.
   *
   * @param team - Team whose triggers should be synced
   * @returns Summary of changes applied
   */
  async reconcile(team: Team): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      teamId: team.id,
      created: [],
      replaced: [],
      deleted: [],
      unchanged: [],
      skipped: [],
    };

    const specsByName = new Map<string, TeamTriggerSpec>();
    for (const spec of team.triggers ?? []) {
      if (!spec.name) {
        this.logger.warn('Skipping team trigger spec with missing name', {
          teamId: team.id,
        });
        continue;
      }
      specsByName.set(spec.name, spec);
    }

    // Pull current engine-side triggers for this team.
    const currentByName = new Map<string, Trigger>();
    for (const trigger of this.engine.list()) {
      if (trigger.teamId === team.id && trigger.name) {
        currentByName.set(trigger.name, trigger);
      }
    }

    // 1) Delete engine triggers whose name disappeared from the spec.
    for (const [name, trigger] of currentByName) {
      if (!specsByName.has(name)) {
        await this.engine.delete(trigger.id);
        summary.deleted.push(name);
      }
    }

    // 2) For each spec, either skip (disabled), create (new), replace (drift),
    //    or leave alone.
    for (const [name, spec] of specsByName) {
      if (spec.enabled === false) {
        // A disabled spec should not have a running trigger.
        const running = currentByName.get(name);
        if (running) {
          await this.engine.delete(running.id);
          summary.deleted.push(name);
        }
        summary.skipped.push(name);
        continue;
      }

      const running = currentByName.get(name);
      if (!running) {
        await this.engine.create(this.toCreateInput(team.id, spec));
        summary.created.push(name);
        continue;
      }

      if (this.hasDrift(running, spec)) {
        await this.engine.delete(running.id);
        await this.engine.create(this.toCreateInput(team.id, spec));
        summary.replaced.push(name);
      } else {
        summary.unchanged.push(name);
      }
    }

    this.logger.info('Team triggers reconciled', {
      teamId: team.id,
      created: summary.created.length,
      replaced: summary.replaced.length,
      deleted: summary.deleted.length,
      unchanged: summary.unchanged.length,
      skipped: summary.skipped.length,
    });

    return summary;
  }

  /**
   * Cancels every trigger the engine holds for the given team. Call this when
   * a team is archived or deleted so no orphaned cadence keeps firing.
   *
   * @param teamId - Owning team's ID
   * @returns Number of triggers removed
   */
  async unregisterAll(teamId: string): Promise<number> {
    let removed = 0;
    for (const trigger of this.engine.list()) {
      if (trigger.teamId === teamId) {
        await this.engine.delete(trigger.id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.logger.info('Team triggers unregistered', { teamId, removed });
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toCreateInput(teamId: string, spec: TeamTriggerSpec): CreateTriggerInput {
    return {
      type: spec.config.type,
      config: spec.config,
      action: spec.action,
      createdBy: 'system',
      maxFires: spec.maxFires,
      maxIdleFires: spec.maxIdleFires,
      teamId,
      name: spec.name,
    };
  }

  /**
   * Shallow drift check — serialise the fields that define runtime behaviour
   * and compare. JSON.stringify is sufficient here because TeamTriggerSpec
   * only holds plain-data shapes.
   */
  private hasDrift(trigger: Trigger, spec: TeamTriggerSpec): boolean {
    const runtime = {
      config: trigger.config,
      action: trigger.action,
      maxFires: trigger.maxFires,
      maxIdleFires: trigger.maxIdleFires,
    };
    const desired = {
      config: spec.config,
      action: spec.action,
      maxFires: spec.maxFires,
      // When the spec omits `maxIdleFires`, compare against the factory
      // default — NOT the running trigger's current value. Mirroring the
      // running value silently hides convergence bugs: if the operator
      // authored the spec with `maxIdleFires: 50`, then later dropped the
      // field intending to fall back to the default, the old value would
      // stick forever because runtime == desired.
      maxIdleFires: spec.maxIdleFires ?? DEFAULT_MAX_IDLE_FIRES,
    };
    return JSON.stringify(runtime) !== JSON.stringify(desired);
  }
}
