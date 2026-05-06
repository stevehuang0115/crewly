/**
 * ProjectTaskWatcherService — Watches `.crewly/tasks/` for new ProjectTask files
 * and automatically creates WorkItems in the TaskPool.
 *
 * This service is on the deprecation path per
 * `specs/2026-05-06-projecttask-md-deprecation.md` (PR #482). The medium-term
 * goal is to retire the `.md` based ProjectTask system entirely so that V3
 * WorkItem is the sole source of truth for delegated work.
 *
 * **Phase 2 Workstream C — startup-backfill removed (this commit):**
 *
 * Live watch only. The legacy startup pass that scanned every existing
 * `.md` file under `delegated/{open,in_progress}/` and re-created
 * WorkItems for them was the root cause of "pool refuses to stay empty
 * after cleanup": clearing pool.json then restarting backend re-fired a
 * WI for every stale `.md` left behind. Removing the startup pass cures
 * that bug. New `.md` files written by skills (delegate-task etc.) still
 * bridge into V3 via the live chokidar handler — that path is unchanged.
 *
 * Design principle: Fire-and-forget. Errors are logged but never block normal operations.
 *
 * @module services/v3/project-task-watcher.service
 */

import * as chokidar from 'chokidar';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import { ensureDir } from '../../utils/file-io.utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce interval in ms to batch rapid file creation events. */
const WATCHER_DEBOUNCE_MS = 500;

