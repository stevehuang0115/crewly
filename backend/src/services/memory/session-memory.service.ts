/**
 * Session Memory Service
 *
 * Manages session lifecycle for agents: startup briefings, session summaries,
 * and the project-level agents index. Coordinates with AgentMemoryService and
 * ProjectMemoryService to assemble the context an agent needs when it starts
 * a new work session and to persist what it learned when the session ends.
 *
 * Storage locations:
 * - Session summaries: ~/.crewly/agents/{agentId}/sessions/
 * - Agents index: {projectPath}/.crewly/agents-index.json
 *
 * @module services/memory/session-memory.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ensureDir, atomicWriteFile, safeReadJson, atomicWriteJson } from '../../utils/file-io.utils.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { AgentMemoryService } from './agent-memory.service.js';
import { ProjectMemoryService } from './project-memory.service.js';
import type { SessionSummary, StartupBriefing, AgentIndexEntry, ProjectAgentsIndex } from '../../types/memory.types.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';

/** Maximum number of characters to include from learning files */
const LEARNING_TAIL_CHARS = 500;

/** Maximum characters for a single briefing section before truncation */
const MAX_SECTION_CHARS = 2000;

/**
 * Service for managing agent session lifecycle
 *
 * Follows singleton pattern for consistent state management.
 * Coordinates AgentMemoryService and ProjectMemoryService to build
 * startup briefings and persist session summaries.
 *
 * @example
 * ```typescript
 * const sessionMemory = SessionMemoryService.getInstance();
 * await sessionMemory.onSessionStart('dev-001', 'developer', '/projects/app');
 *
 * // ... agent works ...
 *
 * await sessionMemory.onSessionEnd('dev-001', 'developer', '/projects/app', 'Implemented auth');
 * ```
 */
export class SessionMemoryService {
  private static instance: SessionMemoryService | null = null;

  private readonly logger = LoggerService.getInstance().createComponentLogger('SessionMemoryService');

  /**
   * Creates a new SessionMemoryService instance
   *
   * Private constructor -- use {@link getInstance} to obtain the singleton.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  /**
   * Gets the singleton instance of SessionMemoryService
   *
   * @returns The singleton SessionMemoryService instance
   */
  public static getInstance(): SessionMemoryService {
    if (!SessionMemoryService.instance) {
      SessionMemoryService.instance = new SessionMemoryService();
    }
    return SessionMemoryService.instance;
  }

  /**
   * Clears the singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    SessionMemoryService.instance = null;
  }

  // ========================= HELPER METHODS =========================

  /**
   * Returns the absolute path to the Crewly home directory (~/.crewly)
   *
   * @returns Absolute path to Crewly home
   */
  private getAgentmuxHome(): string {
    return path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
  }

  /**
   * Returns the sessions archive directory for a given agent
   *
   * @param agentId - The agent's unique identifier
   * @returns Absolute path to the agent's sessions directory
   *
   * @example
   * ```typescript
   * // Returns: ~/.crewly/agents/dev-001/sessions
   * this.getSessionsDir('dev-001');
   * ```
   */
  private getSessionsDir(agentId: string): string {
    return path.join(
      this.getAgentmuxHome(),
      MEMORY_CONSTANTS.PATHS.AGENTS_DIR,
      agentId,
      MEMORY_CONSTANTS.PATHS.SESSIONS_DIR,
    );
  }

  /**
   * Safely reads a file and returns its contents as a string, or null if the
   * file does not exist or cannot be read.
   *
   * @param filePath - Absolute path to the file
   * @returns File contents or null on any error
   */
  private async safeReadFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Truncates a string to a maximum number of characters, appending an
   * ellipsis marker when truncation occurs.
   *
   * @param text - The input string
   * @param maxChars - Maximum number of characters to retain
   * @returns Truncated string (or original if within limit)
   */
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + '\n\n... (truncated)';
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Called when an agent session starts
   *
   * Initializes both agent-level and project-level memory stores (if not
   * already initialized) and updates the project agents index so that the
   * orchestrator knows which agents have worked on a project.
   *
   * @param agentId - Unique identifier for the agent
   * @param role - Agent's role (e.g., 'developer', 'qa', 'pm')
   * @param projectPath - Absolute path to the project the agent is working on
   *
   * @example
   * ```typescript
   * await sessionMemory.onSessionStart('backend-dev-001', 'developer', '/home/user/project');
   * ```
   */
  public async onSessionStart(agentId: string, role: string, projectPath: string): Promise<void> {
    const agentMemory = AgentMemoryService.getInstance();
    const projectMemory = ProjectMemoryService.getInstance();

    // Initialize stores (both are idempotent if already created)
    await agentMemory.initializeAgent(agentId, role);
    await projectMemory.initializeProject(projectPath);

    // Record this agent in the project agents index
    await this.updateAgentsIndex(projectPath, agentId, role);

    this.logger.info('Session started', { agentId, role, projectPath });
  }

