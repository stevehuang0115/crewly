/**
 * OKR Cascade Service
 *
 * Owns the decompose → propose → approve/reject workflow for the OKR cascade
 * (company → team → project). A team-leader/PM agent drafts child OKRs as a
 * PROPOSAL; the child Missions are persisted with
 * `approval.state = 'pending_approval'` and are NOT cascade-active until the
 * human owner approves. Rejection carries a required reason.
 *
 * This service is the SINGLE owner of `approval.state` transitions — the
 * `updateMission` PUT route blocks direct `approval` writes so that all
 * transitions flow through {@link OKRCascadeService.approveDecomposition} and
 * {@link OKRCascadeService.rejectDecomposition} (spec §3.2/§3.3).
 *
 * FLAG (spec §2.5): the approval *workflow* (this service + its routes) is a
 * plausible future move to `crewly-pro` as a gated governance feature. The
 * approval *types* live in `mission.types.ts` and stay there; only this
 * workflow layer would relocate. Do NOT split now.
 *
 * Persistence reuses the existing on-disk layout:
 *   - Missions: `.crewly/missions/{id}.json`
 *   - KRs:      `.crewly/missions/{id}/key-results/` (via {@link KRTrackingService})
 *
 * @module services/v3/okr-cascade.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import {
  createMission,
  validateCascadeLink,
  resolveMissionLevel,
  isMission,
  isValidProposalState,
  isValidProposalTransition,
  MISSION_LEVELS,
  MISSION_LEVEL_DEPTH,
  type Mission,
  type MissionLevel,
} from '../../types/v2/mission.types.js';
import type { CreateKeyResultInput } from '../../types/v2/key-result.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Workspace root folder for Crewly runtime state. */
const CREWLY_HOME = '.crewly';

/** Folder under {@link CREWLY_HOME} that holds one JSON file per Mission. */
const MISSIONS_DIR = 'missions';

/** Proposal state stamped on a freshly-proposed child mission. */
const PROPOSED_STATE = 'pending_approval' as const;

/** Proposal state after a successful owner approval. */
const APPROVED_STATE = 'approved' as const;

/** Proposal state after an owner rejection. */
const REJECTED_STATE = 'rejected' as const;

/**
 * State a corrupt/unrecognized persisted `approval.state` is normalized to on
 * read. `rejected` is a recognized, INACTIVE, non-approvable state: a corrupt
 * doc must NOT be trusted as cascade-active and must NOT be approvable directly
 * (the only approve path is `pending_approval → approved`). See
 * {@link OKRCascadeService.sanitizeMission}.
 */
const CORRUPT_APPROVAL_FALLBACK = REJECTED_STATE;

// ---------------------------------------------------------------------------
// Inputs / Results
// ---------------------------------------------------------------------------

/**
 * A single proposed child OKR within a decomposition: one objective plus its
 * Key Results. `projectId` is required only when the resulting child level is
 * `project`.
 */
export interface DecomposeOKRChild {
  /** Objective statement for the child OKR. */
  objective: string;
  /** Strategic approach the child will pursue. */
  currentStrategy: string;
  /** Free-text success criteria (in addition to structured KRs). */
  successCriteria: string[];
  /** Required when the child level resolves to `project`. */
  projectId?: string;
  /**
   * Key Results to create under the child mission. `missionId` is filled in by
   * the service once the child mission id is known, so callers omit it.
   */
  keyResults: Array<Omit<CreateKeyResultInput, 'missionId'>>;
}

/**
 * Input to {@link OKRCascadeService.proposeDecomposition}: the set of child
 * OKRs to draft one tier below the parent mission.
 */
export interface DecomposeOKRInput {
  /** One entry per proposed child mission. */
  children: DecomposeOKRChild[];
}

/** Result of a successful {@link OKRCascadeService.proposeDecomposition} call. */
export interface ProposeResult {
  /** The parent mission that was decomposed. */
  parentId: string;
  /** Cascade level of every created child (parent level + 1). */
  childLevel: MissionLevel;
  /** IDs of the created (pending-approval) child missions. */
  childMissionIds: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Singleton service implementing the OKR decomposition / approval workflow.
 */
export class OKRCascadeService {
  private static instance: OKRCascadeService | null = null;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('OKRCascade');
  }

