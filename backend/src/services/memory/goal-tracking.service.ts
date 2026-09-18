/**
 * Goal Tracking Service
 *
 * Manages project-level goal files, current team focus, and a decisions log
 * with retrospective outcomes. All files are stored as Markdown under
 * `{projectPath}/.crewly/goals/`.
 *
 * Files managed:
 * - `goals.md` — Append-only log of user-stated goals
 * - `current_focus.md` — Overwritten each time the team focus changes
 * - `decisions_log.md` — Append-only decisions with mutable outcome sections
 *
 * @module services/memory/goal-tracking.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDir, atomicWriteFile } from '../../utils/file-io.utils.js';
import { MEMORY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';

/**
 * Parameters for logging a decision via {@link GoalTrackingService.logDecision}.
 */
export interface DecisionParams {
  /** Short descriptive title for the decision */
  title: string;
  /** The decision that was made */
  decision: string;
  /** Reasoning behind the decision */
  rationale: string;
  /** Agent or user who made the decision */
  decidedBy: string;
  /** Alternative options that were considered */
  alternatives?: string[];
}

/**
 * Service for tracking project goals, team focus, and architectural decisions.
 *
 * Follows the singleton pattern for consistent state management across
 * the backend. Uses atomic writes for full-file overwrites and plain
 * `fs.appendFile` for append-only logs (goals, decisions) where partial
 * writes are acceptable.
 *
 * @example
 * ```typescript
 * const goalService = GoalTrackingService.getInstance();
 *
 * // Set a project goal
 * await goalService.setGoal('/path/to/project', 'Ship v2.0 by March 15th', 'user');
 *
 * // Update team focus
 * await goalService.updateFocus('/path/to/project', 'Completing auth module');
 *
 * // Log a decision
 * const decId = await goalService.logDecision('/path/to/project', {
 *   title: 'Use PostgreSQL over MongoDB',
 *   decision: 'PostgreSQL for primary data store',
 *   rationale: 'Relational data model fits our schema better',
 *   decidedBy: 'orchestrator',
 *   alternatives: ['MongoDB', 'DynamoDB'],
 * });
 *
 * // Later, record the outcome
 * await goalService.updateDecisionOutcome(
 *   '/path/to/project',
 *   decId,
 *   'Successful - query performance is excellent',
 *   'Invest time in schema design upfront to avoid migrations',
 * );
 * ```
 */
export class GoalTrackingService {
  private static instance: GoalTrackingService | null = null;

  /** Monotonic counter to ensure unique decision IDs even within the same millisecond */
  private decisionCounter = 0;

  private readonly logger = LoggerService.getInstance().createComponentLogger('GoalTrackingService');

  /**
   * Creates a new GoalTrackingService instance.
   * Use {@link getInstance} for the singleton.
   */
  private constructor() {
    // No initialization needed — all paths are derived from projectPath at call time
  }

  /**
   * Gets the singleton instance of GoalTrackingService.
   *
   * @returns The singleton GoalTrackingService instance
   */
  public static getInstance(): GoalTrackingService {
    if (!GoalTrackingService.instance) {
      GoalTrackingService.instance = new GoalTrackingService();
    }
    return GoalTrackingService.instance;
  }

  /**
   * Clears the singleton instance.
   * Intended for test isolation only — never call in production.
   */
  public static clearInstance(): void {
    GoalTrackingService.instance = null;
  }

  // ========================= HELPERS =========================

  /**
   * Returns the absolute path to the goals directory for a project.
   *
   * @param projectPath - Absolute path to the project root
   * @returns Absolute path to `{projectPath}/.crewly/goals`
   */
  private getGoalsDir(projectPath: string): string {
    return path.join(resolveProjectDataDir(projectPath), MEMORY_CONSTANTS.PATHS.GOALS_DIR);
  }

