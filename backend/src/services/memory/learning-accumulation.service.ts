/**
 * Learning Accumulation Service
 *
 * Manages persistent learning files at two levels:
 * - **Project-level:** `{projectPath}/.crewly/learning/what_worked.md` and `what_failed.md`
 * - **Global-level:** `~/.crewly/learning/cross_project_insights.md`
 *
 * Learning entries are appended as timestamped markdown sections so agents can
 * review past successes, failures, and cross-project insights when starting
 * new tasks or resuming work.
 *
 * @module services/memory/learning-accumulation.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ensureDir } from '../../utils/file-io.utils.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/**
 * Header written to a new `what_worked.md` file upon first success recording
 */
const WHAT_WORKED_HEADER = '# What Worked\n\nSuccessful patterns, approaches, and solutions.\n\n';

/**
 * Header written to a new `what_failed.md` file upon first failure recording
 */
const WHAT_FAILED_HEADER = '# What Failed\n\nFailed approaches, pitfalls, and things to avoid.\n\n';

/**
 * Header written to a new `cross_project_insights.md` file upon first insight recording
 */
const CROSS_PROJECT_INSIGHTS_HEADER = '# Cross-Project Insights\n\nLearnings that apply across multiple projects.\n\n';

/**
 * Service for accumulating learning entries into markdown files
 *
 * Follows the singleton pattern for consistent state management.
 * Entries are appended atomically using `fs.appendFile` so concurrent
 * writes from different agents do not corrupt the file.
 *
 * @example
 * ```typescript
 * const learningService = LearningAccumulationService.getInstance();
 * await learningService.recordSuccess(
 *   '/home/user/my-project',
 *   'dev-001',
 *   'developer',
 *   'Parallel test execution reduced CI time by 40%',
 *   'Applied to Jest with --maxWorkers=4'
 * );
 * ```
 */
export class LearningAccumulationService {
  private static instance: LearningAccumulationService | null = null;

  private readonly logger = LoggerService.getInstance().createComponentLogger('LearningAccumulationService');

  /**
   * Private constructor to enforce singleton usage
   */
  private constructor() {
    // Intentionally empty -- all state is derived from the file system
  }

  /**
   * Gets the singleton instance of LearningAccumulationService
   *
   * @returns The singleton LearningAccumulationService instance
   */
  public static getInstance(): LearningAccumulationService {
    if (!LearningAccumulationService.instance) {
      LearningAccumulationService.instance = new LearningAccumulationService();
    }
    return LearningAccumulationService.instance;
  }

  /**
   * Clears the singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    LearningAccumulationService.instance = null;
  }

  // ========================= PRIVATE HELPERS =========================

  /**
   * Returns the absolute path to a project's learning directory
   *
   * @param projectPath - Absolute path to the project root
   * @returns Absolute path to `{projectPath}/.crewly/learning`
   */
  private getLearningDir(projectPath: string): string {
    return path.join(
      projectPath,
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      MEMORY_CONSTANTS.PATHS.LEARNING_DIR,
    );
  }

  /**
   * Returns the absolute path to the global learning directory
   *
   * @returns Absolute path to `~/.crewly/learning`
   */
  private getGlobalLearningDir(): string {
    return path.join(
      os.homedir(),
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      MEMORY_CONSTANTS.PATHS.GLOBAL_LEARNING_DIR,
    );
  }

  /**
   * Reads a file and returns its content, or null if the file does not exist
   *
   * Permission errors and other unexpected I/O failures are propagated.
   *
   * @param filePath - Absolute path to the file
   * @returns File content as a string, or null when the file is missing
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

  /**
   * Formats a learning entry as a markdown section
   *
   * The resulting block uses a level-3 heading with an ISO timestamp,
   * followed by the description and optional context, terminated by
   * a horizontal rule separator.
   *
   * @param agentId - Identifier of the agent that produced the learning
   * @param role - Role of the agent (e.g. 'developer', 'qa')
   * @param description - Human-readable description of the learning
   * @param context - Optional additional context or notes
   * @returns Formatted markdown entry string
   *
   * @example
   * ```typescript
   * const entry = this.formatEntry('dev-001', 'developer', 'Tests pass faster with parallelism');
   * // ### [2026-02-09T12:00:00.000Z] developer / dev-001
   * // Tests pass faster with parallelism
   * // Context: None
   * //
   * // ---
   * ```
   */
  private formatEntry(agentId: string, role: string, description: string, context?: string, supersedes?: string): string {
    const timestamp = new Date().toISOString();
    let entry = `### [${timestamp}] ${role} / ${agentId}\n` +
      `${description}\n` +
      `Context: ${context || 'None'}\n`;
    if (supersedes) {
      entry += `Supersedes: ${supersedes}\n`;
    }
    entry += '\n---\n\n';
    return entry;
  }

