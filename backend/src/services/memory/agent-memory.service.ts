/**
 * Agent Memory Service
 *
 * Manages agent-level persistent memory stored in ~/.crewly/agents/{agentId}/
 * Provides storage for role knowledge, preferences, and performance metrics.
 *
 * @module services/memory/agent-memory.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import {
  AgentMemory,
  AgentPreferences,
  RoleKnowledgeEntry,
  PerformanceMetrics,
  ErrorPattern,
  DEFAULT_AGENT_MEMORY,
  MEMORY_SCHEMA_VERSION,
  type RoleKnowledgeCategory,
} from '../../types/memory.types.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';

/**
 * Metrics recorded when a task is completed
 */
export interface TaskCompletionMetrics {
  /** Number of iterations to complete the task */
  iterations: number;
  /** Whether quality gates passed on first try */
  qualityGatePassed: boolean;
  /** Time to complete in minutes */
  completionTimeMinutes?: number;
  /** Type of task (e.g., 'bug-fix', 'feature', 'refactor') */
  taskType?: string;
}

/**
 * Interface for the Agent Memory Service
 */
export interface IAgentMemoryService {
  initializeAgent(agentId: string, role: string): Promise<void>;
  addRoleKnowledge(agentId: string, entry: Omit<RoleKnowledgeEntry, 'id' | 'createdAt'>): Promise<string>;
  getRoleKnowledge(agentId: string, category?: RoleKnowledgeCategory): Promise<RoleKnowledgeEntry[]>;
  reinforceKnowledge(agentId: string, entryId: string): Promise<void>;
  updatePreferences(agentId: string, preferences: Partial<AgentPreferences>): Promise<void>;
  getPreferences(agentId: string): Promise<AgentPreferences>;
  recordTaskCompletion(agentId: string, metrics: TaskCompletionMetrics): Promise<void>;
  recordError(agentId: string, errorPattern: string, resolution?: string): Promise<void>;
  getPerformanceMetrics(agentId: string): Promise<PerformanceMetrics>;
  generateAgentContext(agentId: string): Promise<string>;
  pruneStaleEntries(agentId: string, olderThanDays: number): Promise<number>;
  getAgentMemory(agentId: string): Promise<AgentMemory | null>;
}

/**
 * Service for managing agent-level persistent memory
 *
 * Follows singleton pattern for consistent state management.
 * Uses atomic file writes to prevent data corruption.
 *
 * @example
 * ```typescript
 * const memoryService = AgentMemoryService.getInstance();
 * await memoryService.initializeAgent('dev-001', 'developer');
 * await memoryService.addRoleKnowledge('dev-001', {
 *   category: 'best-practice',
 *   content: 'Always run tests before committing',
 *   confidence: 0.5
 * });
 * ```
 */
export class AgentMemoryService implements IAgentMemoryService {
  private static instance: AgentMemoryService | null = null;
  private static instanceHome: string | null = null;

  private readonly basePath: string;
  private readonly logger = LoggerService.getInstance().createComponentLogger('AgentMemoryService');

  // In-memory cache for frequently accessed data
  private readonly memoryCache: Map<string, { data: AgentMemory; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 30000; // 30 second cache

  /**
   * Creates a new AgentMemoryService instance
   *
   * @param crewlyHome - Optional custom path for crewly home directory
   */
  constructor(crewlyHome?: string) {
    const homeDir = crewlyHome || path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
    this.basePath = path.join(homeDir, MEMORY_CONSTANTS.PATHS.AGENTS_DIR);
    this.ensureBaseDirectory();
  }

  /**
   * Gets the singleton instance of AgentMemoryService
   *
   * @param crewlyHome - Optional custom path for crewly home directory
   * @returns The singleton AgentMemoryService instance
   */
  public static getInstance(crewlyHome?: string): AgentMemoryService {
    const homeDir = crewlyHome || path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);

    if (AgentMemoryService.instance && AgentMemoryService.instanceHome === homeDir) {
      return AgentMemoryService.instance;
    }

    AgentMemoryService.instance = new AgentMemoryService(homeDir);
    AgentMemoryService.instanceHome = homeDir;

    return AgentMemoryService.instance;
  }

