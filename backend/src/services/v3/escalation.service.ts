/**
 * EscalationService — Periodic evaluation of MissionPolicy escalation rules.
 *
 * Periodically scans all active Missions, builds an EscalationContext from
 * current runtime data (cost, time elapsed, failure count), and evaluates
 * each Mission's escalationRules via PolicyEnforcementService. When a rule
 * triggers, the specified action is executed:
 *
 * - **notify**: Sends a notification to the escalation target (user/orchestrator/team_lead)
 * - **pause**: Pauses the Mission and its associated WorkItems
 * - **block**: Blocks further Mission execution until manual review
 *
 * Integration with TriggerEngine:
 * On startup, registers a cron-based Trigger that periodically invokes
 * the escalation evaluation loop. This leverages TriggerEngine's lifecycle
 * management (fire counting, idle tracking, persistence).
 *
 * @module services/v3/escalation.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { PolicyEnforcementService, type EscalationResult } from '../policy/policy-enforcement.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { TriggerEngine } from './trigger-engine.service.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { ensureDir, safeReadJson } from '../../utils/file-io.utils.js';
import type {
  Mission,
  EscalationContext,
  EscalationRule,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cron expression for escalation checks: every 5 minutes. */
const DEFAULT_ESCALATION_CRON = '*/5 * * * *';

/** Directory name for missions under .crewly. */
const MISSIONS_DIR = 'missions';

/** Maximum escalation results to log per evaluation cycle. */
const MAX_LOG_RESULTS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a single Mission's escalation evaluation.
 */
export interface MissionEscalationResult {
  /** Mission ID */
  missionId: string;
  /** Mission objective (for logging) */
  objective: string;
  /** The evaluation result from PolicyEnforcementService */
  escalation: EscalationResult;
  /** Actions executed (if any) */
  actionsExecuted: string[];
}

/**
 * Summary of a full escalation evaluation cycle.
 */
export interface EscalationCycleSummary {
  /** Number of active missions evaluated */
  missionsEvaluated: number;
  /** Number of missions where escalation was triggered */
  escalationsTriggered: number;
  /** Detailed results per mission (only for triggered ones) */
  results: MissionEscalationResult[];
  /** ISO timestamp of the evaluation */
  evaluatedAt: string;
}

/**
 * Handler for escalation actions (notify, pause, block).
 * Consumers register handlers to integrate with their notification/control systems.
 */
export type EscalationActionHandler = (
  mission: Mission,
  rule: EscalationRule,
  action: 'notify' | 'pause' | 'block',
) => Promise<void>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * EscalationService periodically evaluates MissionPolicy escalation rules
 * and executes the required actions when thresholds are exceeded.
 *
 * @example
 * ```typescript
 * const service = new EscalationService('/path/to/project');
 * service.setActionHandler(async (mission, rule, action) => {
 *   if (action === 'notify') await sendSlackNotification(mission, rule);
 *   if (action === 'pause') await pauseMission(mission.id);
 * });
 * await service.start();
 * ```
 */
export class EscalationService {
  private readonly logger: ComponentLogger;
  private readonly projectPath: string;
  private readonly missionsDir: string;
  private readonly policyService: PolicyEnforcementService;
  private actionHandler: EscalationActionHandler | null = null;
  private triggerId: string | null = null;
  private started = false;
  /**
   * The wrapper function this service installed on the TriggerEngine via
   * `setActionHandler`. Kept so we can detect "was I already installed?"
   * on re-entry and avoid building a growing delegation chain. Each
   * restart that skipped `stop()` (crash, test teardown gaps) would
   * otherwise wrap the previous wrapper as its "originalHandler",
   * stacking closures forever.
   */
  private installedHandler: ((trigger: Trigger, action: unknown) => Promise<void>) | null = null;

  /**
   * Creates a new EscalationService.
   *
   * @param projectPath - Absolute path to the project root
   * @param policyService - Optional PolicyEnforcementService instance (for DI/testing)
   */
  constructor(
    projectPath: string,
    policyService?: PolicyEnforcementService,
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('EscalationService');
    this.projectPath = projectPath;
    this.missionsDir = path.join(projectPath, '.crewly', MISSIONS_DIR);
    this.policyService = policyService ?? new PolicyEnforcementService();
  }

  /**
   * Registers a handler for escalation actions.
   * The handler is called whenever an escalation rule triggers.
   *
   * @param handler - Callback for executing escalation actions
   */
  setActionHandler(handler: EscalationActionHandler): void {
    this.actionHandler = handler;
  }