  /**
   * Ensures a learning file exists, creating it with the provided header if missing
   *
   * @param filePath - Absolute path to the markdown file
   * @param header - Header content to write when creating the file
   */
  private async ensureFileWithHeader(filePath: string, header: string): Promise<void> {
    const existing = await this.safeReadFile(filePath);
    if (existing === null) {
      await fs.writeFile(filePath, header, 'utf-8');
    }
  }

  /**
   * Filters out superseded entries from a learning markdown file.
   *
   * Entries marked with `[SUPERSEDED]` are removed from the output.
   * The file header (everything before the first `### [`) is preserved.
   *
   * @param content - Raw markdown file content
   * @returns Content with superseded entries removed
   */
  private filterSuperseded(content: string): string {
    // Split into entries by the --- separator
    const parts = content.split('\n---\n');
    const filtered = parts.filter(part => !part.includes('[SUPERSEDED]'));
    return filtered.join('\n---\n');
  }

  /**
   * Marks entries in a learning file as superseded by inserting a
   * `[SUPERSEDED]` marker into matching entries.
   *
   * An entry is considered a match if its description contains the
   * supersedes keyword (case-insensitive substring match).
   *
   * @param filePath - Path to the markdown learning file
   * @param keyword - Keyword to match against entry descriptions
   */
  private async markSupersededInFile(filePath: string, keyword: string): Promise<void> {
    const content = await this.safeReadFile(filePath);
    if (!content) return;

    const lowerKeyword = keyword.toLowerCase();
    const entries = content.split('\n---\n');
    let modified = false;

    const updated = entries.map(entry => {
      // Skip if already superseded or if it's the header
      if (entry.includes('[SUPERSEDED]') || !entry.includes('### [')) return entry;

      // Check if the entry description matches the keyword
      if (entry.toLowerCase().includes(lowerKeyword)) {
        modified = true;
        // Insert [SUPERSEDED] marker after the heading line
        return entry.replace(/(### \[.*\].*\n)/, '$1[SUPERSEDED] ');
      }
      return entry;
    });

    if (modified) {
      await fs.writeFile(filePath, updated.join('\n---\n'), 'utf-8');
    }
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Records a successful pattern, approach, or solution to the project's
   * `what_worked.md` learning file
   *
   * If the learning directory or file does not exist it is created automatically.
   *
   * @param projectPath - Absolute path to the project root
   * @param agentId - Identifier of the agent recording the success
   * @param role - Role of the agent (e.g. 'developer', 'qa')
   * @param description - Human-readable description of what worked
   * @param context - Optional additional context or notes
   *
   * @example
   * ```typescript
   * await learningService.recordSuccess(
   *   '/home/user/my-project',
   *   'dev-001',
   *   'developer',
   *   'Using database transactions for batch inserts prevented partial writes',
   *   'PostgreSQL with pg-promise library'
   * );
   * ```
   */
  public async recordSuccess(
    projectPath: string,
    agentId: string,
    role: string,
    description: string,
    context?: string,
    supersedes?: string,
  ): Promise<void> {
    const learningDir = this.getLearningDir(projectPath);
    await ensureDir(learningDir);

    const filePath = path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE);
    await this.ensureFileWithHeader(filePath, WHAT_WORKED_HEADER);

    const entry = this.formatEntry(agentId, role, description, context, supersedes);
    await fs.appendFile(filePath, entry, 'utf-8');

    // If supersedes is provided, also mark matching entries in what_failed.md
    if (supersedes) {
      await this.markSupersededInFile(
        path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE),
        supersedes,
      );
    }

    this.logger.info('Recorded success learning', { projectPath, agentId, role, supersedes });
  }

  /**
   * Records a failed approach, pitfall, or mistake to the project's
   * `what_failed.md` learning file
   *
   * If the learning directory or file does not exist it is created automatically.
   *
   * @param projectPath - Absolute path to the project root
   * @param agentId - Identifier of the agent recording the failure
   * @param role - Role of the agent (e.g. 'developer', 'qa')
   * @param description - Human-readable description of what failed
   * @param context - Optional additional context or notes
   *
   * @example
   * ```typescript
   * await learningService.recordFailure(
   *   '/home/user/my-project',
   *   'qa-001',
   *   'qa',
   *   'Snapshot tests broke on every UI change, causing CI churn',
   *   'Replaced with visual regression tests'
   * );
   * ```
   */
  public async recordFailure(
    projectPath: string,
    agentId: string,
    role: string,
    description: string,
    context?: string,
    supersedes?: string,
  ): Promise<void> {
    const learningDir = this.getLearningDir(projectPath);
    await ensureDir(learningDir);

    const filePath = path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE);
    await this.ensureFileWithHeader(filePath, WHAT_FAILED_HEADER);

    const entry = this.formatEntry(agentId, role, description, context, supersedes);
    await fs.appendFile(filePath, entry, 'utf-8');

    // If supersedes is provided, also mark matching entries in what_worked.md
    if (supersedes) {
      await this.markSupersededInFile(
        path.join(learningDir, MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE),
        supersedes,
      );
    }

    this.logger.info('Recorded failure learning', { projectPath, agentId, role, supersedes });
  }

