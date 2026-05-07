/**
 * Mission Executor Service
 *
 * Lightweight orchestration service for Mission autonomous execution.
 * Does NOT contain LLM logic — the agent runtime handles thinking
 * via the decompose-mission skill. This service handles:
 *
 * - Processing decomposition results (skill output → WorkItems)
 * - Mission lifecycle (start, pause, resume)
 * - Progress tracking (aggregate WorkItem statuses)
 * - Policy enforcement before creating tasks
 *
 * @module services/v3/mission-executor.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { createWorkItem, type WorkItem, type WorkItemType } from '../../types/v2/work-item.types.js';
import {
  type Mission,
  type MissionPolicy,
} from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task from the decomposition skill output. */
export interface DecomposedTask {
  title: string;
  description: string;
  type: 'delegate' | 'review' | 'check';
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggestedRole?: string;
  estimatedMinutes?: number;
  dependsOn?: string[];
  /** Key Result this task contributes to (OKR linkage) */
  krId?: string;
  /** How this task contributes to the KR */
  krContribution?: 'direct' | 'indirect' | 'measurement';
}

/** Decomposition result submitted by the decompose-mission skill. */
export interface DecompositionResult {
  missionId: string;
  phase: number;
  tasks: DecomposedTask[];
}

/** Progress snapshot for a Mission. */
export interface MissionProgress {
  missionId: string;
  status: string;
  phase: number;
  totalTasks: number;
  completedTasks: number;
  runningTasks: number;
  queuedTasks: number;
  blockedTasks: number;
  failedTasks: number;
  progressPercent: number;
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MissionExecutorService {
  private static instance: MissionExecutorService | null = null;
  private readonly logger: ComponentLogger;

  /** Track which phase each mission is on */
  private missionPhases = new Map<string, number>();

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('MissionExecutor');
  }

  public static getInstance(): MissionExecutorService {
    if (!MissionExecutorService.instance) {
      MissionExecutorService.instance = new MissionExecutorService();
    }
    return MissionExecutorService.instance;
  }

