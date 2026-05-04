/**
 * Teams Backup Service
 *
 * Provides automatic backup and restore functionality for teams data.
 *
 * Two layers of durability:
 *  1. **Live single-file backup** (`teams-backup.json`) — preserved for
 *     backward compat with the existing status / restore endpoints.
 *  2. **Rotating ring buffer** (N=30 snapshots in `teams-backup-history/`) —
 *     introduced by Persistence P0 (A2). Even if a corrupting save propagates
 *     to the live backup, the previous N-1 slots remain intact.
 *
 * @module services/core/teams-backup.service
 */

import * as path from 'path';
import * as os from 'os';
import type { Team } from '../../types/index.js';
import { LoggerService, ComponentLogger } from './logger.service.js';
import { atomicWriteJson, safeReadJson, ensureDir } from '../../utils/file-io.utils.js';
import {
  atomicWriteJsonWithGuard,
  IntegrityViolationError,
} from '../../utils/integrity-guarded-write.utils.js';

/** File name for the live (most-recent) teams backup */
const BACKUP_FILENAME = 'teams-backup.json';
/** Subdirectory under crewlyHome that stores rotating snapshots */
const HISTORY_SUBDIR = 'teams-backup-history';
/** File name of the ring-buffer index */
const HISTORY_INDEX_FILENAME = 'index.json';
/** Number of rotating snapshot slots to retain. */
export const MAX_HISTORY_SLOTS = 30;

/**
 * Shape of the backup file
 */
export interface TeamsBackup {
  /** ISO timestamp of when the backup was written */
  timestamp: string;
  /** Full team objects at time of backup */
  teams: Team[];
}

/**
 * Status returned by getBackupStatus
 */
export interface TeamsBackupStatus {
  /** Whether current teams are empty but backup has data */
  hasMismatch: boolean;
  /** Number of teams in the backup file */
  backupTeamCount: number;
  /** Number of teams currently in storage */
  currentTeamCount: number;
  /** ISO timestamp of the most recent backup */
  backupTimestamp: string | null;
}

/**
 * Single entry in the rotating-snapshot history.
 */
export interface TeamsBackupHistoryEntry {
  /** Slot index (0..MAX_HISTORY_SLOTS-1) */
  slot: number;
  /** ISO timestamp the snapshot was written */
  timestamp: string;
  /** Number of teams captured in the snapshot */
  teamCount: number;
  /** Whether this slot is the most recently written one */
  isHead: boolean;
}

/**
 * On-disk index that tracks the ring buffer.
 */
export interface TeamsBackupHistoryIndex {
  /** Slot index of the most recently written snapshot. -1 = empty. */
  head: number;
  /** Total snapshots written ever (monotonic; not the current count). */
  written: number;
  /** Per-slot metadata. Slots without data are omitted. */
  slots: Record<number, { timestamp: string; teamCount: number }>;
}

/**
 * Format a slot index as a zero-padded 3-digit string for filenames.
 *
 * @param slot - Slot index 0..MAX_HISTORY_SLOTS-1
 * @returns Zero-padded slot string, e.g. '007'
 */
function pad3(slot: number): string {
  return slot.toString().padStart(3, '0');
}

/**
 * TeamsBackupService manages the live single-file backup AND a rotating
 * ring buffer of historical snapshots.
 *
 * @example
 * ```typescript
 * const backupService = TeamsBackupService.getInstance();
 * await backupService.updateBackup(teams);
 * const status = await backupService.getBackupStatus(currentTeams);
 * const history = await backupService.getBackupHistory();
 * const snapshot = await backupService.restoreFromSlot(2);
 * ```
 */
export class TeamsBackupService {
  private static instance: TeamsBackupService | null = null;

  private backupPath: string;
  private historyDir: string;
  private historyIndexPath: string;
  private logger: ComponentLogger;