  /**
   * Safely reads a file and returns its content, or `null` if the file
   * does not exist.
   *
   * Permission errors and other unexpected failures are re-thrown.
   *
   * @param filePath - Absolute path to the file
   * @returns File content as a UTF-8 string, or `null` if not found
   */
  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Appends a new goal entry to `goals.md`.
   *
   * If the file does not yet exist it is created with a Markdown header
   * before the first entry is appended.
   *
   * @param projectPath - Absolute path to the project root
   * @param goal - The goal text to record
   * @param setBy - Who set the goal (defaults to `'user'`)
   *
   * @example
   * ```typescript
   * await goalService.setGoal('/projects/phoenix', 'Achieve 80% test coverage', 'user');
   * ```
   */
  public async setGoal(projectPath: string, goal: string, setBy: string = 'user'): Promise<void> {
    const goalsDir = this.getGoalsDir(projectPath);
    await ensureDir(goalsDir);

    const goalsFile = path.join(goalsDir, MEMORY_CONSTANTS.PATHS.GOALS_FILE);
    const existing = await this.safeReadFile(goalsFile);

    const timestamp = new Date().toISOString();
    const entry = `\n### [${timestamp}] Set by ${setBy}\n${goal}\n`;

    if (existing === null) {
      const header = `# Project Goals\n\n`;
      await fs.writeFile(goalsFile, header + entry, 'utf-8');
      this.logger.debug('Created goals file with first entry', { projectPath, setBy });
    } else {
      await fs.appendFile(goalsFile, entry, 'utf-8');
      this.logger.debug('Appended goal entry', { projectPath, setBy });
    }
  }

  /**
   * Reads and returns the full contents of `goals.md`.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The goals file content, or `null` if the file does not exist
   *
   * @example
   * ```typescript
   * const goals = await goalService.getGoals('/projects/phoenix');
   * if (goals) {
   *   console.log(goals);
   * }
   * ```
   */
  public async getGoals(projectPath: string): Promise<string | null> {
    const goalsFile = path.join(this.getGoalsDir(projectPath), MEMORY_CONSTANTS.PATHS.GOALS_FILE);
    return this.safeReadFile(goalsFile);
  }

  /**
   * Overwrites `current_focus.md` with the new focus description.
   *
   * Uses {@link atomicWriteFile} to ensure the file is never left in a
   * partial-write state.
   *
   * @param projectPath - Absolute path to the project root
   * @param focus - The new focus description
   * @param updatedBy - Who updated the focus (defaults to `'orchestrator'`)
   *
   * @example
   * ```typescript
   * await goalService.updateFocus(
   *   '/projects/phoenix',
   *   'Completing the authentication module and writing integration tests',
   *   'orchestrator',
   * );
   * ```
   */
  public async updateFocus(projectPath: string, focus: string, updatedBy: string = 'orchestrator'): Promise<void> {
    const goalsDir = this.getGoalsDir(projectPath);
    await ensureDir(goalsDir);

    const focusFile = path.join(goalsDir, MEMORY_CONSTANTS.PATHS.FOCUS_FILE);
    const timestamp = new Date().toISOString();

    const content =
      `# Current Focus\n` +
      `\n` +
      `**Updated:** ${timestamp}\n` +
      `**By:** ${updatedBy}\n` +
      `\n` +
      `${focus}\n`;

    await atomicWriteFile(focusFile, content);
    this.logger.debug('Updated current focus', { projectPath, updatedBy });
  }

  /**
   * Reads and returns the full contents of `current_focus.md`.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The current focus file content, or `null` if the file does not exist
   *
   * @example
   * ```typescript
   * const focus = await goalService.getCurrentFocus('/projects/phoenix');
   * ```
   */
  public async getCurrentFocus(projectPath: string): Promise<string | null> {
    const focusFile = path.join(this.getGoalsDir(projectPath), MEMORY_CONSTANTS.PATHS.FOCUS_FILE);
    return this.safeReadFile(focusFile);
  }

  /**
   * Appends a new decision entry to `decisions_log.md` and returns a
   * unique decision ID.
   *
   * If the file does not yet exist it is created with a Markdown header
   * before the first entry is appended.
   *
   * The outcome field is initially set to `_pending_` and can be updated
   * later via {@link updateDecisionOutcome}.
   *
   * @param projectPath - Absolute path to the project root
   * @param decision - Decision parameters (title, decision, rationale, etc.)
   * @returns The generated decision ID (format: `dec-{timestamp}-{counter}`)
   *
   * @throws {Error} If the file system write fails
   *
   * @example
   * ```typescript
   * const decisionId = await goalService.logDecision('/projects/phoenix', {
   *   title: 'Use Redis for caching',
   *   decision: 'Redis over Memcached',
   *   rationale: 'Better data structure support and persistence options',
   *   decidedBy: 'orchestrator',
   *   alternatives: ['Memcached', 'In-memory Map'],
   * });
   * // decisionId => 'dec-1707500000000-0'
   * ```
   */
  public async logDecision(projectPath: string, decision: DecisionParams): Promise<string> {
    const goalsDir = this.getGoalsDir(projectPath);
    await ensureDir(goalsDir);

    const decisionsFile = path.join(goalsDir, MEMORY_CONSTANTS.PATHS.DECISIONS_LOG);
    const existing = await this.safeReadFile(decisionsFile);

    const timestamp = new Date().toISOString();
    const decisionId = `dec-${Date.now()}-${this.decisionCounter++}`;
    const alternativesText = decision.alternatives?.join(', ') || 'None recorded';

    const entry =
      `\n## [${decisionId}] ${decision.title}\n` +
      `**Date:** ${timestamp}\n` +
      `**By:** ${decision.decidedBy}\n` +
      `**Decision:** ${decision.decision}\n` +
      `**Rationale:** ${decision.rationale}\n` +
      `**Alternatives:** ${alternativesText}\n` +
      `**Outcome:** _pending_\n` +
      `\n---\n`;

    if (existing === null) {
      const header = `# Decisions Log\n\n`;
      await fs.writeFile(decisionsFile, header + entry, 'utf-8');
      this.logger.debug('Created decisions log with first entry', { projectPath, decisionId });
    } else {
      await fs.appendFile(decisionsFile, entry, 'utf-8');
      this.logger.debug('Appended decision entry', { projectPath, decisionId });
    }

    return decisionId;
  }