  /**
   * Clears the singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    AgentMemoryService.instance = null;
    AgentMemoryService.instanceHome = null;
  }

  /**
   * Ensures the base agents directory exists
   */
  private ensureBaseDirectory(): void {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
      this.logger.debug('Created agents memory directory', { path: this.basePath });
    }
  }

  /**
   * Gets the path to an agent's memory directory
   *
   * @param agentId - The agent's unique identifier
   * @returns Absolute path to the agent's memory directory
   */
  private getAgentPath(agentId: string): string {
    return path.join(this.basePath, agentId);
  }

  /**
   * Gets the path to a specific memory file for an agent
   *
   * @param agentId - The agent's unique identifier
   * @param fileName - The memory file name
   * @returns Absolute path to the memory file
   */
  private getFilePath(agentId: string, fileName: string): string {
    return path.join(this.getAgentPath(agentId), fileName);
  }

  /**
   * Ensures an agent's directory structure exists
   *
   * @param agentId - The agent's unique identifier
   */
  private async ensureAgentDirectory(agentId: string): Promise<void> {
    const agentPath = this.getAgentPath(agentId);
    await fs.mkdir(agentPath, { recursive: true });
    await fs.mkdir(path.join(agentPath, MEMORY_CONSTANTS.AGENT_FILES.SOP_CUSTOM_DIR), { recursive: true });
  }

  /**
   * Invalidates the cache for an agent
   *
   * @param agentId - The agent's unique identifier
   */
  private invalidateCache(agentId: string): void {
    this.memoryCache.delete(agentId);
  }

  /**
   * Gets cached agent memory or loads from disk
   *
   * @param agentId - The agent's unique identifier
   * @returns Agent memory or null if not found
   */
  private async getCachedMemory(agentId: string): Promise<AgentMemory | null> {
    const cached = this.memoryCache.get(agentId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const memory = await this.loadAgentMemory(agentId);
    if (memory) {
      this.memoryCache.set(agentId, { data: memory, timestamp: Date.now() });
    }
    return memory;
  }

  /**
   * Loads agent memory from disk
   *
   * @param agentId - The agent's unique identifier
   * @returns Agent memory or null if not initialized
   */
  private async loadAgentMemory(agentId: string): Promise<AgentMemory | null> {
    const memoryPath = this.getFilePath(agentId, MEMORY_CONSTANTS.AGENT_FILES.MEMORY);
    return safeReadJson<AgentMemory | null>(memoryPath, null, this.logger);
  }

  /**
   * Saves agent memory to disk
   *
   * @param agentId - The agent's unique identifier
   * @param memory - Memory data to save
   */
  private async saveAgentMemory(agentId: string, memory: AgentMemory): Promise<void> {
    memory.updatedAt = new Date().toISOString();
    const memoryPath = this.getFilePath(agentId, MEMORY_CONSTANTS.AGENT_FILES.MEMORY);
    await atomicWriteJson(memoryPath, memory);
    this.invalidateCache(agentId);
  }

  /**
   * Finds a similar existing knowledge entry to avoid duplicates
   *
   * @param knowledge - Existing knowledge entries
   * @param content - Content to check for similarity
   * @returns Matching entry or undefined
   */
  private findSimilarEntry(knowledge: RoleKnowledgeEntry[], content: string): RoleKnowledgeEntry | undefined {
    const normalizedContent = content.toLowerCase().trim();
    return knowledge.find(entry => {
      const normalizedEntry = entry.content.toLowerCase().trim();
      // Simple similarity check - exact match or high substring overlap
      return normalizedEntry === normalizedContent ||
        (normalizedContent.length > 20 &&
          (normalizedEntry.includes(normalizedContent) || normalizedContent.includes(normalizedEntry)));
    });
  }

  /**
   * Formats agent preferences for context output
   *
   * @param preferences - Agent preferences to format
   * @returns Formatted string
   */
  private formatPreferences(preferences: AgentPreferences): string {
    const lines: string[] = [];

    if (preferences.codingStyle) {
      if (preferences.codingStyle.language) {
        lines.push(`- Preferred language: ${preferences.codingStyle.language}`);
      }
      if (preferences.codingStyle.testingFramework) {
        lines.push(`- Testing framework: ${preferences.codingStyle.testingFramework}`);
      }
    }

    if (preferences.communicationStyle) {
      lines.push(`- Communication: ${preferences.communicationStyle.verbosity}`);
      if (preferences.communicationStyle.askBeforeAction) {
        lines.push(`- Ask before taking major actions`);
      }
    }

    if (preferences.workPatterns) {
      if (preferences.workPatterns.breakdownSize) {
        lines.push(`- Task breakdown: ${preferences.workPatterns.breakdownSize} chunks`);
      }
      if (preferences.workPatterns.commitFrequency) {
        lines.push(`- Commit frequency: ${preferences.workPatterns.commitFrequency}`);
      }
    }

    return lines.length > 0 ? lines.join('\n') : 'No specific preferences set';
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Initializes memory storage for a new agent
   *
   * @param agentId - Unique identifier for the agent
   * @param role - Agent's role (e.g., 'developer', 'qa', 'pm')
   *
   * @example
   * ```typescript
   * await memoryService.initializeAgent('frontend-dev-001', 'frontend-developer');
   * ```
   */
  public async initializeAgent(agentId: string, role: string): Promise<void> {
    await this.ensureAgentDirectory(agentId);

    const existingMemory = await this.loadAgentMemory(agentId);
    if (existingMemory) {
      this.logger.debug('Agent already initialized', { agentId });
      return;
    }

    const now = new Date().toISOString();
    const memory: AgentMemory = {
      agentId,
      role,
      createdAt: now,
      updatedAt: now,
      ...DEFAULT_AGENT_MEMORY,
    };

    await this.saveAgentMemory(agentId, memory);
    this.logger.info('Initialized agent memory', { agentId, role });
  }

  /**
   * Adds a new role knowledge entry
   *
   * If similar content already exists, reinforces the existing entry instead.
   *
   * @param agentId - Agent's unique identifier
   * @param entry - Knowledge entry (without id and createdAt)
   * @returns ID of the created or reinforced entry
   *
   * @example
   * ```typescript
   * const entryId = await memoryService.addRoleKnowledge('dev-001', {
   *   category: 'best-practice',
   *   content: 'Always validate user input before processing',
   *   confidence: 0.6,
   *   learnedFrom: 'TICKET-456'
   * });
   * ```
   */
  public async addRoleKnowledge(
    agentId: string,
    entry: Omit<RoleKnowledgeEntry, 'id' | 'createdAt'>
  ): Promise<string> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    // Check for similar existing entry
    const existing = this.findSimilarEntry(memory.roleKnowledge, entry.content);
    if (existing) {
      await this.reinforceKnowledge(agentId, existing.id);
      this.logger.debug('Reinforced existing knowledge entry', { agentId, entryId: existing.id });
      return existing.id;
    }

    // Enforce storage limits
    if (memory.roleKnowledge.length >= MEMORY_CONSTANTS.LIMITS.MAX_ROLE_KNOWLEDGE_ENTRIES) {
      // Remove lowest confidence entries
      memory.roleKnowledge.sort((a, b) => a.confidence - b.confidence);
      memory.roleKnowledge.shift();
      this.logger.debug('Removed lowest confidence entry to stay within limits', { agentId });
    }

    const newEntry: RoleKnowledgeEntry = {
      ...entry,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      confidence: entry.confidence ?? MEMORY_CONSTANTS.DEFAULTS.INITIAL_CONFIDENCE,
    };

    memory.roleKnowledge.push(newEntry);
    await this.saveAgentMemory(agentId, memory);
    this.logger.info('Added role knowledge entry', { agentId, entryId: newEntry.id, category: newEntry.category });

    return newEntry.id;
  }

  /**
   * Gets role knowledge entries, optionally filtered by category
   *
   * @param agentId - Agent's unique identifier
   * @param category - Optional category filter
   * @returns Array of knowledge entries sorted by confidence (descending)
   */
  public async getRoleKnowledge(agentId: string, category?: RoleKnowledgeCategory): Promise<RoleKnowledgeEntry[]> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      return [];
    }

    let entries = memory.roleKnowledge;
    if (category) {
      entries = entries.filter(e => e.category === category);
    }

    return entries.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Reinforces a knowledge entry by increasing its confidence
   *
   * @param agentId - Agent's unique identifier
   * @param entryId - ID of the entry to reinforce
   */
  public async reinforceKnowledge(agentId: string, entryId: string): Promise<void> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    const entry = memory.roleKnowledge.find(e => e.id === entryId);
    if (!entry) {
      this.logger.warn('Knowledge entry not found for reinforcement', { agentId, entryId });
      return;
    }

    entry.confidence = Math.min(
      entry.confidence + MEMORY_CONSTANTS.DEFAULTS.CONFIDENCE_REINFORCEMENT,
      MEMORY_CONSTANTS.DEFAULTS.MAX_CONFIDENCE
    );
    entry.lastUsed = new Date().toISOString();

    await this.saveAgentMemory(agentId, memory);
    this.logger.debug('Reinforced knowledge entry', { agentId, entryId, newConfidence: entry.confidence });
  }

  /**
   * Updates agent preferences (partial update supported)
   *
   * @param agentId - Agent's unique identifier
   * @param preferences - Partial preferences to update
   */
  public async updatePreferences(agentId: string, preferences: Partial<AgentPreferences>): Promise<void> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    // Deep merge preferences - only include defined properties
    if (preferences.codingStyle) {
      memory.preferences.codingStyle = {
        ...memory.preferences.codingStyle,
        ...preferences.codingStyle,
      };
    }
    if (preferences.communicationStyle) {
      memory.preferences.communicationStyle = {
        ...memory.preferences.communicationStyle,
        ...preferences.communicationStyle,
      } as typeof memory.preferences.communicationStyle;
    }
    if (preferences.workPatterns) {
      memory.preferences.workPatterns = {
        ...memory.preferences.workPatterns,
        ...preferences.workPatterns,
      };
    }
    if (preferences.custom) {
      memory.preferences.custom = {
        ...memory.preferences.custom,
        ...preferences.custom,
      };
    }

    await this.saveAgentMemory(agentId, memory);
    this.logger.info('Updated agent preferences', { agentId });
  }

  /**
   * Gets the current agent preferences
   *
   * @param agentId - Agent's unique identifier
   * @returns Agent preferences or defaults
   */
  public async getPreferences(agentId: string): Promise<AgentPreferences> {
    const memory = await this.getCachedMemory(agentId);
    return memory?.preferences ?? DEFAULT_AGENT_MEMORY.preferences;
  }

  /**
   * Records a task completion and updates performance metrics
   *
   * @param agentId - Agent's unique identifier
   * @param metrics - Task completion metrics
   */
  public async recordTaskCompletion(agentId: string, metrics: TaskCompletionMetrics): Promise<void> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    const perf = memory.performance;
    const totalTasks = perf.tasksCompleted + 1;

    // Update running averages
    perf.averageIterations = ((perf.averageIterations * perf.tasksCompleted) + metrics.iterations) / totalTasks;
    perf.qualityGatePassRate = ((perf.qualityGatePassRate * perf.tasksCompleted) + (metrics.qualityGatePassed ? 1 : 0)) / totalTasks;
    perf.tasksCompleted = totalTasks;

    if (metrics.completionTimeMinutes !== undefined) {
      const currentAvg = perf.averageCompletionTime ?? 0;
      perf.averageCompletionTime = ((currentAvg * (totalTasks - 1)) + metrics.completionTimeMinutes) / totalTasks;
    }

    // Track task type success rates
    if (metrics.taskType) {
      perf.taskTypeSuccessRates = perf.taskTypeSuccessRates ?? {};
      const currentRate = perf.taskTypeSuccessRates[metrics.taskType] ?? 0;
      const typeCount = Object.keys(perf.taskTypeSuccessRates).filter(t => t === metrics.taskType).length || 1;
      perf.taskTypeSuccessRates[metrics.taskType] = ((currentRate * typeCount) + (metrics.qualityGatePassed ? 1 : 0)) / (typeCount + 1);
    }

    await this.saveAgentMemory(agentId, memory);
    this.logger.info('Recorded task completion', { agentId, totalTasks, metrics });
  }

  /**
   * Records an error pattern encountered by the agent
   *
   * @param agentId - Agent's unique identifier
   * @param errorPattern - Description of the error pattern
   * @param resolution - Optional known resolution
   */
  public async recordError(agentId: string, errorPattern: string, resolution?: string): Promise<void> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      throw new Error(`Agent ${agentId} not initialized`);
    }

    const existing = memory.performance.commonErrors.find(
      e => e.pattern.toLowerCase() === errorPattern.toLowerCase()
    );

    if (existing) {
      existing.occurrences++;
      existing.lastOccurred = new Date().toISOString();
      if (resolution) {
        existing.resolution = resolution;
      }
    } else {
      memory.performance.commonErrors.push({
        pattern: errorPattern,
        occurrences: 1,
        lastOccurred: new Date().toISOString(),
        resolution,
      });
    }

    // Keep only top 20 most frequent errors
    memory.performance.commonErrors.sort((a, b) => b.occurrences - a.occurrences);
    memory.performance.commonErrors = memory.performance.commonErrors.slice(0, 20);

    await this.saveAgentMemory(agentId, memory);
    this.logger.debug('Recorded error pattern', { agentId, errorPattern });
  }

  /**
   * Gets the current performance metrics for an agent
   *
   * @param agentId - Agent's unique identifier
   * @returns Performance metrics
   */
  public async getPerformanceMetrics(agentId: string): Promise<PerformanceMetrics> {
    const memory = await this.getCachedMemory(agentId);
    return memory?.performance ?? DEFAULT_AGENT_MEMORY.performance;
  }

  /**
   * Generates a context string for prompt injection
   *
   * Compiles relevant agent memories, preferences, and performance data
   * into a formatted string suitable for inclusion in agent prompts.
   *
   * @param agentId - Agent's unique identifier
   * @returns Formatted context string
   */
  public async generateAgentContext(agentId: string): Promise<string> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      return '';
    }

    const { roleKnowledge, preferences, performance } = memory;

    // v2: Filter using effective score (confidence × recency × verification)
    const scored = roleKnowledge
      .filter(k => !k.superseded)
      .map(k => ({ entry: k, score: this.calculateEffectiveScore(k) }))
      .filter(s => s.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const knowledgeSection = scored.length > 0
      ? `## Your Role Knowledge

${scored.map(s => {
  const k = s.entry;
  const outcomeHint = k.sourceOutcome === 'success' ? ' ✓'
    : k.sourceOutcome === 'failed' ? ' ✗'
    : k.sourceOutcome === 'partial' ? ' ~'
    : '';
  return `- [${k.category}] ${k.content}${outcomeHint}`;
}).join('\n')}`
      : '';

    const preferencesSection = `## Your Preferences

${this.formatPreferences(preferences)}`;

    const performanceSection = `## Your Performance

- Tasks completed: ${performance.tasksCompleted}
- Average iterations: ${performance.averageIterations.toFixed(1)}
- Quality gate pass rate: ${(performance.qualityGatePassRate * 100).toFixed(0)}%`;

    const errorsSection = performance.commonErrors.length > 0
      ? `
### Common Errors to Avoid
${performance.commonErrors.slice(0, 5).map(e => `- ${e.pattern} → ${e.resolution || 'No resolution recorded'}`).join('\n')}`
      : '';

    return [knowledgeSection, preferencesSection, performanceSection + errorsSection]
      .filter(s => s.trim())
      .join('\n\n')
      .trim();
  }

  /**
   * Prunes stale entries older than specified days
   *
   * Removes low-confidence entries that haven't been used recently.
   *
   * @param agentId - Agent's unique identifier
   * @param olderThanDays - Number of days threshold
   * @returns Number of entries removed
   */
  public async pruneStaleEntries(agentId: string, olderThanDays: number): Promise<number> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) {
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffIso = cutoffDate.toISOString();

    const originalCount = memory.roleKnowledge.length;

    // Remove entries that are:
    // 1. Below minimum confidence threshold
    // 2. Haven't been used recently (or never used)
    // 3. Created before the cutoff date
    memory.roleKnowledge = memory.roleKnowledge.filter(entry => {
      const isHighConfidence = entry.confidence >= MEMORY_CONSTANTS.LIMITS.MIN_CONFIDENCE_THRESHOLD;
      const lastUsedDate = entry.lastUsed || entry.createdAt;
      const isRecent = lastUsedDate >= cutoffIso;

      return isHighConfidence || isRecent;
    });

    const removedCount = originalCount - memory.roleKnowledge.length;

    if (removedCount > 0) {
      await this.saveAgentMemory(agentId, memory);
      this.logger.info('Pruned stale knowledge entries', { agentId, removedCount });
    }

    return removedCount;
  }

  /**
   * Gets the complete agent memory object
   *
   * @param agentId - Agent's unique identifier
   * @returns Full agent memory or null if not initialized
   */
  public async getAgentMemory(agentId: string): Promise<AgentMemory | null> {
    return this.getCachedMemory(agentId);
  }

  // ========================= v2: Memory Scoring & Decay =========================

  /**
   * Calculate effective score for a knowledge entry.
   * Combines confidence, recency, and verification status.
   *
   * effectiveScore = confidence × recencyFactor × verificationFactor
   *
   * @param entry - The knowledge entry to score
   * @returns Effective score (0-1)
   */
  public calculateEffectiveScore(entry: RoleKnowledgeEntry): number {
    const now = Date.now();

    // Recency: based on lastVerifiedAt, lastUsed, or createdAt
    const lastActive = entry.lastVerifiedAt || entry.lastUsed || entry.createdAt;
    const daysSinceActive = (now - new Date(lastActive).getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = daysSinceActive <= 30 ? 1.0
      : daysSinceActive <= 90 ? 0.75
      : daysSinceActive <= 180 ? 0.5
      : 0.25;

    // Verification: superseded entries heavily penalized
    const verificationFactor = entry.superseded ? 0.3
      : entry.lastVerifiedAt ? 1.0
      : 0.8;

    return entry.confidence * recencyFactor * verificationFactor;
  }

  /**
   * Run decay sweep: halve confidence of entries unused for 90+ days.
   * Remove entries unused for 180+ days with very low confidence.
   * Skip entries with lastVerifiedAt in last 30 days (recently validated).
   *
   * @param agentId - Agent's unique identifier
   * @returns Count of decayed and pruned entries
   */
  public async runDecaySweep(agentId: string): Promise<{ decayed: number; pruned: number }> {
    const memory = await this.getCachedMemory(agentId);
    if (!memory) return { decayed: 0, pruned: 0 };

    const now = Date.now();
    let decayed = 0;
    let pruned = 0;

    memory.roleKnowledge = memory.roleKnowledge.filter(entry => {
      // Skip if recently verified
      if (entry.lastVerifiedAt) {
        const verifiedDaysAgo = (now - new Date(entry.lastVerifiedAt).getTime()) / 86400000;
        if (verifiedDaysAgo <= 30) return true;
      }

      const lastActive = entry.lastUsed || entry.createdAt;
      const daysInactive = (now - new Date(lastActive).getTime()) / 86400000;

      if (daysInactive > 180 && entry.confidence < 0.3) {
        pruned++;
        return false; // remove
      }

      if (daysInactive > 90) {
        entry.confidence = Math.max(0.1, entry.confidence * 0.5);
        decayed++;
      }

      return true;
    });

    if (decayed > 0 || pruned > 0) {
      await this.saveAgentMemory(agentId, memory);
      this.logger.info('Decay sweep completed', { agentId, decayed, pruned });
    }

    return { decayed, pruned };
  }
}
