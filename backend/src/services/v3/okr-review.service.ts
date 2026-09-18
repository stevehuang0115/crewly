/**
 * OKR Review Service
 *
 * Implements the feedback loop for Mission OKR execution:
 * 1. Aggregate KR + task progress
 * 2. Derive recommendation (pure math)
 * 3. Trigger next action (continue / review skill / replan / escalate)
 *
 * Does NOT contain LLM logic — triggers the review-mission skill
 * when agent reasoning is needed.
 *
 * @module services/v3/okr-review.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMissionsDir } from './mission-paths.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { MissionExecutorService } from './mission-executor.service.js';
import type {
  OKRReviewResult,
  ReviewDecision,
  MissionOKRSummary,
  CascadeOKRSummary,
} from '../../types/v2/key-result.types.js';
import type { Mission } from '../../types/v2/mission.types.js';
import { getEffectiveCadence, isMissionExecutable } from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Build the one-line review summary string persisted on a mission. Kept in one
 * place so the on-demand parent roll-up refresh and the self-review write stay
 * consistent and machine-parseable (see {@link OKRReviewService}).
 */
function formatCascadeSummary(summary: CascadeOKRSummary): string {
  return (
    `Roll-up: ${summary.rolledUpProgress}% ` +
    `(own ${summary.overallProgress}%, ${summary.childMissionCount} child OKR(s)) | ` +
    `Recommendation: ${summary.recommendation}`
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for executing periodic OKR reviews and processing review decisions.
 */
export class OKRReviewService {
  private static instance: OKRReviewService | null = null;
  private readonly logger: ComponentLogger;

  /**
   * Optional EventBus for `mission:replanned` publication. Wired from the
   * backend boot path via {@link setEventBusService}; absent in tests/CLI.
   */
  private eventBus: EventBusService | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('OKRReview');
  }

  /**
   * Wire the EventBus used to publish `mission:replanned`. Idempotent; pass
   * `null` to disable publication.
   *
   * @param bus - The live EventBusService, or null
   */
  setEventBusService(bus: EventBusService | null): void {
    this.eventBus = bus;
  }

  static getInstance(): OKRReviewService {
    if (!OKRReviewService.instance) {
      OKRReviewService.instance = new OKRReviewService();
    }
    return OKRReviewService.instance;
  }

  static resetInstance(): void {
    OKRReviewService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Review Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a scheduled OKR review for a mission.
   *
   * 1. Load mission
   * 2. Aggregate KR progress
   * 3. Aggregate task progress
   * 4. Derive recommendation
   * 5. Determine action based on recommendation + policy
   * 6. Persist review summary on mission
   *
   * @param missionId - Mission to review
   * @returns Review result with recommendation and action
   */
  async executeReview(missionId: string): Promise<OKRReviewResult> {
    const mission = await this.loadMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} not found`);
    }
    if (!isMissionExecutable(mission)) {
      throw new Error(
        `Mission ${missionId} is not executable ` +
          `(status='${mission.status}', approval='${mission.approval?.state ?? 'none'}') — review refused`,
      );
    }

    const staleCycles = mission.staleCycles ?? 0;
    const krService = KRTrackingService.getInstance();
    const okrSummary = await krService.computeMissionOKRProgress(missionId, staleCycles);
    const executor = MissionExecutorService.getInstance();
    const taskProgress = await executor.checkProgress(missionId);

    // Determine if KRs progressed since last review
    const previousProgress = this.extractPreviousProgress(mission.lastReviewSummary);
    const progressStalled = previousProgress !== null && okrSummary.overallProgress <= previousProgress;

    // Update stale cycles
    const newStaleCycles = progressStalled ? staleCycles + 1 : 0;

    // Re-derive recommendation with updated stale cycles
    const finalSummary = progressStalled
      ? await krService.computeMissionOKRProgress(missionId, newStaleCycles)
      : okrSummary;

    // Determine action
    let action: OKRReviewResult['action'];
    switch (finalSummary.recommendation) {
      case 'continue':
        action = 'continue';
        break;
      case 'adjust_strategy':
        action = 'trigger_review_skill';
        break;
      case 'replan':
        action = 'trigger_replan';
        break;
      case 'escalate':
        action = 'escalate';
        break;
      default:
        action = 'continue';
    }

    const result: OKRReviewResult = {
      missionId,
      reviewedAt: new Date().toISOString(),
      okrSummary: finalSummary,
      recommendation: finalSummary.recommendation,
      action,
    };

    // Persist review summary on mission
    await this.updateMissionReview(missionId, {
      lastReviewSummary: `Progress: ${finalSummary.overallProgress}% | ${finalSummary.achieved}/${finalSummary.totalKRs} achieved | Recommendation: ${finalSummary.recommendation}`,
      staleCycles: newStaleCycles,
      lastReviewAt: result.reviewedAt,
    });

    // Cross-level roll-up: on-demand at review time, refresh this mission's
    // parent so the parent's lastReviewSummary reflects the (now-updated) child.
    // Event-driven refresh on every child measurement is a follow-up (spec §4.3).
    await this.refreshParentRollup(mission.parentMissionId);

    this.logger.info('OKR review completed', {
      missionId,
      progress: finalSummary.overallProgress,
      recommendation: finalSummary.recommendation,
      action,
      staleCycles: newStaleCycles,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Review Decision Processing
  // -------------------------------------------------------------------------

  /**
   * Process a review decision from the review-mission skill.
   *
   * @param missionId - Mission ID
   * @param decision - The agent's review decision
   */
  async processReviewDecision(missionId: string, decision: ReviewDecision): Promise<void> {
    const mission = await this.loadMission(missionId);
    if (!mission) throw new Error(`Mission ${missionId} not found`);

    const executor = MissionExecutorService.getInstance();

    switch (decision.action) {
      case 'continue':
        // No action needed
        break;

      case 'adjust_strategy':
        if (decision.newStrategy) {
          await this.updateMissionReview(missionId, {
            currentStrategy: decision.newStrategy,
          });
        }
        break;

      case 'replan_phase':
        // Cancel remaining tasks, bump phase for new decomposition
        await executor.cancelRemainingPhaseTasks(missionId);
        if (decision.newStrategy) {
          await this.updateMissionReview(missionId, {
            currentStrategy: decision.newStrategy,
          });
        }
        if (decision.newPhase) {
          // Phase will be set when new decomposition arrives
          this.logger.info('Replan triggered', { missionId, newPhase: decision.newPhase });
        }
        this.publishReplanned(mission, decision);
        break;

      case 'add_tasks':
        // Additional tasks will be submitted via the decompose endpoint
        this.logger.info('Additional tasks requested', { missionId });
        break;

      case 'cancel_mission':
        await this.updateMissionReview(missionId, { status: 'cancelled' });
        await executor.pauseMission(missionId);
        this.logger.info('Mission cancelled via review', { missionId });
        break;
    }

    // Record learnings
    if (decision.learnings && decision.learnings.length > 0) {
      const updatedMission = await this.loadMission(missionId);
      if (updatedMission) {
        const learnings = updatedMission.learnings ?? [];
        learnings.push(...decision.learnings);
        await this.updateMissionReview(missionId, { learnings });
      }
    }

    // Update KR targets if requested
    if (decision.krUpdates) {
      const krService = KRTrackingService.getInstance();
      for (const update of decision.krUpdates) {
        await krService.update(missionId, update.krId, {
          target: update.newTarget,
        });
      }
    }

    this.logger.info('Review decision processed', { missionId, action: decision.action });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Load a mission from disk.
   */
  private async loadMission(missionId: string): Promise<Mission | null> {
    try {
      const filePath = path.join(getMissionsDir(), `${missionId}.json`);
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Mission;
    } catch {
      return null;
    }
  }

  /**
   * Publish `mission:replanned` so the bridge raises a TL-acknowledge
   * review WI, the auto-learning subscriber records an `sop_update`
   * learning and the milestone subscriber surfaces it to the owner. The
   * event was declared and handled but never published before this.
   *
   * Payload: `previousValue` = strategy before the replan, `newValue` =
   * new strategy (or `'replan'` when none given); `newPhase` rides on the
   * id so each replan is a distinct event.
   */
  private publishReplanned(mission: Mission, decision: ReviewDecision): void {
    if (!this.eventBus) return;
    const stamp = Date.now();
    try {
      this.eventBus.publish({
        id: `${mission.id}:replanned:${decision.newPhase ?? 'phase'}:${stamp}`,
        type: 'mission:replanned',
        timestamp: new Date(stamp).toISOString(),
        teamId: mission.ownerTeamId,
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: '',
        previousValue: mission.currentStrategy ?? '',
        newValue: decision.newStrategy ?? 'replan',
        changedField: 'taskStatus',
        missionId: mission.id,
      });
    } catch (err) {
      this.logger.warn('mission:replanned publish threw', {
        missionId: mission.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Update mission fields on disk (partial merge).
   */
  private async updateMissionReview(
    missionId: string,
    updates: Partial<Mission>,
  ): Promise<void> {
    const mission = await this.loadMission(missionId);
    if (!mission) return;

    const merged = { ...mission, ...updates, updatedAt: new Date().toISOString() };
    const filePath = path.join(getMissionsDir(), `${missionId}.json`);
    await fs.writeFile(filePath, JSON.stringify(merged, null, 2));
  }

  /**
   * Refresh a parent mission's `lastReviewSummary` using the cascade roll-up.
   *
   * Called on-demand after a child review so the parent reflects its children's
   * latest progress without a separate scheduled review. No-op when the
   * reviewed mission has no parent or the parent has vanished. Errors are
   * swallowed and logged — a roll-up refresh must never fail the child review.
   *
   * @param parentMissionId - The reviewed mission's parent (may be undefined)
   */
  private async refreshParentRollup(parentMissionId?: string): Promise<void> {
    if (!parentMissionId) return;
    const parent = await this.loadMission(parentMissionId);
    if (!parent) return;
    try {
      const krService = KRTrackingService.getInstance();
      const rollup = await krService.computeCascadeOKRProgress(parentMissionId);
      await this.updateMissionReview(parentMissionId, {
        lastReviewSummary: formatCascadeSummary(rollup),
        lastReviewAt: new Date().toISOString(),
      });
      this.logger.info('Refreshed parent roll-up summary', {
        parentMissionId,
        rolledUpProgress: rollup.rolledUpProgress,
        childMissionCount: rollup.childMissionCount,
      });
    } catch (err) {
      this.logger.warn('Parent roll-up refresh failed', {
        parentMissionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Extract previous overall progress from review summary string.
   */
  private extractPreviousProgress(summary?: string): number | null {
    if (!summary) return null;
    const match = summary.match(/Progress:\s*(\d+)%/);
    return match ? parseInt(match[1], 10) : null;
  }
}