  /**
   * Records a cross-project insight to the global
   * `~/.crewly/learning/cross_project_insights.md` file
   *
   * Cross-project insights capture learnings that are not specific to a
   * single project and can inform agent behaviour across the entire workspace.
   *
   * @param agentId - Identifier of the agent recording the insight
   * @param role - Role of the agent (e.g. 'developer', 'qa')
   * @param description - Human-readable description of the insight
   * @param context - Optional additional context or notes
   *
   * @example
   * ```typescript
   * await learningService.recordCrossProjectInsight(
   *   'dev-002',
   *   'developer',
   *   'TypeScript strict mode catches 30% more bugs at compile time',
   *   'Observed across 4 projects in Q1 2026'
   * );
   * ```
   */
  public async recordCrossProjectInsight(
    agentId: string,
    role: string,
    description: string,
    context?: string,
  ): Promise<void> {
    const globalDir = this.getGlobalLearningDir();
    await ensureDir(globalDir);

    const filePath = path.join(globalDir, MEMORY_CONSTANTS.PATHS.CROSS_PROJECT_INSIGHTS);
    await this.ensureFileWithHeader(filePath, CROSS_PROJECT_INSIGHTS_HEADER);

    const entry = this.formatEntry(agentId, role, description, context);
    await fs.appendFile(filePath, entry, 'utf-8');

    this.logger.info('Recorded cross-project insight', { agentId, role });
  }

  /**
   * Reads the project's `what_worked.md` learning file
   *
   * When `tailChars` is specified only the last N characters of the file
   * are returned, which is useful for startup briefing prompts that need
   * only the most recent entries.
   *
   * @param projectPath - Absolute path to the project root
   * @param tailChars - Optional maximum number of trailing characters to return
   * @returns File content (or tail thereof), or null if the file does not exist
   *
   * @example
   * ```typescript
   * // Get full file
   * const all = await learningService.getSuccesses('/home/user/project');
   *
   * // Get last 2000 chars for a briefing
   * const recent = await learningService.getSuccesses('/home/user/project', 2000);
   * ```
   */
  public async getSuccesses(projectPath: string, tailChars?: number): Promise<string | null> {
    const filePath = path.join(
      this.getLearningDir(projectPath),
      MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE,
    );

    const content = await this.safeReadFile(filePath);
    if (content === null) {
      return null;
    }

    const filtered = this.filterSuperseded(content);

    if (tailChars !== undefined && filtered.length > tailChars) {
      return filtered.slice(-tailChars);
    }

    return filtered;
  }

  /**
   * Reads the project's `what_failed.md` learning file
   *
   * When `tailChars` is specified only the last N characters of the file
   * are returned, which is useful for startup briefing prompts that need
   * only the most recent entries.
   *
   * @param projectPath - Absolute path to the project root
   * @param tailChars - Optional maximum number of trailing characters to return
   * @returns File content (or tail thereof), or null if the file does not exist
   *
   * @example
   * ```typescript
   * const failures = await learningService.getFailures('/home/user/project', 1500);
   * ```
   */
  public async getFailures(projectPath: string, tailChars?: number): Promise<string | null> {
    const filePath = path.join(
      this.getLearningDir(projectPath),
      MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE,
    );

    const content = await this.safeReadFile(filePath);
    if (content === null) {
      return null;
    }

    const filtered = this.filterSuperseded(content);

    if (tailChars !== undefined && filtered.length > tailChars) {
      return filtered.slice(-tailChars);
    }

    return filtered;
  }

  /**
   * Reads the global `cross_project_insights.md` learning file
   *
   * When `tailChars` is specified only the last N characters of the file
   * are returned, which is useful for startup briefing prompts.
   *
   * @param tailChars - Optional maximum number of trailing characters to return
   * @returns File content (or tail thereof), or null if the file does not exist
   *
   * @example
   * ```typescript
   * const insights = await learningService.getCrossProjectInsights(3000);
   * ```
   */
  public async getCrossProjectInsights(tailChars?: number): Promise<string | null> {
    const filePath = path.join(
      this.getGlobalLearningDir(),
      MEMORY_CONSTANTS.PATHS.CROSS_PROJECT_INSIGHTS,
    );

    const content = await this.safeReadFile(filePath);
    if (content === null) {
      return null;
    }

    if (tailChars !== undefined && content.length > tailChars) {
      return content.slice(-tailChars);
    }

    return content;
  }
}