  public static resetInstance(): void {
    MissionExecutorService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Decomposition Processing
  // ---------------------------------------------------------------------------

  /**
   * Process decomposition output from the decompose-mission skill.
   * Creates WorkItems in the TaskPool with dependency metadata.
   *
   * @param result - Decomposition result from the skill
   * @param mission - The parent Mission
   * @returns Created WorkItem IDs
   */
  async processDecomposition(result: DecompositionResult, mission: Mission): Promise<string[]> {
    // Policy check
    if (!mission.policy.canCreateTasks) {
      throw new Error(`Mission ${mission.id} policy does not allow task creation`);
    }

    const taskPool = TaskPoolService.getInstance();
    const createdIds: string[] = [];
    const titleToId = new Map<string, string>();
    const createdItems = new Map<string, WorkItem>();

    // First pass: create all WorkItems (queued or blocked)
    for (const task of result.tasks) {
      const hasDeps = task.dependsOn && task.dependsOn.length > 0;

      const workItem = createWorkItem({
        type: (task.type === 'delegate' ? 'delegate' : task.type) as WorkItemType,
        owner: 'orchestrator',
        title: task.title,
        description: task.description,
        missionId: mission.id,
        metadata: {
          phase: result.phase,
          suggestedRole: task.suggestedRole,
          estimatedMinutes: task.estimatedMinutes,
          priority: task.priority,
          krId: task.krId,
          krContribution: task.krContribution,
        },
      });

      if (hasDeps) {
        workItem.status = 'blocked';
        // `dependsOn` IDs are resolved in the second pass below — here we
        // only know dep titles. The status flip to `blocked` is enough for
        // `addToPool` validation; the canonical `dependsOn` field is set
        // before pool insertion.
      }

      titleToId.set(task.title, workItem.id);
      createdItems.set(workItem.id, workItem);
      createdIds.push(workItem.id);
    }

    // Second pass: resolve title-based dependencies to WorkItem IDs and
    // populate the canonical `WorkItem.dependsOn` field.
    //
    // History: this used to write `metadata._blockedBy` instead, but that
    // key was only read by a v3-data.service.ts listener whose backing
    // `v3:task_completed` event was retired in the v1-cleanup campaign
    // (specs/2026-05-06-task-management-v1-deprecation.md). The pool's
    // own `resolveBlockedDependents` reads the canonical top-level
    // `dependsOn` field — which is the one that fires inside the V3
    // completion lifecycle. So writing here closes the unblock path.
    for (const task of result.tasks) {
      if (!task.dependsOn || task.dependsOn.length === 0) continue;

      const workItemId = titleToId.get(task.title);
      if (!workItemId) continue;

      const blockedByIds = task.dependsOn
        .map((depTitle) => titleToId.get(depTitle))
        .filter((id): id is string => id !== undefined);

      if (blockedByIds.length > 0) {
        const wi = createdItems.get(workItemId);
        if (wi) {
          wi.dependsOn = blockedByIds;
        }
      }
    }

    // Add all items to pool (after dependency resolution)
    for (const wi of createdItems.values()) {
      await taskPool.addToPool(wi);
    }

    // Link WorkItems to KRs (OKR integration)
    for (const task of result.tasks) {
      if (task.krId) {
        const workItemId = titleToId.get(task.title);
        if (workItemId) {
          try {
            const { KRTrackingService } = await import('./kr-tracking.service.js');
            await KRTrackingService.getInstance().linkWorkItem(mission.id, task.krId, workItemId);
          } catch {
            // KR linkage is best-effort — don't block decomposition
          }
        }
      }
    }

    this.missionPhases.set(mission.id, result.phase);

    this.logger.info('Decomposition processed — WorkItems created', {
      missionId: mission.id,
      phase: result.phase,
      taskCount: result.tasks.length,
      blockedCount: result.tasks.filter((t) => t.dependsOn && t.dependsOn.length > 0).length,
    });

    return createdIds;
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  /**
   * Compute Mission progress from WorkItem statuses.
   *
   * @param missionId - The Mission to check
   * @returns Progress snapshot
   */
  async checkProgress(missionId: string): Promise<MissionProgress> {
    const taskPool = TaskPoolService.getInstance();
    const allItems = await taskPool.getAllItems();
    const missionItems = allItems.filter((wi) => wi.missionId === missionId);

    const counts = {
      total: missionItems.length,
      done: 0,
      running: 0,
      queued: 0,
      blocked: 0,
      failed: 0,
    };

    let totalCost = 0;

    for (const wi of missionItems) {
      if (wi.status === 'done') counts.done++;
      else if (wi.status === 'running') counts.running++;
      else if (wi.status === 'queued' || wi.status === 'scheduled') counts.queued++;
      else if (wi.status === 'blocked') counts.blocked++;
      else if (wi.status === 'failed') counts.failed++;
      totalCost += wi.cost || 0;
    }

    const progressPercent = counts.total > 0
      ? Math.round((counts.done / counts.total) * 100)
      : 0;

    return {
      missionId,
      status: this.deriveMissionStatus(counts),
      phase: this.missionPhases.get(missionId) ?? 1,
      totalTasks: counts.total,
      completedTasks: counts.done,
      runningTasks: counts.running,
      queuedTasks: counts.queued,
      blockedTasks: counts.blocked,
      failedTasks: counts.failed,
      progressPercent,
      totalCost,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Pause a Mission — freeze all queued tasks (prevent claiming).
   * Running tasks continue until completion.
   *
   * @param missionId - The Mission to pause
   */
  async pauseMission(missionId: string): Promise<number> {
    const taskPool = TaskPoolService.getInstance();
    const allItems = await taskPool.getAllItems();
    const queuedItems = allItems.filter(
      (wi) => wi.missionId === missionId && wi.status === 'queued',
    );

    let frozenCount = 0;
    for (const wi of queuedItems) {
      await taskPool.updateItemStatus(wi.id, 'scheduled');
      frozenCount++;
    }

    this.logger.info('Mission paused', { missionId, frozenTasks: frozenCount });
    return frozenCount;
  }

  /**
   * Resume a paused Mission — unfreeze scheduled tasks back to queued.
   *
   * @param missionId - The Mission to resume
   */
  async resumeMission(missionId: string): Promise<number> {
    const taskPool = TaskPoolService.getInstance();
    const allItems = await taskPool.getAllItems();
    const frozenItems = allItems.filter(
      (wi) => wi.missionId === missionId && wi.status === 'scheduled',
    );

    let unfrozenCount = 0;
    for (const wi of frozenItems) {
      await taskPool.updateItemStatus(wi.id, 'queued');
      unfrozenCount++;
    }

    this.logger.info('Mission resumed', { missionId, unfrozenTasks: unfrozenCount });
    return unfrozenCount;
  }

  // ---------------------------------------------------------------------------
  // Phase Advancement
  // ---------------------------------------------------------------------------

  /** Result of a phase completion check. */
  public static readonly PHASE_RESULT = {
    NOT_COMPLETE: 'not_complete',
    ADVANCED: 'advanced',
    GATE_PENDING: 'gate_pending',
  } as const;

  /**
   * Check if all WorkItems in the current phase are done/verified.
   * If complete, advance to next phase based on phaseGateApproval policy.
   *
   * @param missionId - Mission to check
   * @param phaseGateApproval - How phase transitions are approved
   * @returns Phase advancement result
   */
  async checkPhaseCompletion(
    missionId: string,
    phaseGateApproval: 'none' | 'team_lead' | 'human' = 'none',
  ): Promise<{ result: string; phase: number }> {
    const currentPhase = this.missionPhases.get(missionId) ?? 1;
    const taskPool = TaskPoolService.getInstance();
    const allItems = await taskPool.getAllItems();

    const phaseItems = allItems.filter(
      (wi) => wi.missionId === missionId &&
        (wi.metadata as Record<string, unknown>)?.phase === currentPhase,
    );

    if (phaseItems.length === 0) {
      return { result: MissionExecutorService.PHASE_RESULT.NOT_COMPLETE, phase: currentPhase };
    }

    const allTerminal = phaseItems.every(
      (wi) => wi.status === 'done' || wi.status === 'verified' || wi.status === 'cancelled',
    );

    if (!allTerminal) {
      return { result: MissionExecutorService.PHASE_RESULT.NOT_COMPLETE, phase: currentPhase };
    }

    // All items in current phase are done
    if (phaseGateApproval === 'none') {
      const nextPhase = currentPhase + 1;
      this.missionPhases.set(missionId, nextPhase);
      this.logger.info('Phase auto-advanced', { missionId, from: currentPhase, to: nextPhase });
      return { result: MissionExecutorService.PHASE_RESULT.ADVANCED, phase: nextPhase };
    }

    // Needs approval — return gate_pending for caller to handle
    this.logger.info('Phase complete, awaiting approval', { missionId, phase: currentPhase, gateType: phaseGateApproval });
    return { result: MissionExecutorService.PHASE_RESULT.GATE_PENDING, phase: currentPhase };
  }

  /**
   * Cancel remaining queued/blocked tasks in current phase for replanning.
   *
   * @param missionId - Mission to replan
   * @returns Number of cancelled tasks
   */
  async cancelRemainingPhaseTasks(missionId: string): Promise<number> {
    const currentPhase = this.missionPhases.get(missionId) ?? 1;
    const taskPool = TaskPoolService.getInstance();
    const allItems = await taskPool.getAllItems();

    const cancelableItems = allItems.filter(
      (wi) =>
        wi.missionId === missionId &&
        (wi.metadata as Record<string, unknown>)?.phase === currentPhase &&
        (wi.status === 'queued' || wi.status === 'blocked' || wi.status === 'scheduled'),
    );

    let cancelled = 0;
    for (const wi of cancelableItems) {
      await taskPool.updateItemStatus(wi.id, 'cancelled');
      cancelled++;
    }

    this.logger.info('Cancelled remaining phase tasks for replan', { missionId, phase: currentPhase, cancelled });
    return cancelled;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive a human-readable mission status from WorkItem counts.
   */
  private deriveMissionStatus(counts: Record<string, number>): string {
    if (counts.total === 0) return 'planning';
    if (counts.done === counts.total) return 'completed';
    if (counts.running > 0) return 'executing';
    if (counts.blocked === counts.total - counts.done) return 'blocked';
    if (counts.queued > 0) return 'ready';
    return 'executing';
  }
}
