/**
 * Task Planning Service
 *
 * Manages file-based planning files (plan.md, findings.md, progress.md)
 * for delegated tasks. These files give agents persistent context across
 * conversation turns and session restarts.
 *
 * Key patterns implemented:
 * - Auto-create planning files when tasks are assigned
 * - Inject plan context before each agent message (first 30 lines of plan + last 15 of progress)
 * - Append progress entries after file-modifying tool calls
 * - Detect incomplete phases for auto-continuation
 *
 * @module services/agent/task-planning.service
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

// =============================================================================
// Constants
// =============================================================================

/** Number of lines from plan.md to inject as context */
const PLAN_CONTEXT_LINES = 30;

/** Number of lines from progress.md tail to inject */
const PROGRESS_TAIL_LINES = 15;

// =============================================================================
// Types
// =============================================================================

/**
 * Information needed to create planning files for a task.
 */
export interface TaskPlanInfo {
  /** Task file path (e.g. .crewly/tasks/delegated/in_progress/task_xyz.md) */
  taskFilePath: string;
  /** Task title/description */
  taskTitle: string;
  /** Priority level */
  priority: string;
  /** Assigned agent session name */
  sessionName: string;
}

/**
 * Context injection payload for the AgentRunner.
 */
export interface PlanContext {
  /** Plan header (first N lines) */
  planHeader: string;
  /** Recent progress (last N lines) */
  recentProgress: string;
  /** Combined context string for injection */
  combined: string;
}

/**
 * Result of checking task phase completion.
 */
export interface PhaseStatus {
  /** Total number of phases found in plan.md */
  totalPhases: number;
  /** Number of phases marked as complete */
  completedPhases: number;
  /** Whether all phases are done */
  allComplete: boolean;
}

// =============================================================================
// Service
// =============================================================================

/**
 * Service for managing task planning files.
 *
 * Creates and manages plan.md, findings.md, and progress.md files
 * in a directory alongside each task file.
 */
export class TaskPlanningService {
  private static instance: TaskPlanningService | null = null;

  /**
   * Get the singleton instance.
   *
   * @returns TaskPlanningService instance
   */
  static getInstance(): TaskPlanningService {
    if (!TaskPlanningService.instance) {
      TaskPlanningService.instance = new TaskPlanningService();
    }
    return TaskPlanningService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    TaskPlanningService.instance = null;
  }

  // ── File Creation ────────────────────────────────────────────────────

  /**
   * Create planning files for a newly assigned task.
   *
   * Creates a directory alongside the task file and generates:
   * - plan.md — phases with checkboxes, goal, decisions, errors
   * - findings.md — empty template for research discoveries
   * - progress.md — session log with creation timestamp
   *
   * @param info - Task information for template population
   * @returns Path to the planning directory
   */
  async createPlanningFiles(info: TaskPlanInfo): Promise<string> {
    const planDir = this.getPlanDir(info.taskFilePath);

    // Create directory if it doesn't exist
    if (!existsSync(planDir)) {
      await mkdir(planDir, { recursive: true });
    }

    const now = new Date().toISOString();

    // Write plan.md
    const planContent = this.generatePlanTemplate(info);
    await writeFile(join(planDir, 'plan.md'), planContent, 'utf8');

    // Write findings.md
    const findingsContent = `# Findings: ${info.taskTitle}

## Research Discoveries
<!-- Add discoveries, URLs, visual findings, code patterns -->

## Key Decisions
| Decision | Rationale | Date |
|----------|-----------|------|

## References
<!-- URLs, file paths, documentation links -->
`;
    await writeFile(join(planDir, 'findings.md'), findingsContent, 'utf8');

    // Write progress.md
    const progressContent = `# Progress: ${info.taskTitle}

## Session Log
- ${now}: Task assigned to ${info.sessionName}
- ${now}: Planning files created
`;
    await writeFile(join(planDir, 'progress.md'), progressContent, 'utf8');

    return planDir;
  }

  // ── Context Injection ────────────────────────────────────────────────

  /**
   * Get plan context for injection before an agent message.
   *
   * Reads the first PLAN_CONTEXT_LINES lines of plan.md and the
   * last PROGRESS_TAIL_LINES lines of progress.md to give the agent
   * persistent context about the task state.
   *
   * @param taskFilePath - Path to the task .md file
   * @returns Plan context or null if no planning files exist
   */
  async getPlanContext(taskFilePath: string): Promise<PlanContext | null> {
    const planDir = this.getPlanDir(taskFilePath);
    if (!existsSync(planDir)) return null;

    let planHeader = '';
    let recentProgress = '';

    // Read plan header (first N lines)
    try {
      const plan = await readFile(join(planDir, 'plan.md'), 'utf8');
      const lines = plan.split('\n').slice(0, PLAN_CONTEXT_LINES);
      planHeader = lines.join('\n');
    } catch {
      // No plan file
    }

    // Read recent progress (last N lines)
    try {
      const progress = await readFile(join(planDir, 'progress.md'), 'utf8');
      const lines = progress.split('\n');
      const tail = lines.slice(-PROGRESS_TAIL_LINES);
      recentProgress = tail.join('\n');
    } catch {
      // No progress file
    }

    if (!planHeader && !recentProgress) return null;

    const parts: string[] = [];
    if (planHeader) parts.push(`[TASK PLAN]\n${planHeader}`);
    if (recentProgress) parts.push(`[RECENT PROGRESS]\n${recentProgress}`);

    return {
      planHeader,
      recentProgress,
      combined: parts.join('\n\n'),
    };
  }

