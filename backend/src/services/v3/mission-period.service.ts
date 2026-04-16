/**
 * Mission Period Lifecycle Service
 *
 * Manages automatic activation and deactivation of Missions based on
 * their OKR period (weekly, monthly, quarterly, etc.).
 *
 * Responsibilities:
 * - Activate missions whose period has started (paused → active)
 * - Trigger end-of-period review for missions whose period has ended
 * - Filter missions by current/future/past period
 * - Sort missions by priority for scheduling
 *
 * Runs as part of the cron evaluation loop — called periodically
 * to reconcile mission statuses with their time periods.
 *
 * @module services/v3/mission-period.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Mission, MissionPeriod, MissionStatus } from '../../types/v2/mission.types.js';
import {
  isPeriodActive,
  isPeriodPast,
  isPeriodFuture,
  sortMissionsByPriority,
  TERMINAL_MISSION_STATUSES,
} from '../../types/v2/mission.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a period reconciliation cycle. */
export interface PeriodReconcileResult {
  /** Missions activated because their period started */
  activated: string[];
  /** Missions that reached end-of-period and need review */
  endOfPeriod: string[];
  /** Total missions evaluated */
  evaluated: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for reconciling Mission lifecycle with OKR time periods.
 */
export class MissionPeriodService {
  private static instance: MissionPeriodService | null = null;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('MissionPeriod');
  }

  static getInstance(): MissionPeriodService {
    if (!MissionPeriodService.instance) {
      MissionPeriodService.instance = new MissionPeriodService();
    }
    return MissionPeriodService.instance;
  }

  static resetInstance(): void {
    MissionPeriodService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Period Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile all missions with time periods against the current date.
   *
   * - Paused missions whose period is now active → activate
   * - Active missions whose period has ended → mark for end-of-period review
   * - Terminal missions are skipped
   *
   * @param now - Reference date (defaults to current time)
   * @returns Summary of actions taken
   */
  async reconcile(now?: Date): Promise<PeriodReconcileResult> {
    const ref = now ?? new Date();
    const missions = await this.loadAllMissions();
    const result: PeriodReconcileResult = {
      activated: [],
      endOfPeriod: [],
      evaluated: 0,
    };

    for (const mission of missions) {
      // Skip missions without a period — they use manual lifecycle
      if (!mission.period) continue;
      // Skip terminal missions
      if (TERMINAL_MISSION_STATUSES.has(mission.status)) continue;

      result.evaluated++;

      if (mission.status === 'paused' && isPeriodActive(mission.period, ref)) {
        // Period has started — activate the mission
        await this.updateMissionStatus(mission.id, 'active');
        result.activated.push(mission.id);
        this.logger.info('Mission auto-activated — period started', {
          missionId: mission.id,
          period: mission.period.label ?? mission.period.type,
        });
      } else if (mission.status === 'active' && isPeriodPast(mission.period, ref)) {
        // Period has ended — flag for end-of-period review
        result.endOfPeriod.push(mission.id);
        this.logger.info('Mission period ended — triggering review', {
          missionId: mission.id,
          period: mission.period.label ?? mission.period.type,
        });
      }
    }

    if (result.activated.length > 0 || result.endOfPeriod.length > 0) {
      this.logger.info('Period reconciliation complete', {
        evaluated: result.evaluated,
        activated: result.activated.length,
        endOfPeriod: result.endOfPeriod.length,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Query Helpers
  // -------------------------------------------------------------------------

  /**
   * Get all active missions for the current period, sorted by priority.
   *
   * @param now - Reference date (defaults to current time)
   * @returns Missions whose period contains 'now' and status is 'active', sorted by priority
   */
  async getActivePeriodMissions(now?: Date): Promise<Mission[]> {
    const ref = now ?? new Date();
    const missions = await this.loadAllMissions();
    const active = missions.filter((m) => {
      if (m.status !== 'active') return false;
      // Missions without a period are always considered "in period"
      if (!m.period) return true;
      return isPeriodActive(m.period, ref);
    });
    return sortMissionsByPriority(active);
  }

  /**
   * Get missions for a specific team, filtered by period status and sorted by priority.
   *
   * @param teamId - Team to filter by
   * @param periodFilter - 'current', 'future', 'past', or 'all'
   * @param now - Reference date
   * @returns Filtered and sorted missions
   */
  async getMissionsByTeamAndPeriod(
    teamId: string,
    periodFilter: 'current' | 'future' | 'past' | 'all' = 'all',
    now?: Date,
  ): Promise<Mission[]> {
    const ref = now ?? new Date();
    const missions = await this.loadAllMissions();

    const teamMissions = missions.filter((m) => m.ownerTeamId === teamId);

    let filtered: Mission[];
    switch (periodFilter) {
      case 'current':
        filtered = teamMissions.filter((m) =>
          !m.period || isPeriodActive(m.period, ref),
        );
        break;
      case 'future':
        filtered = teamMissions.filter((m) =>
          m.period && isPeriodFuture(m.period, ref),
        );
        break;
      case 'past':
        filtered = teamMissions.filter((m) =>
          m.period && isPeriodPast(m.period, ref),
        );
        break;
      default:
        filtered = teamMissions;
    }

    return sortMissionsByPriority(filtered);
  }

  // -------------------------------------------------------------------------
  // Storage Helpers
  // -------------------------------------------------------------------------

  /**
   * Load all missions from disk.
   */
  private async loadAllMissions(): Promise<Mission[]> {
    const dir = getMissionsDir();
    try {
      const files = await fs.readdir(dir);
      const missions: Mission[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          missions.push(JSON.parse(raw) as Mission);
        } catch {
          // Skip corrupt files
        }
      }
      return missions;
    } catch {
      return [];
    }
  }

  /**
   * Update a mission's status on disk.
   */
  private async updateMissionStatus(missionId: string, status: MissionStatus): Promise<void> {
    const filePath = path.join(getMissionsDir(), `${missionId}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const mission = JSON.parse(raw) as Mission;
      mission.status = status;
      mission.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath, JSON.stringify(mission, null, 2));
    } catch {
      this.logger.error('Failed to update mission status', { missionId, status });
    }
  }
}
