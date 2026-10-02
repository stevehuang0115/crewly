/**
 * Project Memory Service
 *
 * Manages project-level persistent memory stored in project/.crewly/knowledge/
 * Provides storage for patterns, decisions, gotchas, and relationships.
 *
 * @module services/memory/project-memory.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import {
  ProjectMemory,
  PatternEntry,
  DecisionEntry,
  GotchaEntry,
  RelationshipEntry,
  TaskHistoryEntry,
  DEFAULT_PROJECT_MEMORY,
  type PatternCategory,
  type GotchaSeverity,
  type RelationshipType,
} from '../../types/memory.types.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { isTaskCompletionLog } from './task-log-filter.js';

/**
 * Search results from cross-entity search
 */
export interface SearchResults {
  patterns: PatternEntry[];
  decisions: DecisionEntry[];
  gotchas: GotchaEntry[];
  relationships: RelationshipEntry[];
  totalCount: number;
}

/**
 * Interface for the Project Memory Service
 */
export interface IProjectMemoryService {
  initializeProject(projectPath: string): Promise<void>;
  addPattern(projectPath: string, pattern: Omit<PatternEntry, 'id' | 'createdAt'>): Promise<string>;
  getPatterns(projectPath: string, category?: PatternCategory): Promise<PatternEntry[]>;
  searchPatterns(projectPath: string, query: string): Promise<PatternEntry[]>;
  addDecision(projectPath: string, decision: Omit<DecisionEntry, 'id' | 'decidedAt'>): Promise<string>;
  getDecisions(projectPath: string): Promise<DecisionEntry[]>;
  addGotcha(projectPath: string, gotcha: Omit<GotchaEntry, 'id' | 'createdAt'>): Promise<string>;
  getGotchas(projectPath: string, severity?: GotchaSeverity): Promise<GotchaEntry[]>;
  addRelationship(projectPath: string, relationship: Omit<RelationshipEntry, 'id'>): Promise<string>;
  getRelationships(projectPath: string, componentName?: string): Promise<RelationshipEntry[]>;
  recordLearning(projectPath: string, agentId: string, agentRole: string, learning: string, metadata?: Record<string, unknown>): Promise<void>;
  getRecentLearnings(projectPath: string, limit?: number): Promise<string>;
  generateProjectContext(projectPath: string): Promise<string>;
  searchAll(projectPath: string, query: string): Promise<SearchResults>;
  getProjectMemory(projectPath: string): Promise<ProjectMemory | null>;
  addTaskHistory(projectPath: string, entry: TaskHistoryEntry): Promise<string>;
  getTaskHistory(projectPath: string, capability?: string): Promise<TaskHistoryEntry[]>;
  archiveTaskCompletionLogs(projectPath: string): Promise<TaskLogArchiveResult>;
}

/**
 * How many task-completion entries one archive pass moved out of memory.
 */
export interface TaskLogArchiveResult {
  /** Entries moved out of decisions.json */
  decisions: number;
  /** Entries moved out of learnings.md */
  learnings: number;
}

/**
 * Splits learnings.md into entries. Each entry ends with a `---` rule that
 * is followed by the next `## YYYY-MM-DD` heading or the end of the file, so
 * a `---` inside a learning's own text does not split it.
 */