  /**
   * Get the singleton instance.
   *
   * @returns The shared {@link OKRCascadeService}
   */
  static getInstance(): OKRCascadeService {
    if (!OKRCascadeService.instance) {
      OKRCascadeService.instance = new OKRCascadeService();
    }
    return OKRCascadeService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    OKRCascadeService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Draft a child OKR decomposition for a parent mission as a PROPOSAL.
   *
   * The parent must exist and be cascade-active (approval absent or
   * `approval.state === 'approved'`). The child level is computed as exactly one
   * tier below the parent; decomposing a `project`-level parent is rejected
   * (there is no tier below project). Each child mission is created with
   * `approval.state = 'pending_approval'` and is NOT active until the owner
   * approves. Each child's Key Results are created via {@link KRTrackingService}
   * (no duplicate KR persistence here).
   *
   * The decomposition is "fail before writing": EVERY child is fully validated
   * (project-id presence + cascade-link adjacency/cycle) BEFORE any mission or
   * KR is persisted, so a later invalid child never leaves an earlier child
   * half-written to disk.
   *
   * @param parentId - ID of the parent mission to decompose
   * @param input - The proposed child OKRs (objectives + KRs)
   * @param proposedBy - Agent session that drafted the proposal
   * @returns The parent id, resolved child level, and created child IDs
   * @throws If the parent is missing, not approved, already at `project` level,
   *   the input has no children, or a child fails cascade-link validation
   *
   * @example
   * ```ts
   * const result = await OKRCascadeService.getInstance().proposeDecomposition(
   *   'co-1',
   *   { children: [{ objective: 'Ship v2', currentStrategy: '...', successCriteria: [], keyResults: [] }] },
   *   'team-leader-session',
   * );
   * ```
   */
  async proposeDecomposition(
    parentId: string,
    input: DecomposeOKRInput,
    proposedBy: string,
  ): Promise<ProposeResult> {
    if (!input.children || input.children.length === 0) {
      throw new Error('Decomposition requires at least one child OKR');
    }

    const all = await this.loadAllMissions();
    const byId = new Map(all.map((m) => [m.id, m] as const));

    const parent = byId.get(parentId);
    if (!parent) {
      throw new Error(`Parent mission ${parentId} does not exist`);
    }
    if (!this.isCascadeActive(parent)) {
      throw new Error(
        `Parent mission ${parentId} is not approved; only approved missions can be decomposed`,
      );
    }

    const parentLevel = this.resolveLevel(parent, byId);
    const childLevel = this.nextLevel(parentLevel);
    if (childLevel === null) {
      throw new Error(
        `A ${parentLevel}-level mission is the bottom of the cascade and cannot be decomposed further`,
      );
    }

    // ----- Pre-write validation pass (fail BEFORE any persist) -------------
    // Build every child mission up-front and run the FULL cascade guard
    // (project-id presence + validateCascadeLink) against the live tree plus
    // the siblings already built in this same proposal. Only once ALL children
    // pass do we persist anything — so a later invalid child can never leave an
    // earlier child (or its KRs) on disk (transactional "all-or-nothing").
    const now = new Date().toISOString();
    const linkById = new Map<string, Pick<Mission, 'id' | 'parentMissionId' | 'level'>>(
      all.map((m) => [m.id, { id: m.id, parentMissionId: m.parentMissionId, level: m.level }] as const),
    );
    const prepared: Array<{ mission: Mission; child: DecomposeOKRChild }> = [];

    for (const child of input.children) {
      if (childLevel === 'project' && !child.projectId) {
        throw new Error('A project-level child OKR requires projectId');
      }

      const mission = createMission({
        objective: child.objective,
        ownerTeamId: parent.ownerTeamId,
        successCriteria: child.successCriteria,
        currentStrategy: child.currentStrategy,
        parentMissionId: parentId,
        level: childLevel,
        projectId: child.projectId,
        approval: {
          state: PROPOSED_STATE,
          proposedBy,
          proposedAt: now,
        },
      });

      const reason = validateCascadeLink(mission.id, childLevel, parentId, linkById);
      if (reason) {
        throw new Error(`Invalid cascade link for child OKR "${child.objective}": ${reason}`);
      }
      // Register the just-validated child so subsequent siblings see it.
      linkById.set(mission.id, {
        id: mission.id,
        parentMissionId: mission.parentMissionId,
        level: mission.level,
      });
      prepared.push({ mission, child });
    }

    // ----- Write pass (only reached when ALL children validated) -----------
    const childMissionIds: string[] = [];
    const krService = KRTrackingService.getInstance();
    for (const { mission, child } of prepared) {
      await this.persistMission(mission);
      // KRs created via KRTrackingService — single source of KR persistence.
      for (const kr of child.keyResults) {
        await krService.create({ ...kr, missionId: mission.id });
      }
      childMissionIds.push(mission.id);
    }

    this.logger.info('Proposed OKR decomposition', {
      parentId,
      childLevel,
      childCount: childMissionIds.length,
      proposedBy,
    });

    return { parentId, childLevel, childMissionIds };
  }

  /**
   * Approve a pending decomposition proposal, making the child mission
   * cascade-active. Guarded by {@link isValidProposalTransition} so only a
   * `pending_approval` mission may transition to `approved`.
   *
   * @param missionId - ID of the proposed (pending_approval) mission
   * @param decidedBy - Human owner who approved (e.g. "steve")
   * @returns The updated mission
   * @throws If the mission is missing, has no approval state, or the
   *   `pending_approval → approved` transition is illegal
   */
  async approveDecomposition(missionId: string, decidedBy: string): Promise<Mission> {
    const mission = await this.loadMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} does not exist`);
    }
    const current = mission.approval?.state;
    if (!current) {
      throw new Error(`Mission ${missionId} has no proposal to approve`);
    }
    if (!isValidProposalTransition(current, APPROVED_STATE)) {
      throw new Error(`Cannot approve a mission in state "${current}"`);
    }

    const decided: Mission = {
      ...mission,
      approval: {
        ...mission.approval,
        state: APPROVED_STATE,
        decidedBy,
        decidedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.persistMission(decided);

    this.logger.info('Approved OKR decomposition', { missionId, decidedBy });
    return decided;
  }

  /**
   * Reject a pending decomposition proposal with a required reason. The
   * rejected mission is excluded from roll-up and autonomous execution.
   *
   * @param missionId - ID of the proposed (pending_approval) mission
   * @param decidedBy - Human owner who rejected (e.g. "steve")
   * @param reason - Non-empty explanation surfaced back to the proposing agent
   * @returns The updated mission
   * @throws If the reason is empty, the mission is missing, has no approval
   *   state, or the `pending_approval → rejected` transition is illegal
   */
  async rejectDecomposition(
    missionId: string,
    decidedBy: string,
    reason: string,
  ): Promise<Mission> {
    if (!reason || reason.trim().length === 0) {
      throw new Error('Rejection requires a non-empty reason');
    }
    const mission = await this.loadMission(missionId);
    if (!mission) {
      throw new Error(`Mission ${missionId} does not exist`);
    }
    const current = mission.approval?.state;
    if (!current) {
      throw new Error(`Mission ${missionId} has no proposal to reject`);
    }
    if (!isValidProposalTransition(current, REJECTED_STATE)) {
      throw new Error(`Cannot reject a mission in state "${current}"`);
    }

    const decided: Mission = {
      ...mission,
      approval: {
        ...mission.approval,
        state: REJECTED_STATE,
        decidedBy,
        decidedAt: new Date().toISOString(),
        rejectionReason: reason.trim(),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.persistMission(decided);

    this.logger.info('Rejected OKR decomposition', { missionId, decidedBy, reason: reason.trim() });
    return decided;
  }

  /**
   * List missions awaiting an owner decision (`approval.state ===
   * 'pending_approval'`). Optionally scope to the direct children of one parent.
   *
   * @param parentId - When provided, only pending children of this parent
   * @returns Pending-approval missions
   */
  async listPendingApprovals(parentId?: string): Promise<Mission[]> {
    const all = await this.loadAllMissions();
    return all.filter((m) => {
      if (m.approval?.state !== PROPOSED_STATE) return false;
      if (parentId !== undefined && m.parentMissionId !== parentId) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Whether a mission counts as cascade-active: approval absent (legacy) or
   * explicitly approved.
   *
   * @param mission - Mission to test
   * @returns `true` if the mission participates in the cascade
   */
  private isCascadeActive(mission: Mission): boolean {
    return mission.approval === undefined || mission.approval.state === APPROVED_STATE;
  }

  /**
   * Resolve a mission's effective level through the SINGLE canonical resolver
   * shared with the routes' read-migration ({@link resolveMissionLevel}), which
   * prefers an explicit `level` and otherwise falls back to `deriveLevel` over
   * the parent chain. A parentless legacy mission therefore resolves to
   * `company` consistently across every read path.
   *
   * @param mission - Mission whose level to resolve
   * @param byId - All missions indexed by ID for the parent-chain walk
   * @returns The mission's resolved level
   */
  private resolveLevel(
    mission: Mission,
    byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
  ): MissionLevel {
    return resolveMissionLevel(mission, byId);
  }

  /**
   * Compute the cascade level exactly one tier below the given level.
   *
   * @param level - Parent level
   * @returns The child level, or `null` if `level` is already the bottom tier
   */
  private nextLevel(level: MissionLevel): MissionLevel | null {
    const childDepth = MISSION_LEVEL_DEPTH[level] + 1;
    return MISSION_LEVELS[childDepth] ?? null;
  }

  /** Absolute path to the missions directory under the current cwd. */
  private getMissionsDir(): string {
    return path.join(process.cwd(), CREWLY_HOME, MISSIONS_DIR);
  }

  /** Absolute path to a single mission's JSON file. */
  private getMissionPath(missionId: string): string {
    return path.join(this.getMissionsDir(), `${missionId}.json`);
  }

  /**
   * Validate + normalize a parsed mission document read from disk.
   *
   * - Returns `null` for anything that is not structurally a {@link Mission}
   *   (corrupt / hand-edited / wrong shape), so callers never trust junk.
   * - When `approval` is present but `approval.state` is NOT a recognized
   *   {@link isValidProposalState}, the state is normalized to
   *   {@link CORRUPT_APPROVAL_FALLBACK} (`rejected`). This deliberately treats a
   *   corrupt governance state as INACTIVE — neither cascade-active nor a
   *   recognized pending state — rather than silently trusting an unknown
   *   string (which would otherwise be neither active nor pending and could
   *   crash transition guards).
   *
   * @param value - Raw JSON-parsed value
   * @returns A validated, normalized Mission, or `null` if not a valid Mission
   */
  private sanitizeMission(value: unknown): Mission | null {
    if (!isMission(value)) return null;
    const mission = value;
    if (mission.approval !== undefined && !isValidProposalState(mission.approval.state)) {
      this.logger.warn('Normalized corrupt approval.state to inactive', {
        missionId: mission.id,
        rawState: mission.approval.state,
      });
      return {
        ...mission,
        approval: { ...mission.approval, state: CORRUPT_APPROVAL_FALLBACK },
      };
    }
    return mission;
  }

  /**
   * Load a single mission from disk, validated + normalized via
   * {@link sanitizeMission}.
   *
   * @param missionId - Mission ID
   * @returns The mission, or `null` if missing/unreadable/not a valid Mission
   */
  private async loadMission(missionId: string): Promise<Mission | null> {
    try {
      const raw = await fs.readFile(this.getMissionPath(missionId), 'utf-8');
      return this.sanitizeMission(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Load all missions from disk, skipping unreadable AND structurally-invalid
   * files (each validated + normalized via {@link sanitizeMission}).
   *
   * @returns Array of valid missions
   */
  private async loadAllMissions(): Promise<Mission[]> {
    const dir = this.getMissionsDir();
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
          return this.sanitizeMission(JSON.parse(raw));
        } catch {
          return null;
        }
      }),
    );
    return missions.filter((m): m is Mission => m !== null);
  }

  /**
   * Persist a mission to disk (creating the missions directory if needed).
   *
   * @param mission - Mission to write
   */
  private async persistMission(mission: Mission): Promise<void> {
    const dir = this.getMissionsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.getMissionPath(mission.id), JSON.stringify(mission, null, 2));
  }
}