  /**
   * Starts the escalation service by registering a periodic trigger
   * with the TriggerEngine.
   *
   * @param cronExpression - Cron expression for evaluation frequency (default: every 5 min)
   */
  async start(cronExpression?: string): Promise<void> {
    if (this.started) {
      this.logger.warn('EscalationService already started');
      return;
    }

    const cron = cronExpression ?? DEFAULT_ESCALATION_CRON;

    try {
      const triggerEngine = TriggerEngine.getInstance(this.projectPath);

      const trigger = await triggerEngine.create({
        type: 'time',
        config: {
          type: 'time',
          cronExpression: cron,
          timezone: 'UTC',
        },
        action: {
          runReconciler: true, // Re-used as a "run escalation" signal
        },
        createdBy: 'system',
        // Stable name makes create() idempotent — repeated boots reuse the
        // same trigger instead of stacking duplicates. See TriggerEngine.create.
        name: 'system:escalation',
        maxIdleFires: 50, // Allow many idle fires since not all cycles trigger
      });

      this.triggerId = trigger.id;

      // Register a custom action handler on the TriggerEngine that intercepts
      // our trigger and runs the evaluation loop. If a second `start()` runs
      // without a matching `stop()` (crash recovery, test singleton reuse),
      // `currentHandler` could already be OUR previous wrapper — wrapping it
      // again would build a delegation chain that grows by one closure per
      // restart. Detect that and reuse the prior install instead of stacking.
      const currentHandler = triggerEngine['actionHandler'] as
        | ((trigger: Trigger, action: unknown) => Promise<void>)
        | undefined;
      if (currentHandler !== this.installedHandler) {
        const originalHandler = currentHandler;
        this.installedHandler = async (trigger: Trigger, action: unknown) => {
          if (trigger.id === this.triggerId) {
            await this.evaluate();
            return;
          }
          // Delegate to original handler for other triggers
          if (originalHandler) {
            await originalHandler(trigger, action);
          }
        };
        triggerEngine.setActionHandler(this.installedHandler);
      }

      this.started = true;
      this.logger.info('EscalationService started', {
        triggerId: this.triggerId,
        cron,
      });
    } catch (err) {
      this.logger.warn('Failed to register escalation trigger (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stops the escalation service by cancelling its trigger.
   */
  async stop(): Promise<void> {
    if (this.triggerId) {
      try {
        const triggerEngine = TriggerEngine.getInstance(this.projectPath);
        await triggerEngine.cancel(this.triggerId);
      } catch {
        // Trigger may already be cleaned up
      }
      this.triggerId = null;
    }
    this.started = false;
    this.logger.info('EscalationService stopped');
  }

  /**
   * Returns whether the service is currently running.
   */
  isStarted(): boolean {
    return this.started;
  }

  // ---------------------------------------------------------------------------
  // Core Evaluation Loop
  // ---------------------------------------------------------------------------

  /**
   * Evaluates all active Missions' escalation rules against current context.
   * This is the main loop called periodically by the TriggerEngine.
   *
   * @returns Summary of the evaluation cycle
   */
  async evaluate(): Promise<EscalationCycleSummary> {
    const evaluatedAt = new Date().toISOString();
    const results: MissionEscalationResult[] = [];

    try {
      const missions = await this.loadActiveMissions();

      // Fetch the task pool once per cycle and bucket by missionId so each
      // mission's context build is a simple Map lookup instead of a full
      // scan of the (potentially thousands of items) pool. Previously N
      // missions × O(pool) made the cycle quadratic on large workspaces.
      const allItems = await this.loadMissionWorkItems();
      const itemsByMission = new Map<string, WorkItem[]>();
      for (const wi of allItems) {
        if (!wi.missionId) continue;
        const bucket = itemsByMission.get(wi.missionId);
        if (bucket) {
          bucket.push(wi);
        } else {
          itemsByMission.set(wi.missionId, [wi]);
        }
      }

      for (const mission of missions) {
        try {
          const missionItems = itemsByMission.get(mission.id) ?? [];
          const context = this.buildEscalationContext(mission, missionItems);
          const escalation = this.policyService.evaluateEscalationRules(
            mission.policy.escalationRules,
            context,
          );

          if (escalation.triggered) {
            const actionsExecuted = await this.executeEscalationActions(
              mission,
              escalation,
            );
            results.push({
              missionId: mission.id,
              objective: mission.objective,
              escalation,
              actionsExecuted,
            });
          }
        } catch (err) {
          this.logger.warn('Escalation evaluation failed for mission (non-fatal)', {
            missionId: mission.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const summary: EscalationCycleSummary = {
        missionsEvaluated: missions.length,
        escalationsTriggered: results.length,
        results: results.slice(0, MAX_LOG_RESULTS),
        evaluatedAt,
      };

      if (results.length > 0) {
        this.logger.info('Escalation cycle completed with triggers', {
          missionsEvaluated: summary.missionsEvaluated,
          escalationsTriggered: summary.escalationsTriggered,
        });
      } else {
        this.logger.debug('Escalation cycle completed — no triggers');
      }

      return summary;
    } catch (err) {
      this.logger.warn('Escalation evaluation cycle failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        missionsEvaluated: 0,
        escalationsTriggered: 0,
        results: [],
        evaluatedAt,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Context Building
  // ---------------------------------------------------------------------------

  /**
   * Loads the task pool once per evaluation cycle. Extracted so `evaluate`
   * can bucket items by missionId before calling
   * {@link buildEscalationContext} for each mission.
   */
  private async loadMissionWorkItems(): Promise<WorkItem[]> {
    try {
      return await TaskPoolService.getInstance().getAllItems();
    } catch (err) {
      this.logger.warn('Failed to load task pool for escalation (treating as empty)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Builds an EscalationContext for a Mission by aggregating runtime data.
   *
   * Sources:
   * - Cost: sum of WorkItem costs linked to this mission
   * - Time: hours elapsed since mission creation
   * - Failures: count of failed WorkItems linked to this mission
   *
   * @param mission - The Mission to build context for
   * @param missionItems - Pre-filtered WorkItems belonging to the mission.
   *        Pass an empty array when the mission has no items or the pool
   *        could not be loaded — the function does not re-fetch.
   * @returns Populated EscalationContext
   */
  buildEscalationContext(mission: Mission, missionItems: WorkItem[]): EscalationContext {
    // Single pass over the pre-filtered slice gives us both the cost sum
    // and the failure count without double-iterating.
    let currentCost = 0;
    let failureCount = 0;
    for (const wi of missionItems) {
      currentCost += wi.cost ?? 0;
      if (wi.status === 'failed') failureCount += 1;
    }

    const createdAt = new Date(mission.createdAt).getTime();
    const hoursElapsed = (Date.now() - createdAt) / (1000 * 60 * 60);

    return {
      currentCost,
      hoursElapsed,
      failureCount,
      scopeChanged: false,
      securityConcern: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Action Execution
  // ---------------------------------------------------------------------------

  /**
   * Executes the required actions from an escalation result.
   *
   * Action severity order: block > pause > notify.
   * Each triggered rule's action is executed via the registered handler.
   *
   * @param mission - The Mission being escalated
   * @param escalation - The evaluation result with triggered rules
   * @returns List of action descriptions that were executed
   */
  private async executeEscalationActions(
    mission: Mission,
    escalation: EscalationResult,
  ): Promise<string[]> {
    const executed: string[] = [];

    for (const rule of escalation.triggeredRules) {
      try {
        // Execute via registered handler
        if (this.actionHandler) {
          await this.actionHandler(mission, rule, rule.action);
        }

        // Built-in actions
        if (rule.action === 'pause') {
          await this.pauseMissionWorkItems(mission.id);
        }

        executed.push(
          `${rule.action}:${rule.condition}(${rule.threshold})→${rule.escalateTo}`,
        );

        this.logger.info('Escalation action executed', {
          missionId: mission.id,
          condition: rule.condition,
          threshold: rule.threshold,
          action: rule.action,
          escalateTo: rule.escalateTo,
        });
      } catch (err) {
        this.logger.warn('Escalation action failed (non-fatal)', {
          missionId: mission.id,
          rule,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return executed;
  }

  /**
   * Pauses all active WorkItems belonging to a Mission.
   * Sets queued/running items to 'blocked' status.
   *
   * @param missionId - The Mission ID whose WorkItems should be paused
   */
  private async pauseMissionWorkItems(missionId: string): Promise<void> {
    try {
      const taskPool = TaskPoolService.getInstance();
      const allItems = await taskPool.getAllItems();
      const activeItems = allItems.filter(
        (wi) =>
          wi.missionId === missionId &&
          (wi.status === 'queued' || wi.status === 'running'),
      );

      let succeeded = 0;
      const failures: Array<{ itemId: string; error: string }> = [];
      for (const item of activeItems) {
        try {
          // queued → blocked requires queued→running→blocked or direct update
          await taskPool.updateItemStatus(item.id, 'blocked');
          succeeded += 1;
        } catch (err) {
          // Some transitions may not be valid — track so we don't report
          // a falsely optimistic `pausedCount`.
          failures.push({
            itemId: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.logger.info('Paused mission WorkItems', {
        missionId,
        attempted: activeItems.length,
        succeeded,
        failed: failures.length,
      });

      if (failures.length > 0) {
        this.logger.debug('Work-item pause failures', { missionId, failures });
      }
    } catch (err) {
      this.logger.warn('Failed to pause mission WorkItems (non-fatal)', {
        missionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mission Loading
  // ---------------------------------------------------------------------------

  /**
   * Loads all active Missions from disk.
   *
   * @returns Array of active Mission objects
   */
  async loadActiveMissions(): Promise<Mission[]> {
    try {
      await ensureDir(this.missionsDir);
      const files = await fs.readdir(this.missionsDir);
      const missions: Mission[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(this.missionsDir, file);
          const mission = await safeReadJson<Mission | null>(filePath, null);
          if (
            mission &&
            mission.id &&
            mission.status === 'active' &&
            mission.policy?.escalationRules?.length > 0
          ) {
            missions.push(mission);
          }
        } catch {
          // Skip malformed files
        }
      }

      return missions;
    } catch {
      return [];
    }
  }
}
