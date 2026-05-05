/**
 * Improvement Marker Service
 *
 * Manages a persistent marker file that tracks self-improvement
 * state across process restarts (including hot-reload).
 *
 * @module services/orchestrator/improvement-marker
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/**
 * Improvement phases
 */
export type ImprovementPhase =
  | 'planning'           // Still planning, no changes yet
  | 'backing_up'         // Creating backups
  | 'changes_applied'    // Files changed, awaiting validation
  | 'validating'         // Currently running validation
  | 'rolling_back'       // Rollback in progress
  | 'rolled_back'        // Rollback complete, needs cleanup
  | 'complete';          // All done, marker can be deleted

/**
 * File backup record
 */
export interface FileBackupRecord {
  originalPath: string;
  backupPath: string;
  checksum: string;
  existed: boolean;  // false if this is a new file
}

/**
 * Validation result
 */
export interface ValidationResult {
  check: string;
  passed: boolean;
  output?: string;
  duration?: number;
}

/**
 * Improvement marker data
 */
export interface ImprovementMarker {
  /** Unique improvement ID */
  id: string;
  /** Human-readable description */
  description: string;
  /** When improvement started */
  startedAt: string;
  /** Current phase */
  phase: ImprovementPhase;
  /** Number of times process has restarted during this improvement */
  restartCount: number;
  /** Last phase transition timestamp */
  lastUpdatedAt: string;

  /** Target files being modified */
  targetFiles: string[];

  /** Backup information */
  backup: {
    gitCommit?: string;
    gitBranch?: string;
    files: FileBackupRecord[];
    createdAt: string;
  };

  /** Planned changes */
  changes: Array<{
    file: string;
    type: 'create' | 'modify' | 'delete';
    description: string;
    applied: boolean;
  }>;

  /** Validation configuration and results */
  validation: {
    required: string[];  // ['build', 'lint', 'test']
    results: ValidationResult[];
    startedAt?: string;
    completedAt?: string;
  };

  /** Rollback information */
  rollback?: {
    reason: string;
    startedAt: string;
    completedAt?: string;
    filesRestored: string[];
    gitReset?: boolean;
  };

  /** Slack notification context */
  slack?: {
    channelId: string;
    threadTs: string;
    userId: string;
  };

  /** Error information if failed */
  error?: {
    message: string;
    phase: ImprovementPhase;
    timestamp: string;
    stack?: string;
  };
}

/**
 * Marker file paths
 */
/**
 * Default marker directory.
 *
 * Resolved via {@link getCrewlyHomePath} so test profiles isolate their
 * self-improvement marker state. Computed lazily so tests that mutate
 * `process.env.CREWLY_HOME` after module load still pick up the override.
 */
function markerDir(): string {
  return path.join(getCrewlyHomePath(), 'self-improvement');
}
const MARKER_FILE = 'pending.json';
const HISTORY_DIR = 'history';
const MAX_HISTORY = 20;

/**
 * ImprovementMarkerService class
 *
 * Manages persistent markers for tracking self-improvement state across restarts.
 */
export class ImprovementMarkerService {
  private markerPath: string;
  private historyPath: string;

  /**
   * Creates an instance of ImprovementMarkerService.
   *
   * @param baseDir - Optional base directory for marker files
   */
  constructor(baseDir?: string) {
    const base = baseDir || markerDir();
    this.markerPath = path.join(base, MARKER_FILE);
    this.historyPath = path.join(base, HISTORY_DIR);
  }

