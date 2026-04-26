/**
 * Key Result Tracking Service
 *
 * CRUD, measurement recording, progress aggregation, and WorkItem linkage
 * for structured Key Results attached to Missions.
 *
 * Does NOT contain LLM logic — all status derivation is pure math.
 * Agent reasoning happens in skills (review-mission, measure-kr).
 *
 * @module services/v3/kr-tracking.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
  type KeyResult,
  type KRMeasurement,
  type KRStatus,
  type CreateKeyResultInput,
  type UpdateKeyResultInput,
  type MissionOKRSummary,
  type OKRRecommendation,
  createKeyResult,
  computeKRProgress,
  deriveKRStatus,
  deriveOKRRecommendation,
  MAX_MEASUREMENT_HISTORY,
  validateCreateKeyResultInput,
} from '../../types/v2/key-result.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory for mission data. */
function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

/** Directory for a mission's key results. */
function getKRDir(missionId: string): string {
  return path.join(getMissionsDir(), missionId, 'key-results');
}

/** File path for a single key result. */
function getKRPath(missionId: string, krId: string): string {
  return path.join(getKRDir(missionId), `${krId}.json`);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for managing Key Result lifecycle, measurements, and aggregation.
 */
export class KRTrackingService {
  private static instance: KRTrackingService | null = null;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('KRTracking');
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): KRTrackingService {
    if (!KRTrackingService.instance) {
      KRTrackingService.instance = new KRTrackingService();
    }
    return KRTrackingService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    KRTrackingService.instance = null;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new Key Result for a mission.
   *
   * @param input - Validated creation input
   * @returns The created KeyResult
   */
  async create(input: CreateKeyResultInput): Promise<KeyResult> {
    const errors = validateCreateKeyResultInput(input);
    if (errors.length > 0) {
      throw new Error(`Invalid KeyResult input: ${errors.join(', ')}`);
    }

    const kr = createKeyResult(input);
    await this.persist(kr);

    this.logger.info('Created KeyResult', { krId: kr.id, missionId: kr.missionId, title: kr.title });
    return kr;
  }

  /**
   * Get a Key Result by ID.
   *
   * @param missionId - Parent mission ID
   * @param krId - Key Result ID
   * @returns The KeyResult, or null if not found
   */
  async get(missionId: string, krId: string): Promise<KeyResult | null> {
    try {
      const raw = await fs.readFile(getKRPath(missionId, krId), 'utf-8');
      return JSON.parse(raw) as KeyResult;
    } catch {
      return null;
    }
  }

  /**
   * List all Key Results for a mission.
   *
   * @param missionId - Mission ID
   * @returns Array of KeyResults
   */
  async listByMission(missionId: string): Promise<KeyResult[]> {
    const dir = getKRDir(missionId);
    try {
      const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(dir, f), 'utf-8');
            return JSON.parse(raw) as KeyResult;
          } catch { return null; }
        })
      );
      return results.filter((kr): kr is KeyResult => kr !== null);
    } catch {
      return [];
    }
  }

  /**
   * Update a Key Result.
   *
   * @param missionId - Parent mission ID
   * @param krId - Key Result ID
   * @param update - Fields to update
   * @returns Updated KeyResult, or null if not found
   */
  async update(missionId: string, krId: string, update: UpdateKeyResultInput): Promise<KeyResult | null> {
    const kr = await this.get(missionId, krId);
    if (!kr) return null;

    if (update.current !== undefined) kr.current = update.current;
    if (update.target !== undefined) kr.target = update.target;
    if (update.status !== undefined) kr.status = update.status;
    if (update.ownerId !== undefined) kr.ownerId = update.ownerId;
    if (update.measurementSource !== undefined) kr.measurementSource = update.measurementSource;
    if (update.measurementConfig !== undefined) kr.measurementConfig = update.measurementConfig;

    // Recompute status if current changed but status wasn't explicitly set
    if (update.current !== undefined && update.status === undefined) {
      const progress = computeKRProgress(kr);
      kr.status = deriveKRStatus(progress, kr.current, kr.baseline);
    }

    kr.updatedAt = new Date().toISOString();
    await this.persist(kr);
    return kr;
  }

  /**
   * Delete a Key Result.
   *
   * @param missionId - Parent mission ID
   * @param krId - Key Result ID
   */
  async delete(missionId: string, krId: string): Promise<boolean> {
    try {
      await fs.unlink(getKRPath(missionId, krId));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Measurement
  // -------------------------------------------------------------------------

  /**
   * Record a new measurement for a Key Result.
   * Automatically updates current value, recomputes status,
   * and appends to measurement history.
   *
   * @param missionId - Parent mission ID
   * @param krId - Key Result ID
   * @param value - Measured value
   * @param source - Who/what took the measurement
   * @param note - Optional context
   * @returns The recorded measurement, or null if KR not found
   */
  async recordMeasurement(
    missionId: string,
    krId: string,
    value: number,
    source: string,
    note?: string,
  ): Promise<KRMeasurement | null> {
    const kr = await this.get(missionId, krId);
    if (!kr) return null;

    const measurement: KRMeasurement = {
      value,
      measuredAt: new Date().toISOString(),
      source,
      note,
    };

    // Update current value and recompute status
    kr.current = value;
    const progress = computeKRProgress(kr);
    kr.status = deriveKRStatus(progress, kr.current, kr.baseline);

    // Prepend to history, cap at MAX_MEASUREMENT_HISTORY
    kr.measurements.unshift(measurement);
    if (kr.measurements.length > MAX_MEASUREMENT_HISTORY) {
      kr.measurements = kr.measurements.slice(0, MAX_MEASUREMENT_HISTORY);
    }

    kr.updatedAt = new Date().toISOString();
    await this.persist(kr);

    this.logger.info('Recorded KR measurement', {
      krId,
      value,
      status: kr.status,
      progress: Math.round(progress),
    });

    return measurement;
  }

  // -------------------------------------------------------------------------
  // WorkItem Linkage
  // -------------------------------------------------------------------------

  /**
   * Link a WorkItem to a Key Result.
   *
   * @param missionId - Parent mission ID
   * @param krId - Key Result ID
   * @param workItemId - WorkItem ID to link
   */
  async linkWorkItem(missionId: string, krId: string, workItemId: string): Promise<void> {
    const kr = await this.get(missionId, krId);
    if (!kr) return;

    if (!kr.linkedWorkItemIds.includes(workItemId)) {
      kr.linkedWorkItemIds.push(workItemId);
      kr.updatedAt = new Date().toISOString();
      await this.persist(kr);
    }
  }

  /**
   * Handle WorkItem completion — auto-update KRs with task_completion source.
   *
   * For KRs measured by task completion, progress = completed linked items / total linked items.
   *
   * @param workItem - The completed WorkItem
   */
  async onWorkItemCompleted(workItem: WorkItem): Promise<void> {
    const missionId = workItem.missionId;
    const krId = workItem.metadata?.krId as string | undefined;
    if (!missionId || !krId) return;

    const kr = await this.get(missionId, krId);
    if (!kr || kr.measurementSource !== 'task_completion') return;

    // Count completed linked items using TaskPoolService
    const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
    const pool = TaskPoolService.getInstance();
    const allItems = await pool.getAllItems();
    const linkedItems = allItems.filter(item => kr.linkedWorkItemIds.includes(item.id));
    const completedCount = linkedItems.filter(item =>
      item.status === 'done' || item.status === 'verified'
    ).length;

    const totalLinked = kr.linkedWorkItemIds.length;
    if (totalLinked === 0) return;

    // Map completion ratio to the KR's baseline→target range
    const completionRatio = completedCount / totalLinked;
    const range = kr.target - kr.baseline;
    const newValue = kr.baseline + (range * completionRatio);

    await this.recordMeasurement(
      missionId,
      krId,
      Math.round(newValue * 100) / 100,
      `task_completion:${workItem.id}`,
      `${completedCount}/${totalLinked} linked tasks completed`,
    );
  }

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  /**
   * Compute aggregated OKR progress for a mission.
   *
   * @param missionId - Mission ID
   * @param staleCycles - Number of consecutive stale review cycles
   * @returns Aggregated summary with recommendation
   */
  async computeMissionOKRProgress(missionId: string, staleCycles: number = 0): Promise<MissionOKRSummary> {
    const krs = await this.listByMission(missionId);
    const statuses = krs.map(kr => kr.status);

    const counts: Record<KRStatus, number> = {
      not_started: 0,
      on_track: 0,
      at_risk: 0,
      off_track: 0,
      achieved: 0,
    };
    for (const s of statuses) counts[s]++;

    // Weighted average progress
    let overallProgress = 0;
    if (krs.length > 0) {
      const totalProgress = krs.reduce((sum, kr) => sum + computeKRProgress(kr), 0);
      overallProgress = Math.round(totalProgress / krs.length);
    }

    const recommendation = deriveOKRRecommendation(statuses, staleCycles);

    return {
      missionId,
      totalKRs: krs.length,
      achieved: counts.achieved,
      onTrack: counts.on_track,
      atRisk: counts.at_risk,
      offTrack: counts.off_track,
      notStarted: counts.not_started,
      overallProgress,
      recommendation,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist a KeyResult to disk.
   */
  private async persist(kr: KeyResult): Promise<void> {
    const dir = getKRDir(kr.missionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await fs.writeFile(getKRPath(kr.missionId, kr.id), JSON.stringify(kr, null, 2));
  }
}