  /**
   * Called when an agent session ends
   *
   * Persists a timestamped session summary markdown file under the agent's
   * sessions directory and also writes a `latest-summary.md` symlink-equivalent
   * so that the next startup briefing can quickly locate the most recent summary.
   *
   * @param agentId - Unique identifier for the agent
   * @param role - Agent's role
   * @param projectPath - Absolute path to the project
   * @param summary - Optional human-readable summary of what the agent accomplished
   *
   * @example
   * ```typescript
   * await sessionMemory.onSessionEnd(
   *   'backend-dev-001',
   *   'developer',
   *   '/home/user/project',
   *   'Implemented user authentication with JWT tokens and added integration tests.',
   * );
   * ```
   */
  public async onSessionEnd(
    agentId: string,
    role: string,
    projectPath: string,
    summary?: string,
  ): Promise<void> {
    const sessionsDir = this.getSessionsDir(agentId);
    await ensureDir(sessionsDir);

    const now = new Date();
    const isoTimestamp = now.toISOString();

    // Build a YYYY-MM-DD-HH-MM filename from the current time
    const pad = (n: number): string => String(n).padStart(2, '0');
    const fileName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.md`;

    const content = [
      '# Session Summary',
      '',
      `**Agent:** ${agentId}`,
      `**Role:** ${role}`,
      `**Project:** ${projectPath}`,
      `**Ended:** ${isoTimestamp}`,
      '',
      '## Summary',
      '',
      summary || 'No summary provided',
    ].join('\n');

    // Write the timestamped archive file
    const archivePath = path.join(sessionsDir, fileName);
    await atomicWriteFile(archivePath, content);

    // Write the latest-summary.md convenience file
    const latestPath = path.join(sessionsDir, MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY);
    await atomicWriteFile(latestPath, content);

    this.logger.info('Session ended', { agentId, role, projectPath, archiveFile: fileName });
  }

  /**
   * Generates a startup briefing for an agent that is about to begin a session
   *
   * Aggregates context from multiple sources:
   * - The agent's most recent session summary
   * - Agent-level knowledge, preferences, and performance data
   * - Project-level patterns, decisions, and gotchas
   * - Today's daily log, active goals, and learning files
   *
   * All reads are best-effort: a missing file simply produces a null or empty
   * field rather than an error.
   *
   * @param agentId - Unique identifier for the agent
   * @param role - Agent's role
   * @param projectPath - Absolute path to the project
   * @returns A {@link StartupBriefing} containing all available context
   *
   * @example
   * ```typescript
   * const briefing = await sessionMemory.generateStartupBriefing(
   *   'backend-dev-001',
   *   'developer',
   *   '/home/user/project',
   * );
   * const markdown = sessionMemory.formatBriefingAsMarkdown(briefing);
   * ```
   */
  public async generateStartupBriefing(
    agentId: string,
    role: string,
    projectPath: string,
  ): Promise<StartupBriefing> {
    const crewlyDir = resolveProjectDataDir(projectPath);

    // Read latest session summary
    const latestSummaryPath = path.join(
      this.getSessionsDir(agentId),
      MEMORY_CONSTANTS.PATHS.LATEST_SUMMARY,
    );
    const lastSessionSummary = await this.safeReadFile(latestSummaryPath);

    // Agent context (knowledge, preferences, performance)
    let agentContext = '';
    try {
      agentContext = await AgentMemoryService.getInstance().generateAgentContext(agentId);
    } catch {
      this.logger.debug('Failed to generate agent context', { agentId });
    }

    // Project context (patterns, decisions, gotchas)
    let projectContext = '';
    try {
      projectContext = await ProjectMemoryService.getInstance().generateProjectContext(projectPath);
    } catch {
      this.logger.debug('Failed to generate project context', { projectPath });
    }

    // Today's daily log
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyLogPath = path.join(crewlyDir, MEMORY_CONSTANTS.PATHS.DAILY_LOG_DIR, `${today}.md`);
    const todaysDailyLog = await this.safeReadFile(dailyLogPath);

    // Active goals
    const goalsPath = path.join(crewlyDir, MEMORY_CONSTANTS.PATHS.GOALS_DIR, MEMORY_CONSTANTS.PATHS.GOALS_FILE);
    const activeGoals = await this.safeReadFile(goalsPath);

    // Recent failures (tail only)
    const failedPath = path.join(crewlyDir, MEMORY_CONSTANTS.PATHS.LEARNING_DIR, MEMORY_CONSTANTS.PATHS.WHAT_FAILED_FILE);
    const failedRaw = await this.safeReadFile(failedPath);
    const recentFailures = failedRaw !== null
      ? failedRaw.slice(-LEARNING_TAIL_CHARS)
      : null;

    // Recent successes (tail only)
    const workedPath = path.join(crewlyDir, MEMORY_CONSTANTS.PATHS.LEARNING_DIR, MEMORY_CONSTANTS.PATHS.WHAT_WORKED_FILE);
    const workedRaw = await this.safeReadFile(workedPath);
    const recentSuccesses = workedRaw !== null
      ? workedRaw.slice(-LEARNING_TAIL_CHARS)
      : null;

    return {
      lastSessionSummary,
      agentContext,
      projectContext,
      todaysDailyLog,
      activeGoals,
      recentFailures,
      recentSuccesses,
    };
  }

  /**
   * Formats a {@link StartupBriefing} into a markdown string suitable for
   * prompt injection
   *
   * Only includes sections that have non-null, non-empty content. Long
   * sections are truncated to keep the prompt within reasonable limits.
   *
   * @param briefing - The startup briefing to format
   * @returns A markdown string ready for injection into the agent's system prompt
   *
   * @example
   * ```typescript
   * const briefing = await sessionMemory.generateStartupBriefing(id, role, path);
   * const md = sessionMemory.formatBriefingAsMarkdown(briefing);
   * // md is a string like "## Your Previous Knowledge\n\n### Last Session\n..."
   * ```
   */
  public formatBriefingAsMarkdown(briefing: StartupBriefing): string {
    const sections: string[] = [];

    sections.push('## Your Previous Knowledge');

    if (briefing.lastSessionSummary) {
      sections.push('### Last Session');
      sections.push(this.truncate(briefing.lastSessionSummary, MAX_SECTION_CHARS));
    }

    if (briefing.agentContext) {
      sections.push('### Your Agent Memory');
      sections.push(this.truncate(briefing.agentContext, MAX_SECTION_CHARS));
    }

    if (briefing.projectContext) {
      sections.push('### Project Knowledge');
      sections.push(this.truncate(briefing.projectContext, MAX_SECTION_CHARS));
    }

    if (briefing.todaysDailyLog) {
      sections.push("### Today's Activity");
      sections.push(this.truncate(briefing.todaysDailyLog, MAX_SECTION_CHARS));
    }

    if (briefing.activeGoals) {
      sections.push('### Active Goals');
      sections.push(this.truncate(briefing.activeGoals, MAX_SECTION_CHARS));
    }

    if (briefing.recentFailures) {
      sections.push('### Recent Failures (avoid repeating)');
      sections.push(briefing.recentFailures);
    }

    if (briefing.recentSuccesses) {
      sections.push('### Recent Successes (replicate)');
      sections.push(briefing.recentSuccesses);
    }

    return sections.join('\n\n').trim();
  }

  /**
   * Updates the project-level agents index with an agent's latest activity
   *
   * The agents index lives at `{projectPath}/.crewly/agents-index.json` and
   * tracks every agent that has worked on the project, along with the timestamp
   * of their most recent activity.
   *
   * If the agent already exists in the index, only the `lastActive` and `role`
   * fields are updated. Otherwise a new entry is appended.
   *
   * @param projectPath - Absolute path to the project
   * @param agentId - The agent's unique identifier
   * @param role - Agent's role
   *
   * @throws Rethrows file I/O errors other than ENOENT
   *
   * @example
   * ```typescript
   * await sessionMemory.updateAgentsIndex('/home/user/project', 'dev-001', 'developer');
   * ```
   */
  public async updateAgentsIndex(projectPath: string, agentId: string, role: string): Promise<void> {
    const indexPath = path.join(resolveProjectDataDir(projectPath), MEMORY_CONSTANTS.PATHS.AGENTS_INDEX);

    // Ensure the parent directory exists
    await ensureDir(path.dirname(indexPath));

    const defaultIndex: ProjectAgentsIndex = { agents: [] };
    const index = await safeReadJson<ProjectAgentsIndex>(indexPath, defaultIndex, this.logger);

    const now = new Date().toISOString();
    const existingIdx = index.agents.findIndex((a) => a.agentId === agentId);

    if (existingIdx >= 0) {
      index.agents[existingIdx].lastActive = now;
      index.agents[existingIdx].role = role;
    } else {
      const entry: AgentIndexEntry = { agentId, role, lastActive: now };
      index.agents.push(entry);
    }

    await atomicWriteJson(indexPath, index);
    this.logger.debug('Updated agents index', { projectPath, agentId, role });
  }
}