/** Subdirectories within a milestone folder that indicate actionable tasks. */
const ACTIONABLE_STATUS_FOLDERS = ['open', 'in_progress'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata parsed from a ProjectTask markdown file.
 */
export interface ParsedProjectTask {
  /** Derived from filename (sans extension) */
  taskId: string;
  /** First H1 heading or filename */
  title: string;
  /** Full markdown content */
  description: string;
  /** Priority parsed from metadata block, defaults to 'medium' */
  priority: string;
  /** Milestone (parent directory name) */
  milestone: string;
  /** Status folder name: 'open' | 'in_progress' */
  statusFolder: string;
  /** Assigned session name, if present */
  assignedTo?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Watches the `.crewly/tasks/` directory for ProjectTask files and ensures
 * each one has a corresponding WorkItem in the TaskPool.
 *
 * @example
 * ```typescript
 * const watcher = new ProjectTaskWatcherService('/path/to/project');
 * await watcher.start();
 * // ...later:
 * watcher.dispose();
 * ```
 */
export class ProjectTaskWatcherService {
  private readonly logger: ComponentLogger;
  private readonly projectPath: string;
  private readonly tasksBaseDir: string;
  private watcher: chokidar.FSWatcher | null = null;
  private pendingFiles: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Creates a new ProjectTaskWatcherService.
   *
   * @param projectPath - Absolute path to the project root
   */
  constructor(projectPath: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('ProjectTaskWatcher');
    this.projectPath = projectPath;
    this.tasksBaseDir = path.join(projectPath, '.crewly', 'tasks');
  }

  /**
   * Starts the live file watcher.
   *
   * The historical startup-backfill pass (scan every existing `.md` under
   * `delegated/{open,in_progress}/` and re-create WIs for them) has been
   * removed — see this module's header docstring and PR #482 for the
   * deprecation rationale. New `.md` files written by skills after start
   * are still bridged into V3 via the chokidar live handler below.
   */
  async start(): Promise<void> {
    try {
      await ensureDir(this.tasksBaseDir);
    } catch {
      this.logger.warn('Tasks directory does not exist and cannot be created', {
        tasksBaseDir: this.tasksBaseDir,
      });
      return;
    }

    this.startWatcher();

    this.logger.info('ProjectTaskWatcherService started (live-watch only — startup backfill removed per PR #482)', {
      tasksBaseDir: this.tasksBaseDir,
    });
  }

  /**
   * Starts the chokidar file watcher on the tasks directory.
   * Watches for new `.md` files in any `open/` or `in_progress/` subdirectory.
   */
  private startWatcher(): void {
    // Watch pattern: .crewly/tasks/*/{open,in_progress}/*.md
    const watchPattern = path.join(this.tasksBaseDir, '**', '*.md');

    this.watcher = chokidar.watch(watchPattern, {
      ignoreInitial: true,
      persistent: true,
      depth: 3,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath: string) => {
      this.onFileAdded(filePath);
    });

    this.watcher.on('error', (err: Error) => {
      this.logger.warn('File watcher error (non-fatal)', {
        error: err.message,
      });
    });
  }

  /**
   * Handles a newly detected task file. Debounces rapid creation events.
   *
   * @param filePath - Absolute path to the new task file
   */
  private onFileAdded(filePath: string): void {
    // Only process files in actionable status folders
    const relative = path.relative(this.tasksBaseDir, filePath);
    const parts = relative.split(path.sep);

    // Expected structure: {milestone}/{statusFolder}/{filename}.md
    if (parts.length < 3) return;

    const statusFolder = parts[parts.length - 2];
    if (!ACTIONABLE_STATUS_FOLDERS.includes(statusFolder as any)) return;

    this.pendingFiles.add(filePath);
    this.scheduleDebouncedSync();
  }

  /**
   * Schedules a debounced batch sync of pending files.
   */
  private scheduleDebouncedSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();

      for (const filePath of files) {
        try {
          const relative = path.relative(this.tasksBaseDir, filePath);
          const parts = relative.split(path.sep);
          const milestone = parts[0];
          const statusFolder = parts[parts.length - 2];

          await this.ensureWorkItemForTask(filePath, milestone, statusFolder);
        } catch (err) {
          this.logger.warn('Failed to process new task file (non-fatal)', {
            filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, WATCHER_DEBOUNCE_MS);
  }

  /**
   * Ensures a WorkItem exists in the TaskPool for the given ProjectTask file.
   * If one already exists (matched by projectTaskId), this is a no-op.
   *
   * Called only from the chokidar live-watch path now that startup backfill
   * has been removed (PR #482). The previous staleness gate is no longer
   * needed because live events fire on actual file creation, not on
   * restart-time directory scans.
   *
   * @param filePath - Absolute path to the task .md file
   * @param milestone - The milestone directory name
   * @param statusFolder - The status folder name ('open' or 'in_progress')
   * @returns True if a new WorkItem was created, false if already existed
   */
  async ensureWorkItemForTask(
    filePath: string,
    milestone: string,
    statusFolder: string,
  ): Promise<boolean> {
    try {
      const parsed = await parseProjectTaskFile(filePath, milestone, statusFolder);
      if (!parsed) return false;

      const taskPool = TaskPoolService.getInstance();
      const existing = await taskPool.getAllItems();

      // Dedup: check if a WorkItem with this projectTaskId already exists
      if (existing.some((wi) => wi.projectTaskId === parsed.taskId)) {
        return false;
      }

      const workItem = createWorkItem({
        type: 'project_task',
        owner: parsed.assignedTo ? 'agent' : 'orchestrator',
        target: parsed.assignedTo,
        title: parsed.title,
        description: parsed.description.substring(0, 500),
        projectTaskId: parsed.taskId,
        maxRetries: 2,
      });

      await taskPool.addToPool(workItem);

      this.logger.info('WorkItem auto-created from ProjectTask file', {
        workItemId: workItem.id,
        taskId: parsed.taskId,
        milestone: parsed.milestone,
        status: parsed.statusFolder,
        assignedTo: parsed.assignedTo,
      });

      return true;
    } catch (err) {
      this.logger.warn('ensureWorkItemForTask failed (non-fatal)', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Stops the file watcher and cleans up resources.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pendingFiles.clear();
    this.logger.info('ProjectTaskWatcherService disposed');
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses a ProjectTask markdown file to extract metadata.
 *
 * Extracts:
 * - Title from first H1 heading or filename
 * - Priority from `**Priority**: ...` line
 * - AssignedTo from `**Assigned to**: ...` line
 *
 * @param filePath - Absolute path to the .md file
 * @param milestone - Milestone directory name
 * @param statusFolder - Status folder name
 * @returns Parsed task metadata, or null if the file is unreadable
 */
export async function parseProjectTaskFile(
  filePath: string,
  milestone: string,
  statusFolder: string,
): Promise<ParsedProjectTask | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const fileName = path.basename(filePath, '.md');

    // Extract title from first H1 heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : fileName;

    // Extract priority
    const priorityMatch = content.match(/\*\*Priority\*\*:\s*(\S+)/i);
    const priority = priorityMatch ? priorityMatch[1].toLowerCase() : 'medium';

    // Extract assigned session name
    const assignedMatch = content.match(/\*\*Assigned to\*\*:\s*(\S+)/i);
    const assignedTo = assignedMatch ? assignedMatch[1] : undefined;

    return {
      taskId: fileName,
      title,
      description: content,
      priority,
      milestone,
      statusFolder,
      assignedTo,
    };
  } catch {
    return null;
  }
}
