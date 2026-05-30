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
  deriveLevel,
  type Mission,
  type MissionLevel,
} from '../../types/v2/mission.types.js';
import {
  type KeyResult,
  type KRMeasurement,
  type KRStatus,
  type CreateKeyResultInput,
  type UpdateKeyResultInput,
  type MissionOKRSummary,
  type CascadeOKRSummary,
  type OKRRecommendation,
  createKeyResult,
  computeKRProgress,
  deriveKRStatus,
  deriveCascadeChildStatus,
  deriveOKRRecommendation,
  computeRolledUpProgress,
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


/** Proposal state that marks an approved (cascade-active) mission. */
const APPROVED_STATE = 'approved' as const;

/** Stale-cycle fallback when a mission has no persisted `staleCycles`. */
const NO_STALE_CYCLES = 0;

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
  // Cross-Level Roll-Up (cascade)
  // -------------------------------------------------------------------------

  /**
   * List the cascade-active direct children of a mission.
   *
   * Reads every mission document and keeps those whose `parentMissionId`
   * equals `parentId` AND that are cascade-active. A mission is cascade-active
   * iff its `approval` is absent (legacy missions) OR
   * `approval.state === 'approved'`. Draft / pending_approval / rejected
   * children are excluded from the roll-up per spec §4.2.
   *
   * @param parentId - Parent mission ID
   * @returns The approved direct-child missions (empty if none / on read error)
   *
   * @example
   * ```ts
   * const children = await KRTrackingService.getInstance().listChildMissions('team-1');
   * ```
   */
  async listChildMissions(parentId: string): Promise<Mission[]> {
    const all = await this.loadAllMissions();
    return all.filter((m) => m.parentMissionId === parentId && this.isCascadeActive(m));
  }

  /**
   * Compute cross-level cascade roll-up of OKR progress for a mission and its
   * approved descendants (company → team → project).
   *
   * Recursively walks the `parentMissionId` tree. At each node it reuses
   * {@link computeMissionOKRProgress} for that node's OWN KRs, then folds in the
   * `rolledUpProgress` of each approved child:
   *
   * - `rolledUpProgress` = equal-weight average of this node's own
   *   `overallProgress` and each approved child's `rolledUpProgress`
   *   (see {@link computeRolledUpProgress}); a leaf equals its own progress.
   * - The roll-up recommendation is derived over this node's own KR statuses
   *   PLUS one synthetic status per child mapped from the child's
   *   `rolledUpProgress` via {@link deriveCascadeChildStatus} — so "all children
   *   off_track ⇒ parent escalates/replans" falls out naturally (including when
   *   children are stalled at 0% progress).
   *
   * Orphans (a mission whose `parentMissionId` points at a missing or
   * non-approved parent) are treated as roots of their own subtree and never
   * crash. A `visited` set guards against cycles defensively (create/update
   * already reject cycles).
   *
   * @param missionId - Root mission of the subtree to roll up
   * @param staleCycles - Consecutive stale review cycles for the root node. When
   *   omitted, the root's PERSISTED `staleCycles` is used so staleness-driven
   *   replan/escalate is not silently suppressed at the queried node (spec §4.2).
   *   Pass an explicit number to override the persisted value.
   * @returns The recursive {@link CascadeOKRSummary} for the subtree
   *
   * @example
   * ```ts
   * const summary = await KRTrackingService.getInstance().computeCascadeOKRProgress('co-1');
   * console.log(summary.rolledUpProgress, summary.children.length);
   * ```
   */
  async computeCascadeOKRProgress(
    missionId: string,
    staleCycles?: number,
  ): Promise<CascadeOKRSummary> {
    const all = await this.loadAllMissions();
    const byId = new Map<string, Mission>(all.map((m) => [m.id, m] as const));
    const linkById = new Map<string, Pick<Mission, 'id' | 'parentMissionId'>>(
      all.map((m) => [m.id, { id: m.id, parentMissionId: m.parentMissionId }] as const),
    );
    // Seed the root's stale cycles from its persisted value unless the caller
    // explicitly overrides it. Children read their own persisted value below.
    const rootStaleCycles =
      staleCycles ?? byId.get(missionId)?.staleCycles ?? NO_STALE_CYCLES;
    return this.rollUp(missionId, rootStaleCycles, byId, linkById, new Set<string>());
  }

  /**
   * Recursive worker for {@link computeCascadeOKRProgress}.
   *
   * @param missionId - Current node
   * @param staleCycles - Stale cycles applied to the current node only
   * @param byId - All missions indexed by ID
   * @param linkById - Lightweight parent-link map for level derivation
   * @param visited - Cycle-guard set of already-walked mission IDs
   * @returns The {@link CascadeOKRSummary} for this node's subtree
   */
  private async rollUp(
    missionId: string,
    staleCycles: number,
    byId: ReadonlyMap<string, Mission>,
    linkById: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
    visited: Set<string>,
  ): Promise<CascadeOKRSummary> {
    visited.add(missionId);

    const own = await this.computeMissionOKRProgress(missionId, staleCycles);
    const level = this.resolveLevel(missionId, byId, linkById);

    // Approved direct children that have not already been visited (cycle guard).
    const approvedChildren = [...byId.values()].filter(
      (m) =>
        m.parentMissionId === missionId &&
        this.isCascadeActive(m) &&
        !visited.has(m.id),
    );

    const children: CascadeOKRSummary[] = [];
    for (const child of approvedChildren) {
      // Child stale cycles read from its own persisted value (independent node).
      children.push(
        await this.rollUp(child.id, child.staleCycles ?? NO_STALE_CYCLES, byId, linkById, visited),
      );
    }

    const childProgresses = children.map((c) => c.rolledUpProgress);
    const rolledUpProgress = computeRolledUpProgress(own.overallProgress, childProgresses);

    // Roll-up recommendation: own KR statuses + one synthetic status per child
    // mapped from its rolled-up progress. Uses deriveCascadeChildStatus (no
    // baseline-equality short-circuit) so a child stalled at 0% reads as
    // off_track rather than not_started — otherwise an all-stalled parent would
    // never escalate/replan (spec §4.2).
    const ownStatuses = (await this.listByMission(missionId)).map((kr) => kr.status);
    const childStatuses = children.map((c) => deriveCascadeChildStatus(c.rolledUpProgress));
    const recommendation = deriveOKRRecommendation([...ownStatuses, ...childStatuses], staleCycles);

    return {
      ...own,
      recommendation,
      level,
      childMissionCount: children.length,
      rolledUpProgress,
      children,
    };
  }

  /**
   * Whether a mission counts as cascade-active: approval absent (legacy) or
   * explicitly approved.
   *
   * @param mission - Mission to test
   * @returns `true` if the mission participates in the cascade roll-up
   */
  private isCascadeActive(mission: Mission): boolean {
    return mission.approval === undefined || mission.approval.state === APPROVED_STATE;
  }

  /**
   * Resolve a mission's cascade level: prefer its explicit `level`, else derive
   * it from the parent chain via {@link deriveLevel}. Missing/orphan missions
   * fall back to `company` (treated as a root).
   *
   * @param missionId - Mission whose level to resolve
   * @param byId - All missions indexed by ID
   * @param linkById - Lightweight parent-link map for derivation
   * @returns The resolved {@link MissionLevel}
   */
  private resolveLevel(
    missionId: string,
    byId: ReadonlyMap<string, Mission>,
    linkById: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
  ): MissionLevel {
    const mission = byId.get(missionId);
    if (mission?.level) return mission.level;
    if (!mission) return 'company';
    return deriveLevel(missionId, linkById);
  }

  /**
   * Load all mission documents from disk, skipping unreadable files.
   *
   * @returns Array of missions (empty on a missing directory)
   */
  private async loadAllMissions(): Promise<Mission[]> {
    const dir = getMissionsDir();
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const missions = await Promise.all(
      files.map(async (f) => {
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8');
          return JSON.parse(raw) as Mission;
        } catch {
          return null;
        }
      }),
    );
    return missions.filter((m): m is Mission => m !== null);
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