  /**
   * Initialize the marker service by creating necessary directories.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.markerPath), { recursive: true });
    await fs.mkdir(this.historyPath, { recursive: true });
  }

  /**
   * Check if there's a pending improvement.
   *
   * @returns True if a pending improvement marker exists
   */
  async hasPendingImprovement(): Promise<boolean> {
    try {
      await fs.access(this.markerPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the pending improvement marker.
   *
   * @returns The improvement marker or null if none exists
   */
  async getPendingImprovement(): Promise<ImprovementMarker | null> {
    try {
      const data = await fs.readFile(this.markerPath, 'utf-8');
      const marker = JSON.parse(data) as ImprovementMarker;
      return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new improvement marker.
   *
   * @param id - Unique improvement ID
   * @param description - Human-readable description
   * @param targetFiles - Files to be modified
   * @param slackContext - Optional Slack notification context
   * @returns The created improvement marker
   */
  async createMarker(
    id: string,
    description: string,
    targetFiles: string[],
    slackContext?: { channelId: string; threadTs: string; userId: string }
  ): Promise<ImprovementMarker> {
    const marker: ImprovementMarker = {
      id,
      description,
      startedAt: new Date().toISOString(),
      phase: 'planning',
      restartCount: 0,
      lastUpdatedAt: new Date().toISOString(),
      targetFiles,
      backup: {
        files: [],
        createdAt: '',
      },
      changes: [],
      validation: {
        required: ['build', 'lint', 'test'],
        results: [],
      },
      slack: slackContext,
    };

    await this.saveMarker(marker);
    return marker;
  }

  /**
   * Update marker phase.
   *
   * @param phase - New phase to set
   * @returns Updated marker or null if no pending marker
   */
  async updatePhase(phase: ImprovementPhase): Promise<ImprovementMarker | null> {
    const marker = await this.getPendingImprovement();
    if (!marker) return null;

    marker.phase = phase;
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
    return marker;
  }

  /**
   * Increment restart count (called on each startup).
   *
   * @returns New restart count
   */
  async incrementRestartCount(): Promise<number> {
    const marker = await this.getPendingImprovement();
    if (!marker) return 0;

    marker.restartCount++;
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
    return marker.restartCount;
  }

  /**
   * Record backup information.
   *
   * @param gitCommit - Git commit hash for checkpoint
   * @param gitBranch - Git branch name
   * @param files - File backup records
   */
  async recordBackup(
    gitCommit: string | undefined,
    gitBranch: string | undefined,
    files: FileBackupRecord[]
  ): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    marker.backup = {
      gitCommit,
      gitBranch,
      files,
      createdAt: new Date().toISOString(),
    };
    marker.phase = 'backing_up';
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Record that changes have been applied.
   *
   * @param changes - Array of applied changes
   */
  async recordChangesApplied(
    changes: Array<{ file: string; type: 'create' | 'modify' | 'delete'; description: string }>
  ): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    marker.changes = changes.map(c => ({ ...c, applied: true }));
    marker.phase = 'changes_applied';
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Record validation result.
   *
   * @param result - Validation result to record
   */
  async recordValidationResult(result: ValidationResult): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    if (marker.phase !== 'validating') {
      marker.phase = 'validating';
      marker.validation.startedAt = new Date().toISOString();
    }

    marker.validation.results.push(result);
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Record rollback started.
   *
   * @param reason - Reason for rollback
   */
  async recordRollbackStarted(reason: string): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    marker.phase = 'rolling_back';
    marker.rollback = {
      reason,
      startedAt: new Date().toISOString(),
      filesRestored: [],
    };
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Record rollback completed.
   *
   * @param filesRestored - List of restored file paths
   * @param gitReset - Whether git reset was used
   */
  async recordRollbackCompleted(filesRestored: string[], gitReset: boolean): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker || !marker.rollback) return;

    marker.phase = 'rolled_back';
    marker.rollback.completedAt = new Date().toISOString();
    marker.rollback.filesRestored = filesRestored;
    marker.rollback.gitReset = gitReset;
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Record error information.
   *
   * @param message - Error message
   * @param stack - Optional stack trace
   */
  async recordError(message: string, stack?: string): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    marker.error = {
      message,
      phase: marker.phase,
      timestamp: new Date().toISOString(),
      stack,
    };
    marker.lastUpdatedAt = new Date().toISOString();

    await this.saveMarker(marker);
  }

  /**
   * Complete the improvement (move to history).
   *
   * @param success - Whether the improvement was successful
   */
  async completeImprovement(success: boolean): Promise<void> {
    const marker = await this.getPendingImprovement();
    if (!marker) return;

    marker.phase = 'complete';
    marker.validation.completedAt = new Date().toISOString();
    marker.lastUpdatedAt = new Date().toISOString();

    // Move to history
    const historyFile = path.join(
      this.historyPath,
      `${marker.id}-${success ? 'success' : 'failed'}.json`
    );
    await fs.writeFile(historyFile, JSON.stringify(marker, null, 2));

    // Delete pending marker
    await fs.unlink(this.markerPath);

    // Cleanup old history
    await this.cleanupHistory();
  }

  /**
   * Delete marker without saving to history (for cancelled improvements).
   */
  async deleteMarker(): Promise<void> {
    try {
      await fs.unlink(this.markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Save marker to disk atomically.
   *
   * @param marker - Marker to save
   */
  private async saveMarker(marker: ImprovementMarker): Promise<void> {
    const tempPath = `${this.markerPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(marker, null, 2));
    await fs.rename(tempPath, this.markerPath);
  }

  /**
   * Cleanup old history files to maintain max limit.
   */
  private async cleanupHistory(): Promise<void> {
    try {
      const files = await fs.readdir(this.historyPath);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();

      for (const file of jsonFiles.slice(MAX_HISTORY)) {
        await fs.unlink(path.join(this.historyPath, file));
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get improvement history.
   *
   * @param limit - Maximum number of history items to return
   * @returns Array of historical improvement markers
   */
  async getHistory(limit: number = 10): Promise<ImprovementMarker[]> {
    try {
      const files = await fs.readdir(this.historyPath);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();

      const history: ImprovementMarker[] = [];
      for (const file of jsonFiles.slice(0, limit)) {
        const data = await fs.readFile(path.join(this.historyPath, file), 'utf-8');
        history.push(JSON.parse(data));
      }

      return history;
    } catch {
      return [];
    }
  }
}

/**
 * Singleton instance
 */
let markerServiceInstance: ImprovementMarkerService | null = null;

/**
 * Get singleton instance of ImprovementMarkerService.
 *
 * @returns The singleton ImprovementMarkerService instance
 */
export function getImprovementMarkerService(): ImprovementMarkerService {
  if (!markerServiceInstance) {
    markerServiceInstance = new ImprovementMarkerService();
  }
  return markerServiceInstance;
}

/**
 * Reset singleton instance (for testing).
 */
export function resetImprovementMarkerService(): void {
  markerServiceInstance = null;
}