const LEARNING_ENTRY_SEPARATOR = /\n---\n\n(?=## \d{4}-\d{2}-\d{2}\n|$)/;

/**
 * Service for managing project-level persistent memory
 *
 * Follows singleton pattern for consistent state management.
 * Uses atomic file writes to prevent data corruption.
 *
 * @example
 * ```typescript
 * const memoryService = ProjectMemoryService.getInstance();
 * await memoryService.initializeProject('/path/to/project');
 * await memoryService.addPattern('/path/to/project', {
 *   category: 'api',
 *   title: 'Error Handling Wrapper',
 *   description: 'All API endpoints use handleApiError() wrapper',
 *   discoveredBy: 'backend-dev-001'
 * });
 * ```
 */
export class ProjectMemoryService implements IProjectMemoryService {
  private static instance: ProjectMemoryService | null = null;

  private readonly logger = LoggerService.getInstance().createComponentLogger('ProjectMemoryService');

  // In-memory cache for frequently accessed data
  private readonly memoryCache: Map<string, { data: ProjectMemory; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 second cache

  /**
   * Creates a new ProjectMemoryService instance
   */
  constructor() {
    // No base path needed - each project has its own knowledge directory
  }

  /**
   * Gets the singleton instance of ProjectMemoryService
   *
   * @returns The singleton ProjectMemoryService instance
   */
  public static getInstance(): ProjectMemoryService {
    if (!ProjectMemoryService.instance) {
      ProjectMemoryService.instance = new ProjectMemoryService();
    }
    return ProjectMemoryService.instance;
  }

  /**
   * Clears the singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    ProjectMemoryService.instance = null;
  }

  /**
   * Gets the path to a project's knowledge directory
   *
   * @param projectPath - Absolute path to the project
   * @returns Path to the knowledge directory
   */
  private getKnowledgePath(projectPath: string): string {
    return path.join(resolveProjectDataDir(projectPath), MEMORY_CONSTANTS.PATHS.KNOWLEDGE_DIR);
  }

  /**
   * Gets the path to a specific memory file for a project
   *
   * @param projectPath - Absolute path to the project
   * @param fileName - The memory file name
   * @returns Absolute path to the memory file
   */
  private getFilePath(projectPath: string, fileName: string): string {
    return path.join(this.getKnowledgePath(projectPath), fileName);
  }

  /**
   * Checks if a file exists
   *
   * @param filePath - Path to check
   * @returns true if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidates the cache for a project
   *
   * @param projectPath - Project path
   */
  private invalidateCache(projectPath: string): void {
    this.memoryCache.delete(projectPath);
  }

  /**
   * Checks if content is similar (simple substring matching)
   *
   * @param existing - Existing content
   * @param newContent - New content to compare
   * @returns true if content is similar
   */
  private isSimilarContent(existing: string, newContent: string): boolean {
    const normalizedExisting = existing.toLowerCase().trim();
    const normalizedNew = newContent.toLowerCase().trim();

    if (normalizedExisting === normalizedNew) return true;

    // Check for significant substring overlap (>70% of shorter string)
    const shorter = normalizedExisting.length < normalizedNew.length ? normalizedExisting : normalizedNew;
    const longer = normalizedExisting.length >= normalizedNew.length ? normalizedExisting : normalizedNew;

    if (shorter.length > 30 && longer.includes(shorter)) return true;

    return false;
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Initializes memory storage for a project
   *
   * @param projectPath - Absolute path to the project
   *
   * @example
   * ```typescript
   * await memoryService.initializeProject('/home/user/projects/my-app');
   * ```
   */
  public async initializeProject(projectPath: string): Promise<void> {
    const knowledgePath = this.getKnowledgePath(projectPath);

    // Create knowledge directory
    await fs.mkdir(knowledgePath, { recursive: true });

    // Initialize empty JSON files if they don't exist
    const jsonFiles = [
      MEMORY_CONSTANTS.PROJECT_FILES.INDEX,
      MEMORY_CONSTANTS.PROJECT_FILES.PATTERNS,
      MEMORY_CONSTANTS.PROJECT_FILES.DECISIONS,
      MEMORY_CONSTANTS.PROJECT_FILES.GOTCHAS,
      MEMORY_CONSTANTS.PROJECT_FILES.RELATIONSHIPS,
      MEMORY_CONSTANTS.PROJECT_FILES.TASK_HISTORY,
    ];

    for (const file of jsonFiles) {
      const filePath = path.join(knowledgePath, file);
      if (!await this.fileExists(filePath)) {
        if (file === MEMORY_CONSTANTS.PROJECT_FILES.INDEX) {
          const projectId = path.basename(projectPath);
          const now = new Date().toISOString();
          const indexData: ProjectMemory = {
            projectId,
            projectPath,
            createdAt: now,
            updatedAt: now,
            ...DEFAULT_PROJECT_MEMORY,
          };
          await atomicWriteJson(filePath, indexData);
        } else {
          await atomicWriteJson(filePath, []);
        }
      }
    }

    // Initialize learnings.md
    const learningsPath = path.join(knowledgePath, MEMORY_CONSTANTS.PROJECT_FILES.LEARNINGS);
    if (!await this.fileExists(learningsPath)) {
      const projectName = path.basename(projectPath);
      await fs.writeFile(learningsPath, `# Project Learnings: ${projectName}\n\nThis file contains learnings discovered during development.\n\n---\n\n`);
    }

    // One-time cleanup of task logs written by older completion skills (#833).
    // Idempotent: after the first pass there is nothing left to match.
    try {
      await this.archiveTaskCompletionLogs(projectPath);
    } catch (error) {
      this.logger.warn('Failed to archive task-completion entries (non-fatal)', {
        projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info('Initialized project memory', { projectPath });
  }

  /**
   * Moves task-completion summaries out of decisions.json and learnings.md
   * into knowledge/archive/ (#833).
   *
   * Older complete-task / report-status skills saved every finished task as a
   * project decision (mirrored into learnings.md as "Decision made: …") and
   * as a "Task completed: …" learning. These crowded real decisions out of
   * recall. The entries are kept, readable, in the archive files; the
   * summaries themselves also remain on their WorkItems.
   *
   * Idempotent: a second run finds nothing to move and writes nothing.
   *
   * @param projectPath - Project path
   * @returns How many decisions and learnings were moved
   *
   * @example
   * ```typescript
   * const moved = await projectMemory.archiveTaskCompletionLogs('/projects/app');
   * // { decisions: 29, learnings: 58 }
   * ```
   */
  public async archiveTaskCompletionLogs(projectPath: string): Promise<TaskLogArchiveResult> {
    const result: TaskLogArchiveResult = { decisions: 0, learnings: 0 };
    const archiveDir = path.join(this.getKnowledgePath(projectPath), MEMORY_CONSTANTS.PROJECT_FILES.ARCHIVE_DIR);

    // decisions.json
    const decisionsPath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.DECISIONS);
    const decisions = await safeReadJson<DecisionEntry[]>(decisionsPath, []);
    const taskDecisions = decisions.filter(d => isTaskCompletionLog(d.decision) || isTaskCompletionLog(d.title));
    if (taskDecisions.length > 0) {
      await fs.mkdir(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, MEMORY_CONSTANTS.PROJECT_FILES.ARCHIVED_TASK_DECISIONS);
      const archived = await safeReadJson<DecisionEntry[]>(archivePath, []);
      // Archive first, then shrink the live file: a crash in between leaves a
      // duplicate in the archive, never a lost entry.
      await atomicWriteJson(archivePath, [...archived, ...taskDecisions]);
      const moved = new Set(taskDecisions.map(d => d.id));
      await this.saveDecisions(projectPath, decisions.filter(d => !moved.has(d.id)));
      result.decisions = taskDecisions.length;
    }

    // learnings.md
    const learningsPath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.LEARNINGS);
    let content: string | null = null;
    try {
      content = await fs.readFile(learningsPath, 'utf-8');
    } catch {
      content = null;
    }
    if (content) {
      const entries = content.split(LEARNING_ENTRY_SEPARATOR);
      const keep: string[] = [];
      const move: string[] = [];
      for (const entry of entries) {
        (this.isTaskLogLearningEntry(entry) ? move : keep).push(entry);
      }
      if (move.length > 0) {
        await fs.mkdir(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, MEMORY_CONSTANTS.PROJECT_FILES.ARCHIVED_TASK_LEARNINGS);
        await fs.appendFile(archivePath, move.map(e => `${e}\n---\n\n`).join(''));
        const rest = keep.join('\n---\n\n');
        await fs.writeFile(learningsPath, rest.endsWith('\n---\n\n') || rest.trim() === '' ? rest : `${rest}\n---\n\n`);
        result.learnings = move.length;
      }
    }

    if (result.decisions > 0 || result.learnings > 0) {
      this.logger.info('Archived task-completion entries out of project memory', { projectPath, ...result });
    }
    return result;
  }

  /**
   * Whether one learnings.md entry is a task-completion log. The learning
   * text is everything after the entry's `### [role/agent] time` line.
   *
   * @param entry - One entry from learnings.md (without its trailing rule)
   * @returns true when the entry's learning text is a task log
   */
  private isTaskLogLearningEntry(entry: string): boolean {
    const lines = entry.split('\n');
    const header = lines.findIndex(line => line.startsWith('### '));
    if (header === -1) return false;
    return isTaskCompletionLog(lines.slice(header + 1).join('\n'));
  }

  /**
   * Adds a new pattern entry
   *
   * @param projectPath - Project path
   * @param pattern - Pattern data (without id and createdAt)
   * @returns ID of the created or existing pattern
   */
  public async addPattern(
    projectPath: string,
    pattern: Omit<PatternEntry, 'id' | 'createdAt'>
  ): Promise<string> {
    const patterns = await this.getPatterns(projectPath);

    // Dedup requires BOTH title match AND content similarity. Pre-fix this was an
    // OR-clause, which caused silent-success collisions when callers omitted
    // `metadata.title` and shared the same default title (e.g. 'Untitled Pattern').
    // See P0-SEV fix: silent-success in core/remember for scope=project.
    const existing = patterns.find(p =>
      p.title.toLowerCase() === pattern.title.toLowerCase() &&
      this.isSimilarContent(p.description, pattern.description)
    );

    if (existing) {
      // Update existing pattern if new info provided
      let updated = false;
      if (pattern.example && !existing.example) {
        existing.example = pattern.example;
        updated = true;
      }
      if (pattern.files && pattern.files.length > 0) {
        existing.files = [...new Set([...(existing.files || []), ...pattern.files])];
        updated = true;
      }
      if (updated) {
        await this.savePatterns(projectPath, patterns);
      }
      // Observability: surface dedup hits at WARN so regressions are visible (was debug).
      this.logger.warn('addPattern: dedup hit (title+content match), returning existing entry', {
        projectPath,
        existingPatternId: existing.id,
        title: pattern.title,
        discoveredBy: pattern.discoveredBy,
      });
      return existing.id;
    }

    // Enforce storage limits
    if (patterns.length >= MEMORY_CONSTANTS.LIMITS.MAX_PATTERN_ENTRIES) {
      patterns.shift(); // Remove oldest
      this.logger.debug('Removed oldest pattern to stay within limits', { projectPath });
    }

    const newPattern: PatternEntry = {
      ...pattern,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    };

    patterns.push(newPattern);
    await this.savePatterns(projectPath, patterns);

    // Record as learning
    await this.recordLearning(
      projectPath,
      pattern.discoveredBy,
      'agent',
      `Discovered pattern: ${pattern.title} - ${pattern.description}`,
      { type: 'pattern', patternId: newPattern.id }
    );

    this.logger.info('Added pattern', { projectPath, patternId: newPattern.id, category: newPattern.category });
    return newPattern.id;
  }

  /**
   * Gets all patterns, optionally filtered by category
   *
   * @param projectPath - Project path
   * @param category - Optional category filter
   * @returns Array of patterns
   */
  public async getPatterns(projectPath: string, category?: PatternCategory): Promise<PatternEntry[]> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.PATTERNS);
    const patterns = await safeReadJson<PatternEntry[]>(filePath, []);

    if (category) {
      return patterns.filter(p => p.category === category);
    }
    return patterns;
  }

  /**
   * Saves patterns to disk
   */
  private async savePatterns(projectPath: string, patterns: PatternEntry[]): Promise<void> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.PATTERNS);
    await atomicWriteJson(filePath, patterns);
    this.invalidateCache(projectPath);
  }

  /**
   * Searches patterns by query
   *
   * @param projectPath - Project path
   * @param query - Search query
   * @returns Matching patterns
   */
  public async searchPatterns(projectPath: string, query: string): Promise<PatternEntry[]> {
    const patterns = await this.getPatterns(projectPath);
    const queryLower = query.toLowerCase();

    return patterns.filter(p =>
      p.title.toLowerCase().includes(queryLower) ||
      p.description.toLowerCase().includes(queryLower) ||
      p.category.toLowerCase().includes(queryLower) ||
      p.tags?.some(t => t.toLowerCase().includes(queryLower))
    );
  }

  /**
   * Adds a new decision entry
   *
   * @param projectPath - Project path
   * @param decision - Decision data (without id and decidedAt)
   * @param options - `supersedes`: ids (bare or `dec:`-prefixed) of decisions
   *   this one replaces; each is marked `superseded` with `supersededBy` set,
   *   so it leaves the standing-answer scope and default recall (#884)
   * @returns ID of the created decision
   */
  public async addDecision(
    projectPath: string,
    decision: Omit<DecisionEntry, 'id' | 'decidedAt'>,
    options: { supersedes?: string[] } = {}
  ): Promise<string> {
    const decisions = await this.getDecisions(projectPath);

    // Dedup requires BOTH title match AND decision-content similarity. Pre-fix this was
    // title-only, which caused silent-success collisions when callers omitted
    // `metadata.title` and shared the same default title (e.g. 'Untitled Decision').
    // See P0-SEV fix: silent-success in core/remember for scope=project.
    const existing = decisions.find(d =>
      d.title.toLowerCase() === decision.title.toLowerCase() &&
      this.isSimilarContent(d.decision, decision.decision)
    );

    if (existing) {
      // Observability: surface dedup hits at WARN so regressions are visible (was debug).
      this.logger.warn('addDecision: dedup hit (title+content match), returning existing entry', {
        projectPath,
        existingDecisionId: existing.id,
        title: decision.title,
        decidedBy: decision.decidedBy,
      });
      if (this.markDecisionsSuperseded(projectPath, decisions, existing.id, options.supersedes)) {
        await this.saveDecisions(projectPath, decisions);
      }
      return existing.id;
    }

    // No cap-based eviction: a decision is retired only by an explicit `supersedes`.
    // Previously, at MAX_DECISION_ENTRIES this marked the first active entry of the
    // (active-first, newest-first) sorted list as superseded -- i.e. the NEWEST decision,
    // so every save retired the one before it. 100+ active decisions is a legitimate state.
    if (decisions.length >= MEMORY_CONSTANTS.LIMITS.MAX_DECISION_ENTRIES) {
      this.logger.warn('addDecision: decision count at/over soft limit; not evicting', {
        projectPath,
        count: decisions.length,
        limit: MEMORY_CONSTANTS.LIMITS.MAX_DECISION_ENTRIES,
      });
    }

    const newDecision: DecisionEntry = {
      ...decision,
      id: uuidv4(),
      decidedAt: new Date().toISOString(),
      status: 'active',
    };

    decisions.push(newDecision);
    this.markDecisionsSuperseded(projectPath, decisions, newDecision.id, options.supersedes);
    await this.saveDecisions(projectPath, decisions);

    // Record as learning
    await this.recordLearning(
      projectPath,
      decision.decidedBy,
      'agent',
      `Decision made: ${decision.title} - ${decision.decision} (Rationale: ${decision.rationale})`,
      { type: 'decision', decisionId: newDecision.id }
    );

    this.logger.info('Added decision', { projectPath, decisionId: newDecision.id });
    return newDecision.id;
  }

  /**
   * Mark the decisions named in `supersedes` as superseded by `newId` (#884).
   * Unknown ids are logged and skipped; the new decision itself is never
   * marked.
   *
   * @param projectPath - Project path (for logging)
   * @param decisions - Loaded decisions, mutated in place
   * @param newId - Id of the decision that replaces them
   * @param supersedes - Ids, bare or `dec:`-prefixed
   * @returns True when any entry changed
   */
  private markDecisionsSuperseded(
    projectPath: string,
    decisions: DecisionEntry[],
    newId: string,
    supersedes: string[] | undefined
  ): boolean {
    let changed = false;
    for (const raw of supersedes ?? []) {
      const id = raw.trim().replace(/^dec:/, '');
      if (!id || id === newId) continue;
      const old = decisions.find(d => d.id === id);
      if (!old) {
        this.logger.warn('addDecision: superseded decision not found', { projectPath, id, newId });
        continue;
      }
      if (old.status === 'superseded' && old.supersededBy === newId) continue;
      old.status = 'superseded';
      old.supersededBy = newId;
      changed = true;
    }
    return changed;
  }

  /**
   * Gets all decisions
   *
   * @param projectPath - Project path
   * @returns Array of decisions (active ones first)
   */
  public async getDecisions(projectPath: string): Promise<DecisionEntry[]> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.DECISIONS);
    const decisions = await safeReadJson<DecisionEntry[]>(filePath, []);
    // Sort: active first, then by date
    return decisions.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime();
    });
  }

  /**
   * Saves decisions to disk
   */
  private async saveDecisions(projectPath: string, decisions: DecisionEntry[]): Promise<void> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.DECISIONS);
    await atomicWriteJson(filePath, decisions);
    this.invalidateCache(projectPath);
  }

  /**
   * Adds a new gotcha entry
   *
   * @param projectPath - Project path
   * @param gotcha - Gotcha data (without id and createdAt)
   * @returns ID of the created gotcha
   */
  public async addGotcha(
    projectPath: string,
    gotcha: Omit<GotchaEntry, 'id' | 'createdAt'>
  ): Promise<string> {
    const gotchas = await this.getGotchas(projectPath);

    // Dedup requires BOTH title match AND content similarity. Pre-fix this was an
    // OR-clause, which caused silent-success collisions when callers omitted
    // `metadata.title` and shared the same default title (e.g. 'Gotcha').
    // See P0-SEV fix: silent-success in core/remember for scope=project.
    const existing = gotchas.find(g =>
      g.title.toLowerCase() === gotcha.title.toLowerCase() &&
      this.isSimilarContent(g.problem, gotcha.problem)
    );

    if (existing) {
      // Update with better solution if provided
      if (gotcha.solution && gotcha.solution.length > (existing.solution?.length || 0)) {
        existing.solution = gotcha.solution;
        await this.saveGotchas(projectPath, gotchas);
      }
      // Observability: surface dedup hits at WARN so regressions are visible (was debug).
      this.logger.warn('addGotcha: dedup hit (title+content match), returning existing entry', {
        projectPath,
        existingGotchaId: existing.id,
        title: gotcha.title,
        discoveredBy: gotcha.discoveredBy,
      });
      return existing.id;
    }

    // Enforce storage limits
    if (gotchas.length >= MEMORY_CONSTANTS.LIMITS.MAX_GOTCHA_ENTRIES) {
      // Evict the OLDEST resolved low-severity gotcha. The loaded list is sorted by
      // severity, so a bare find() would pick an arbitrary entry among the lows.
      const candidates = gotchas.filter(g => g.resolved && g.severity === 'low');
      candidates.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const toRemove = candidates[0];
      if (toRemove) {
        gotchas.splice(gotchas.indexOf(toRemove), 1);
      } else {
        this.logger.warn('addGotcha: at limit with no resolved low-severity gotcha to evict', {
          projectPath,
          count: gotchas.length,
        });
      }
    }

    const newGotcha: GotchaEntry = {
      ...gotcha,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
    };

    gotchas.push(newGotcha);
    await this.saveGotchas(projectPath, gotchas);

    // Record as learning
    await this.recordLearning(
      projectPath,
      gotcha.discoveredBy,
      'agent',
      `Discovered gotcha: ${gotcha.title} - ${gotcha.problem} → ${gotcha.solution}`,
      { type: 'gotcha', gotchaId: newGotcha.id, severity: gotcha.severity }
    );

    this.logger.info('Added gotcha', { projectPath, gotchaId: newGotcha.id, severity: gotcha.severity });
    return newGotcha.id;
  }

  /**
   * Gets all gotchas, optionally filtered by severity
   *
   * @param projectPath - Project path
   * @param severity - Optional severity filter
   * @returns Array of gotchas (high severity first)
   */
  public async getGotchas(projectPath: string, severity?: GotchaSeverity): Promise<GotchaEntry[]> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.GOTCHAS);
    let gotchas = await safeReadJson<GotchaEntry[]>(filePath, []);

    if (severity) {
      gotchas = gotchas.filter(g => g.severity === severity);
    }

    // Sort by severity (critical > high > medium > low)
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return gotchas.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }

  /**
   * Saves gotchas to disk
   */
  private async saveGotchas(projectPath: string, gotchas: GotchaEntry[]): Promise<void> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.GOTCHAS);
    await atomicWriteJson(filePath, gotchas);
    this.invalidateCache(projectPath);
  }

  /**
   * Adds a new relationship entry
   *
   * @param projectPath - Project path
   * @param relationship - Relationship data (without id)
   * @returns ID of the created relationship
   */
  public async addRelationship(
    projectPath: string,
    relationship: Omit<RelationshipEntry, 'id'>
  ): Promise<string> {
    const relationships = await this.getRelationships(projectPath);

    // Check for existing same relationship
    const existing = relationships.find(r =>
      r.from === relationship.from &&
      r.to === relationship.to &&
      r.relationshipType === relationship.relationshipType
    );

    if (existing) {
      // Update description if provided
      if (relationship.description && !existing.description) {
        existing.description = relationship.description;
        await this.saveRelationships(projectPath, relationships);
      }
      return existing.id;
    }

    // Enforce storage limits
    if (relationships.length >= MEMORY_CONSTANTS.LIMITS.MAX_RELATIONSHIP_ENTRIES) {
      relationships.shift(); // Remove oldest
    }

    const newRelationship: RelationshipEntry = {
      ...relationship,
      id: uuidv4(),
    };

    relationships.push(newRelationship);
    await this.saveRelationships(projectPath, relationships);

    this.logger.debug('Added relationship', { projectPath, relationshipId: newRelationship.id });
    return newRelationship.id;
  }

  /**
   * Gets relationships, optionally filtered by component name
   *
   * @param projectPath - Project path
   * @param componentName - Optional component name filter
   * @returns Array of relationships
   */
  public async getRelationships(projectPath: string, componentName?: string): Promise<RelationshipEntry[]> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.RELATIONSHIPS);
    const relationships = await safeReadJson<RelationshipEntry[]>(filePath, []);

    if (componentName) {
      return relationships.filter(r =>
        r.from === componentName || r.to === componentName
      );
    }
    return relationships;
  }

  /**
   * Saves relationships to disk
   */
  private async saveRelationships(projectPath: string, relationships: RelationshipEntry[]): Promise<void> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.RELATIONSHIPS);
    await atomicWriteJson(filePath, relationships);
    this.invalidateCache(projectPath);
  }

  /**
   * Append a task-history entry. Dedup on `id`; if an existing entry
   * with the same id is found, this is a no-op (subscriber emits a
   * stable id per workitem so a redelivered event collapses cleanly).
   *
   * @param projectPath - Project path
   * @param entry - The TaskHistoryEntry to record
   * @returns The id of the recorded entry (echoes input.id)
   */
  public async addTaskHistory(
    projectPath: string,
    entry: TaskHistoryEntry,
  ): Promise<string> {
    const existing = await this.getTaskHistory(projectPath);
    if (existing.some((e) => e.id === entry.id)) {
      return entry.id;
    }
    existing.push(entry);
    await this.saveTaskHistory(projectPath, existing);
    return entry.id;
  }

  /**
   * Get the full task-history ledger for a project. Optionally filter
   * by canonical capability string (e.g. `'gmail:read'`); when filter
   * is set, only entries whose `capabilities[]` contains an exact
   * match are returned, sorted most-recent first.
   *
   * @param projectPath - Project path
   * @param capability - Optional capability string filter
   * @returns Array of entries (most recent first when filtered)
   */
  public async getTaskHistory(
    projectPath: string,
    capability?: string,
  ): Promise<TaskHistoryEntry[]> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.TASK_HISTORY);
    const all = await safeReadJson<TaskHistoryEntry[]>(filePath, []);
    if (!capability) return all;
    const matches = all.filter((e) => e.capabilities.includes(capability));
    matches.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return matches;
  }

  private async saveTaskHistory(
    projectPath: string,
    entries: TaskHistoryEntry[],
  ): Promise<void> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.TASK_HISTORY);
    await atomicWriteJson(filePath, entries);
    this.invalidateCache(projectPath);
  }

  /**
   * Records a learning entry to the append-only log
   *
   * @param projectPath - Project path
   * @param agentId - Agent that made the learning
   * @param agentRole - Agent's role
   * @param learning - The learning content
   * @param metadata - Optional metadata
   */
  public async recordLearning(
    projectPath: string,
    agentId: string,
    agentRole: string,
    learning: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const learningsPath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.LEARNINGS);

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toISOString().split('T')[1].split('.')[0];

    let entry = `## ${date}\n\n`;
    entry += `### [${agentRole}/${agentId}] ${time}\n`;
    entry += `${learning}\n`;

    if (metadata?.relatedFiles && Array.isArray(metadata.relatedFiles)) {
      entry += `\n**Related files:** ${(metadata.relatedFiles as string[]).join(', ')}\n`;
    }
    if (metadata?.type) {
      entry += `**Type:** ${metadata.type}\n`;
    }

    entry += '\n---\n\n';

    await fs.appendFile(learningsPath, entry);
    this.logger.debug('Recorded learning', { projectPath, agentId });
  }

  /**
   * Gets recent learnings from the log
   *
   * @param projectPath - Project path
   * @param limit - Maximum number of entries to return
   * @returns Recent learnings as markdown
   */
  public async getRecentLearnings(projectPath: string, limit: number = 10): Promise<string> {
    const learningsPath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.LEARNINGS);

    try {
      const content = await fs.readFile(learningsPath, 'utf-8');
      const entries = content.split('---').filter(e => e.trim() && !e.includes('# Project Learnings'));

      // Get last N entries
      const recent = entries.slice(-limit);
      return recent.join('\n---\n').trim();
    } catch {
      return '';
    }
  }

  /**
   * Generates a context string for prompt injection
   *
   * @param projectPath - Project path
   * @returns Formatted context string
   */
  public async generateProjectContext(projectPath: string): Promise<string> {
    const [patterns, decisions, gotchas, relationships] = await Promise.all([
      this.getPatterns(projectPath),
      this.getDecisions(projectPath),
      this.getGotchas(projectPath),
      this.getRelationships(projectPath),
    ]);

    const recentLearnings = await this.getRecentLearnings(projectPath, 5);

    let context = '## Project Knowledge Base\n\n';

    // Critical gotchas first (high priority warnings)
    const criticalGotchas = gotchas.filter(g => g.severity === 'critical' || g.severity === 'high');
    if (criticalGotchas.length > 0) {
      context += '### Critical Gotchas (Must Know!)\n\n';
      criticalGotchas.forEach(g => {
        context += `- **${g.title}**: ${g.problem} → ${g.solution}\n`;
      });
      context += '\n';
    }

    const userPreferences = patterns.filter((p) => p.category === 'user_preference');
    const codePatterns = patterns.filter((p) => p.category !== 'user_preference');

    if (userPreferences.length > 0) {
      context += '### User Preferences\n\n';
      userPreferences.slice(0, 10).forEach((p) => {
        context += `- ${p.description}\n`;
      });
      context += '\n';
    }

    // Key patterns
    if (codePatterns.length > 0) {
      context += '### Code Patterns\n\n';
      codePatterns.slice(0, 10).forEach(p => {
        context += `- **[${p.category}] ${p.title}**: ${p.description}\n`;
        if (p.example) {
          context += `  Example: \`${p.example}\`\n`;
        }
      });
      context += '\n';
    }

    // Active decisions
    const activeDecisions = decisions.filter(d => d.status === 'active');
    if (activeDecisions.length > 0) {
      context += '### Architecture Decisions\n\n';
      activeDecisions.slice(0, 5).forEach(d => {
        context += `- **${d.title}**: ${d.decision}\n  _Rationale: ${d.rationale}_\n`;
      });
      context += '\n';
    }

    // Component relationships (if not too many)
    if (relationships.length > 0 && relationships.length <= 20) {
      context += '### Component Relationships\n\n';
      relationships.forEach(r => {
        context += `- ${r.from} ${r.relationshipType} ${r.to}`;
        if (r.description) {
          context += ` (${r.description})`;
        }
        context += '\n';
      });
      context += '\n';
    }

    // Recent learnings
    if (recentLearnings) {
      context += '### Recent Learnings\n\n';
      context += recentLearnings + '\n';
    }

    return context.trim();
  }

  /**
   * Searches across all entity types
   *
   * @param projectPath - Project path
   * @param query - Search query
   * @returns Search results from all categories
   */
  public async searchAll(projectPath: string, query: string): Promise<SearchResults> {
    const queryLower = query.toLowerCase();

    const [patterns, decisions, gotchas, relationships] = await Promise.all([
      this.getPatterns(projectPath),
      this.getDecisions(projectPath),
      this.getGotchas(projectPath),
      this.getRelationships(projectPath),
    ]);

    const matchingPatterns = patterns.filter(p =>
      p.title.toLowerCase().includes(queryLower) ||
      p.description.toLowerCase().includes(queryLower)
    );

    const matchingDecisions = decisions.filter(d =>
      d.title.toLowerCase().includes(queryLower) ||
      d.decision.toLowerCase().includes(queryLower) ||
      d.rationale.toLowerCase().includes(queryLower)
    );

    const matchingGotchas = gotchas.filter(g =>
      g.title.toLowerCase().includes(queryLower) ||
      g.problem.toLowerCase().includes(queryLower) ||
      g.solution.toLowerCase().includes(queryLower)
    );

    const matchingRelationships = relationships.filter(r =>
      r.from.toLowerCase().includes(queryLower) ||
      r.to.toLowerCase().includes(queryLower) ||
      r.description?.toLowerCase().includes(queryLower)
    );

    return {
      patterns: matchingPatterns,
      decisions: matchingDecisions,
      gotchas: matchingGotchas,
      relationships: matchingRelationships,
      totalCount: matchingPatterns.length + matchingDecisions.length + matchingGotchas.length + matchingRelationships.length,
    };
  }

  /**
   * Gets the complete project memory object
   *
   * @param projectPath - Project path
   * @returns Full project memory or null if not initialized
   */
  public async getProjectMemory(projectPath: string): Promise<ProjectMemory | null> {
    const filePath = this.getFilePath(projectPath, MEMORY_CONSTANTS.PROJECT_FILES.INDEX);
    return safeReadJson<ProjectMemory | null>(filePath, null, this.logger);
  }
}