  // ── Progress Tracking ────────────────────────────────────────────────

  /**
   * Append a progress entry after a file-modifying tool call.
   *
   * @param taskFilePath - Path to the task .md file
   * @param toolName - Name of the tool that was called
   * @param summary - Brief description of what was done
   */
  async appendProgress(taskFilePath: string, toolName: string, summary: string): Promise<void> {
    const progressPath = join(this.getPlanDir(taskFilePath), 'progress.md');
    if (!existsSync(dirname(progressPath))) return;

    const timestamp = new Date().toISOString();
    const entry = `- ${timestamp}: ${toolName} — ${summary.slice(0, 150)}\n`;

    try {
      await appendFile(progressPath, entry);
    } catch {
      // Best effort — don't block agent execution
    }
  }

  /**
   * Append a finding to findings.md.
   *
   * @param taskFilePath - Path to the task .md file
   * @param finding - The finding text to record
   */
  async appendFinding(taskFilePath: string, finding: string): Promise<void> {
    const findingsPath = join(this.getPlanDir(taskFilePath), 'findings.md');
    if (!existsSync(dirname(findingsPath))) return;

    const timestamp = new Date().toISOString();
    const entry = `\n- [${timestamp}] ${finding}\n`;

    try {
      // Insert after "## Research Discoveries" section
      const content = await readFile(findingsPath, 'utf8');
      const marker = '## Research Discoveries';
      const idx = content.indexOf(marker);
      if (idx >= 0) {
        const insertAt = content.indexOf('\n', idx + marker.length);
        const updated = content.slice(0, insertAt + 1) + entry + content.slice(insertAt + 1);
        await writeFile(findingsPath, updated, 'utf8');
      } else {
        await appendFile(findingsPath, entry);
      }
    } catch {
      // Best effort
    }
  }

  // ── Phase Completion Check ───────────────────────────────────────────

  /**
   * Check how many phases are complete in the task plan.
   *
   * Counts phases (### Phase N) and their completion status.
   *
   * @param taskFilePath - Path to the task .md file
   * @returns Phase status or null if no plan exists
   */
  async checkPhaseStatus(taskFilePath: string): Promise<PhaseStatus | null> {
    const planPath = join(this.getPlanDir(taskFilePath), 'plan.md');

    try {
      const plan = await readFile(planPath, 'utf8');
      const totalPhases = (plan.match(/### Phase \d/g) || []).length;
      const completedPhases = (plan.match(/\*\*Status:\*\* complete/gi) || []).length;

      return {
        totalPhases,
        completedPhases,
        allComplete: totalPhases > 0 && completedPhases >= totalPhases,
      };
    } catch {
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Get the planning directory path for a task file.
   *
   * The planning directory sits alongside the task file,
   * using the task filename (without .md) as the directory name.
   *
   * @param taskFilePath - Full path to the task .md file
   * @returns Path to the planning directory
   */
  getPlanDir(taskFilePath: string): string {
    // Strip .md extension to get directory name
    const base = taskFilePath.replace(/\.md$/, '');
    return base;
  }

  /**
   * Generate the plan.md template for a task.
   *
   * @param info - Task info for template population
   * @returns Plan markdown content
   */
  private generatePlanTemplate(info: TaskPlanInfo): string {
    return `# Task Plan: ${info.taskTitle}

## Goal
${info.taskTitle}

## Priority
${info.priority}

## Assigned To
${info.sessionName}

## Current Phase
Phase 1

## Phases
### Phase 1: Analysis & Requirements
- [ ] Read and understand acceptance criteria
- [ ] Identify affected files and dependencies
- [ ] Document approach in findings.md
- **Status:** in_progress

### Phase 2: Implementation
- [ ] Write code changes
- [ ] Add/update tests (co-located)
- [ ] Ensure TypeScript clean
- **Status:** pending

### Phase 3: Verification
- [ ] Run tests — all must pass
- [ ] TypeScript clean (no errors)
- [ ] Build passes
- [ ] Manual verification
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
`;
  }
}