  /**
   * Updates the outcome of a previously logged decision.
   *
   * Reads `decisions_log.md`, locates the section matching the given
   * `decisionId`, replaces the `**Outcome:** _pending_` line with the
   * actual outcome (plus optional learnings and a timestamp), and writes
   * the file back atomically.
   *
   * If the decision ID is not found or the file does not exist, a warning
   * is logged and the method returns without throwing.
   *
   * @param projectPath - Absolute path to the project root
   * @param decisionId - The decision ID returned by {@link logDecision}
   * @param outcome - Description of the actual outcome
   * @param learnings - Optional lessons learned from this decision
   *
   * @example
   * ```typescript
   * await goalService.updateDecisionOutcome(
   *   '/projects/phoenix',
   *   'dec-1707500000000',
   *   'Successful - Redis reduced API latency by 40%',
   *   'Set explicit TTLs on all cache keys to prevent stale data',
   * );
   * ```
   */
  public async updateDecisionOutcome(
    projectPath: string,
    decisionId: string,
    outcome: string,
    learnings?: string,
  ): Promise<void> {
    const decisionsFile = path.join(this.getGoalsDir(projectPath), MEMORY_CONSTANTS.PATHS.DECISIONS_LOG);
    const content = await this.safeReadFile(decisionsFile);

    if (content === null) {
      this.logger.warn('Decisions log not found, cannot update outcome', { projectPath, decisionId });
      return;
    }

    // Verify the decision ID exists in the file
    if (!content.includes(`[${decisionId}]`)) {
      this.logger.warn('Decision ID not found in decisions log', { projectPath, decisionId });
      return;
    }

    const timestamp = new Date().toISOString();
    const learningsText = learnings || 'None recorded';
    const replacement =
      `**Outcome:** ${outcome}\n` +
      `**Learnings:** ${learningsText}\n` +
      `**Recorded:** ${timestamp}`;

    // Replace the first occurrence of _pending_ that belongs to this decision.
    // We find the decision section header then replace the pending outcome within it.
    const sectionMarker = `[${decisionId}]`;
    const sectionStart = content.indexOf(sectionMarker);

    if (sectionStart === -1) {
      this.logger.warn('Decision section not found', { projectPath, decisionId });
      return;
    }

    // Find the **Outcome:** _pending_ line within this decision's section
    const pendingPattern = '**Outcome:** _pending_';
    const pendingIndex = content.indexOf(pendingPattern, sectionStart);

    if (pendingIndex === -1) {
      this.logger.warn('Decision outcome already recorded or not in pending state', { projectPath, decisionId });
      return;
    }

    const updatedContent =
      content.substring(0, pendingIndex) +
      replacement +
      content.substring(pendingIndex + pendingPattern.length);

    await atomicWriteFile(decisionsFile, updatedContent);
    this.logger.debug('Updated decision outcome', { projectPath, decisionId });
  }

  /**
   * Reads and returns the full contents of `decisions_log.md`.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The decisions log content, or `null` if the file does not exist
   *
   * @example
   * ```typescript
   * const log = await goalService.getDecisionsLog('/projects/phoenix');
   * if (log) {
   *   console.log(log);
   * }
   * ```
   */
  public async getDecisionsLog(projectPath: string): Promise<string | null> {
    const decisionsFile = path.join(this.getGoalsDir(projectPath), MEMORY_CONSTANTS.PATHS.DECISIONS_LOG);
    return this.safeReadFile(decisionsFile);
  }
}