  /**
   * Create a new TeamsBackupService.
   *
   * @param crewlyHome - Path to the .crewly home directory
   */
  constructor(crewlyHome?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('TeamsBackupService');
    const home = crewlyHome || path.join(os.homedir(), '.crewly');
    this.backupPath = path.join(home, BACKUP_FILENAME);
    this.historyDir = path.join(home, HISTORY_SUBDIR);
    this.historyIndexPath = path.join(this.historyDir, HISTORY_INDEX_FILENAME);
  }

  /**
   * Get singleton instance.
   *
   * @param crewlyHome - Optional override for the home directory
   * @returns TeamsBackupService instance
   */
  static getInstance(crewlyHome?: string): TeamsBackupService {
    if (!TeamsBackupService.instance) {
      TeamsBackupService.instance = new TeamsBackupService(crewlyHome);
    }
    return TeamsBackupService.instance;
  }

  /**
   * Clear singleton instance (for testing).
   */
  static clearInstance(): void {
    TeamsBackupService.instance = null;
  }

  /**
   * Write or update the backup file with the current teams data.
   * Called after every successful saveTeam() or deleteTeam().
   *
   * Writes both the live single-file backup AND a new rotating-snapshot
   * slot. If history rotation fails, the live backup still proceeds —
   * we never want a history-write bug to block the primary durability path.
   *
   * @param teams - Current full list of teams
   */
  async updateBackup(teams: Team[]): Promise<void> {
    // 1. Rotating snapshot (best-effort; never throws to caller)
    try {
      await this.writeRotatingSnapshot(teams);
    } catch (error) {
      this.logger.warn('Failed to write rotating snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 2. Live single-file backup (integrity-guarded — refuses to wipe out
    //    a previously healthy backup with an empty teams list).
    try {
      const backup: TeamsBackup = {
        timestamp: new Date().toISOString(),
        teams,
      };
      await atomicWriteJsonWithGuard<TeamsBackup>(this.backupPath, backup, {
        // backup file is shaped {timestamp, teams[]} — count by teams.length
        countOf: (b) => (b && Array.isArray(b.teams) ? b.teams.length : 0),
      });
      this.logger.debug('Teams backup updated', { teamCount: teams.length });
    } catch (error) {
      if (error instanceof IntegrityViolationError) {
        this.logger.error(
          'Teams backup integrity guard rejected write — keeping prior healthy backup',
          {
            path: error.path,
            prevCount: error.prevCount,
            nextCount: error.nextCount,
            reason: error.reason,
          }
        );
      } else {
        this.logger.warn('Failed to update teams backup', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Read the backup file from disk.
   *
   * @returns The parsed backup or null if no backup exists
   */
  async readBackup(): Promise<TeamsBackup | null> {
    return safeReadJson<TeamsBackup | null>(this.backupPath, null, this.logger);
  }

  /**
   * Check whether current teams data is empty but backup has data.
   *
   * @param currentTeams - The current teams from storage
   * @returns Backup status with mismatch flag
   */
  async getBackupStatus(currentTeams: Team[]): Promise<TeamsBackupStatus> {
    const backup = await this.readBackup();

    if (!backup) {
      return {
        hasMismatch: false,
        backupTeamCount: 0,
        currentTeamCount: currentTeams.length,
        backupTimestamp: null,
      };
    }

    return {
      hasMismatch: currentTeams.length === 0 && backup.teams.length > 0,
      backupTeamCount: backup.teams.length,
      currentTeamCount: currentTeams.length,
      backupTimestamp: backup.timestamp,
    };
  }

  /**
   * Get the backup file path (for testing).
   *
   * @returns Absolute path to the backup file
   */
  getBackupPath(): string {
    return this.backupPath;
  }

  /**
   * Get the history directory path (for testing).
   *
   * @returns Absolute path to the rotating-snapshot directory
   */
  getHistoryDir(): string {
    return this.historyDir;
  }

  /**
   * List all populated rotating-snapshot slots, newest first.
   *
   * @returns Array of slot metadata. Empty array if history is empty.
   */
  async getBackupHistory(): Promise<TeamsBackupHistoryEntry[]> {
    const index = await this.readHistoryIndex();
    if (!index || index.written === 0) {
      return [];
    }

    const entries: TeamsBackupHistoryEntry[] = Object.entries(index.slots).map(([slotStr, meta]) => ({
      slot: Number(slotStr),
      timestamp: meta.timestamp,
      teamCount: meta.teamCount,
      isHead: Number(slotStr) === index.head,
    }));

    // Newest-first: head slot first, then by timestamp descending.
    entries.sort((a, b) => {
      if (a.isHead) return -1;
      if (b.isHead) return 1;
      return b.timestamp.localeCompare(a.timestamp);
    });
    return entries;
  }

  /**
   * Read a single rotating-snapshot slot.
   *
   * @param slot - Slot index 0..MAX_HISTORY_SLOTS-1
   * @returns Parsed snapshot or null if slot is empty / corrupted
   */
  async readSlot(slot: number): Promise<TeamsBackup | null> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_HISTORY_SLOTS) {
      return null;
    }
    const slotPath = path.join(this.historyDir, `teams-backup-${pad3(slot)}.json`);
    return safeReadJson<TeamsBackup | null>(slotPath, null, this.logger);
  }

  /**
   * Restore from a specific rotating-snapshot slot. The caller is
   * responsible for re-saving each team via StorageService — this method
   * just returns the snapshot contents.
   *
   * @param slot - Slot index 0..MAX_HISTORY_SLOTS-1
   * @returns Snapshot to restore, or null if slot is empty
   */
  async restoreFromSlot(slot: number): Promise<TeamsBackup | null> {
    return this.readSlot(slot);
  }

  // ──────────────────────────────────────────────────────────────────
  //  Internal: rotating snapshot machinery
  // ──────────────────────────────────────────────────────────────────

  /**
   * Read the rotating-snapshot index from disk.
   *
   * @returns Parsed index or null if it does not exist / is corrupted
   */
  private async readHistoryIndex(): Promise<TeamsBackupHistoryIndex | null> {
    return safeReadJson<TeamsBackupHistoryIndex | null>(this.historyIndexPath, null, this.logger);
  }

  /**
   * Write a new rotating snapshot, advancing the head pointer.
   *
   * Order matters: snapshot file written FIRST, then index. If the process
   * dies between the two writes, we end up with an unreferenced slot file
   * (harmless) rather than an index pointing at a half-written slot.
   *
   * @param teams - Teams to snapshot into the new slot
   */
  private async writeRotatingSnapshot(teams: Team[]): Promise<void> {
    await ensureDir(this.historyDir);

    const prevIndex = (await this.readHistoryIndex()) ?? this.emptyIndex();
    const nextSlot = prevIndex.written === 0 ? 0 : (prevIndex.head + 1) % MAX_HISTORY_SLOTS;
    const timestamp = new Date().toISOString();

    const slotPath = path.join(this.historyDir, `teams-backup-${pad3(nextSlot)}.json`);
    const snapshot: TeamsBackup = { timestamp, teams };
    await atomicWriteJson(slotPath, snapshot);

    const nextIndex: TeamsBackupHistoryIndex = {
      head: nextSlot,
      written: prevIndex.written + 1,
      slots: {
        ...prevIndex.slots,
        [nextSlot]: { timestamp, teamCount: teams.length },
      },
    };
    await atomicWriteJson(this.historyIndexPath, nextIndex);

    this.logger.debug('Rotating snapshot written', {
      slot: nextSlot,
      teamCount: teams.length,
      writtenTotal: nextIndex.written,
    });
  }

  /**
   * @returns A fresh empty history index (head=-1, no slots).
   */
  private emptyIndex(): TeamsBackupHistoryIndex {
    return { head: -1, written: 0, slots: {} };
  }
}
