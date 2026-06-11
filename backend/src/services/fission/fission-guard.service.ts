/**
 * FissionGuardService — Task fission prevention
 *
 * Prevents agents from creating unbounded sub-tasks by enforcing
 * 6 guardrails:
 *   1. maxDepth — parentWorkItemId chain depth limit
 *   2. maxTasks — per-Mission task count limit
 *   3. Rate limit — per-agent creation rate within a sliding window
 *   4. Branching factor — max children per WorkItem
 *   5. Task TTL — time-to-live enforcement
 *   6. Budget gate — cost threshold requiring approval
 *
 * @module services/fission/fission-guard.service
 */

import { v4 as uuidv4 } from 'uuid';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type {
  GuardResult,
  FissionGuardConfig,
  FissionViolation,
  FissionViolationType,
  AgentCreationRecord,
} from './fission-guard.types.js';
import {
  DEFAULT_FISSION_CONFIG,
  createAllowedResult,
  createBlockedResult,
} from './fission-guard.types.js';

// ---------------------------------------------------------------------------
// Data Provider Interface (dependency injection)
// ---------------------------------------------------------------------------

/**
 * Interface for resolving WorkItem relationships and Mission task counts.
 * Injected to keep the guard service testable without real storage.
 */
export interface FissionDataProvider {
  /** Resolve a WorkItem by ID */
  getWorkItemById(id: string): Promise<WorkItem | null>;
  /** Count all non-terminal WorkItems belonging to a Mission */
  countMissionWorkItems(missionId: string): Promise<number>;
  /** Count direct children of a WorkItem */
  countChildWorkItems(parentWorkItemId: string): Promise<number>;
}

/**
 * Interface for checking agent budget status.
 * Matches the subset of BudgetService used by the guard.
 */
export interface BudgetChecker {
  /** Check whether the agent's spend is within budget */
  isWithinBudget(agentId: string): Promise<boolean>;
}

/**
 * Wrap a budget service as a fail-OPEN {@link BudgetChecker} for the fission
 * budget gate (P5). A real over-budget verdict blocks new sub-tasks — the
 * safety ceiling that stops an unattended multi-day run from burning unbounded
 * money. But a TRANSIENT budget-service error must NOT brick the whole system
 * (that would halt all work on a disk hiccup), so on error we return "within
 * budget". The hard stop fires only when the budget service actually reports
 * over-budget.
 *
 * @param budgetService - Anything exposing `isWithinBudget(agentId)`.
 * @returns A fail-open BudgetChecker for {@link FissionGuardService.init}.
 *
 * @example
 * ```ts
 * const checker = createFailOpenBudgetChecker(BudgetService.getInstance());
 * FissionGuardService.init(dataProvider, checker);
 * ```
 */
export function createFailOpenBudgetChecker(
  budgetService: { isWithinBudget(agentId: string): Promise<boolean> },
): BudgetChecker {
  return {
    async isWithinBudget(agentId: string): Promise<boolean> {
      try {
        return await budgetService.isWithinBudget(agentId);
      } catch {
        return true; // fail-open: a budget-service error must not block all work
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FissionGuardService
// ---------------------------------------------------------------------------

export class FissionGuardService {
  private static instance: FissionGuardService | null = null;

  private config: FissionGuardConfig;
  private dataProvider: FissionDataProvider;
  private budgetChecker: BudgetChecker | null;
  private readonly logger: ComponentLogger;

  /** Per-agent creation timestamps for rate limiting */
  private creationRecords: Map<string, AgentCreationRecord> = new Map();

  /** Violation audit trail (newest first) */
  private violations: FissionViolation[] = [];

  /**
   * Creates a new FissionGuardService.
   *
   * @param dataProvider - Provides WorkItem relationship data
   * @param budgetChecker - Optional budget checking interface
   * @param config - Optional configuration override
   */
  constructor(
    dataProvider: FissionDataProvider,
    budgetChecker?: BudgetChecker | null,
    config?: Partial<FissionGuardConfig>,
  ) {
    this.dataProvider = dataProvider;
    this.budgetChecker = budgetChecker ?? null;
    this.config = { ...DEFAULT_FISSION_CONFIG, ...config };
    this.logger = LoggerService.getInstance().createComponentLogger('FissionGuard');
  }

  /**
   * Get or create the singleton instance.
   * Must be initialized with init() before first use.
   *
   * @returns The singleton FissionGuardService
   */
  static getInstance(): FissionGuardService {
    if (!FissionGuardService.instance) {
      throw new Error('FissionGuardService not initialized — call init() first');
    }
    return FissionGuardService.instance;
  }

  /**
   * Initialize the singleton with dependencies.
   *
   * @param dataProvider - Provides WorkItem relationship data
   * @param budgetChecker - Optional budget checking interface
   * @param config - Optional configuration override
   * @returns The initialized singleton
   */
  static init(
    dataProvider: FissionDataProvider,
    budgetChecker?: BudgetChecker | null,
    config?: Partial<FissionGuardConfig>,
  ): FissionGuardService {
    FissionGuardService.instance = new FissionGuardService(dataProvider, budgetChecker, config);
    return FissionGuardService.instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    FissionGuardService.instance = null;
  }

  // -------------------------------------------------------------------------
  // Core Guard Check
  // -------------------------------------------------------------------------

  /**
   * Check whether an agent is allowed to create a sub-task under the given parent.
   * Evaluates all 6 guardrails in order. Returns on the first violation.
   *
   * @param parent - The parent WorkItem the sub-task would be created under
   * @param agentId - The agent attempting the creation
   * @param missionId - Optional Mission ID for per-mission limits
   * @returns GuardResult indicating whether the creation is allowed
   */
  async canCreateSubTask(
    parent: WorkItem,
    agentId: string,
    missionId?: string,
  ): Promise<GuardResult> {
    // 1. Max depth
    const depthResult = await this.checkMaxDepth(parent);
    if (!depthResult.allowed) {
      this.recordViolation('max_depth', agentId, parent.id, missionId, depthResult.reason!,
        await this.resolveDepth(parent), this.config.maxDepth);
      return depthResult;
    }

    // 2. Max tasks per mission
    if (missionId) {
      const tasksResult = await this.checkMaxTasks(missionId);
      if (!tasksResult.allowed) {
        const count = await this.dataProvider.countMissionWorkItems(missionId);
        this.recordViolation('max_tasks', agentId, parent.id, missionId, tasksResult.reason!,
          count, this.config.maxTasksPerMission);
        return tasksResult;
      }
    }

    // 3. Rate limit
    const rateResult = this.checkRateLimit(agentId);
    if (!rateResult.allowed) {
      const record = this.creationRecords.get(agentId);
      const count = record ? this.getRecentCount(record) : 0;
      this.recordViolation('rate_limit', agentId, parent.id, missionId, rateResult.reason!,
        count, this.config.rateLimitMaxCreations);
      return rateResult;
    }

    // 4. Branching factor
    const branchResult = await this.checkBranchingFactor(parent.id);
    if (!branchResult.allowed) {
      const children = await this.dataProvider.countChildWorkItems(parent.id);
      this.recordViolation('branching_factor', agentId, parent.id, missionId, branchResult.reason!,
        children, this.config.maxBranchingFactor);
      return branchResult;
    }

    // 5. TTL check on parent
    const ttlResult = this.checkTTL(parent);
    if (!ttlResult.allowed) {
      const ageMs = Date.now() - new Date(parent.createdAt).getTime();
      this.recordViolation('ttl_exceeded', agentId, parent.id, missionId, ttlResult.reason!,
        ageMs, this.config.maxTtlMs);
      return ttlResult;
    }

    // 6. Budget gate
    if (this.config.budgetGateEnabled && this.budgetChecker) {
      const budgetResult = await this.checkBudget(agentId);
      if (!budgetResult.allowed) {
        this.recordViolation('budget_exceeded', agentId, parent.id, missionId, budgetResult.reason!,
          0, this.config.budgetThresholdUsd);
        return budgetResult;
      }
    }

    // All checks passed — record the creation for rate limiting
    this.recordCreation(agentId);

    return createAllowedResult();
  }

  // -------------------------------------------------------------------------
  // Individual Guardrails
  // -------------------------------------------------------------------------

  /**
   * Guardrail 1: Check parent chain depth.
   * Walks parentWorkItemId links to determine depth.
   *
   * @param parent - The parent WorkItem
   * @returns GuardResult
   */
  async checkMaxDepth(parent: WorkItem): Promise<GuardResult> {
    const depth = await this.resolveDepth(parent);
    // The child would be at depth + 1
    if (depth + 1 > this.config.maxDepth) {
      return createBlockedResult(
        'max_depth',
        `Sub-task would be at depth ${depth + 1}, exceeding max depth of ${this.config.maxDepth}`,
      );
    }
    return createAllowedResult();
  }

  /**
   * Guardrail 2: Check total tasks for a Mission.
   *
   * @param missionId - The Mission to check
   * @returns GuardResult
   */
  async checkMaxTasks(missionId: string): Promise<GuardResult> {
    const count = await this.dataProvider.countMissionWorkItems(missionId);

    // Hard limit is absolute — cannot be overridden by config
    if (count >= this.config.hardMaxTasksPerMission) {
      return createBlockedResult(
        'max_tasks',
        `Mission ${missionId} has ${count} tasks, at hard limit of ${this.config.hardMaxTasksPerMission}`,
      );
    }

    if (count >= this.config.maxTasksPerMission) {
      return createBlockedResult(
        'max_tasks',
        `Mission ${missionId} has ${count} tasks, at limit of ${this.config.maxTasksPerMission}`,
      );
    }

    return createAllowedResult();
  }

  /**
   * Guardrail 3: Check agent creation rate within sliding window.
   *
   * @param agentId - The agent to check
   * @returns GuardResult
   */
  checkRateLimit(agentId: string): GuardResult {
    const record = this.creationRecords.get(agentId);
    if (!record) return createAllowedResult();

    const recentCount = this.getRecentCount(record);
    if (recentCount >= this.config.rateLimitMaxCreations) {
      return createBlockedResult(
        'rate_limit',
        `Agent ${agentId} created ${recentCount} sub-tasks in the last ${this.config.rateLimitWindowMs / 60_000} minutes, limit is ${this.config.rateLimitMaxCreations}`,
      );
    }

    return createAllowedResult();
  }

  /**
   * Guardrail 4: Check children count for a parent WorkItem.
   *
   * @param parentWorkItemId - The parent WorkItem ID
   * @returns GuardResult
   */
  async checkBranchingFactor(parentWorkItemId: string): Promise<GuardResult> {
    const children = await this.dataProvider.countChildWorkItems(parentWorkItemId);
    if (children >= this.config.maxBranchingFactor) {
      return createBlockedResult(
        'branching_factor',
        `WorkItem ${parentWorkItemId} already has ${children} children, limit is ${this.config.maxBranchingFactor}`,
      );
    }
    return createAllowedResult();
  }

  /**
   * Guardrail 5: Check if parent WorkItem has exceeded its TTL.
   * If the parent is already past max TTL, creating children is pointless.
   *
   * @param parent - The parent WorkItem
   * @returns GuardResult
   */
  checkTTL(parent: WorkItem): GuardResult {
    const ageMs = Date.now() - new Date(parent.createdAt).getTime();
    if (ageMs > this.config.maxTtlMs) {
      return createBlockedResult(
        'ttl_exceeded',
        `Parent WorkItem ${parent.id} age is ${Math.round(ageMs / 3_600_000)}h, exceeding max TTL of ${Math.round(this.config.maxTtlMs / 3_600_000)}h`,
      );
    }
    return createAllowedResult();
  }

  /**
   * Guardrail 6: Check agent budget.
   * Uses the injected BudgetChecker to verify the agent hasn't exceeded spend.
   *
   * @param agentId - The agent to check
   * @returns GuardResult
   */
  async checkBudget(agentId: string): Promise<GuardResult> {
    if (!this.budgetChecker) return createAllowedResult();

    try {
      const withinBudget = await this.budgetChecker.isWithinBudget(agentId);
      if (!withinBudget) {
        return createBlockedResult(
          'budget_exceeded',
          `Agent ${agentId} has exceeded budget threshold of $${this.config.budgetThresholdUsd} — approval required`,
        );
      }
    } catch (err) {
      // Budget check failure is non-fatal — allow the creation but log warning
      this.logger.warn('Budget check failed, allowing creation', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return createAllowedResult();
  }

  // -------------------------------------------------------------------------
  // Violation History
  // -------------------------------------------------------------------------

  /**
   * Returns recent violations for auditing.
   *
   * @param limit - Maximum number of violations to return
   * @returns Array of FissionViolation (newest first)
   */
  getViolations(limit: number = 50): FissionViolation[] {
    return this.violations.slice(0, Math.min(limit, this.config.maxViolationHistory));
  }

  /**
   * Returns violations filtered by type.
   *
   * @param type - Violation type to filter by
   * @returns Array of matching violations
   */
  getViolationsByType(type: FissionViolationType): FissionViolation[] {
    return this.violations.filter(v => v.violationType === type);
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Returns the current configuration.
   *
   * @returns A copy of the current FissionGuardConfig
   */
  getConfig(): FissionGuardConfig {
    return { ...this.config };
  }

  /**
   * Updates configuration at runtime.
   *
   * @param updates - Partial configuration to merge
   */
  updateConfig(updates: Partial<FissionGuardConfig>): void {
    // Enforce hard limit cannot be increased beyond absolute max
    if (updates.maxTasksPerMission !== undefined) {
      updates.maxTasksPerMission = Math.min(
        updates.maxTasksPerMission,
        this.config.hardMaxTasksPerMission,
      );
    }
    this.config = { ...this.config, ...updates };
    this.logger.info('FissionGuardConfig updated', { config: this.config });
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolves the depth of a WorkItem by walking the parentWorkItemId chain.
   * Depth 0 = root (no parent), depth 1 = direct child, etc.
   *
   * @param item - The WorkItem to resolve depth for
   * @returns The depth (0-based)
   */
  private async resolveDepth(item: WorkItem): Promise<number> {
    let depth = 0;
    let currentParentId = item.parentWorkItemId;

    // Safety limit to prevent infinite loops from circular references
    const maxWalk = this.config.maxDepth + 10;
    let walked = 0;

    while (currentParentId && walked < maxWalk) {
      depth++;
      walked++;
      const parent = await this.dataProvider.getWorkItemById(currentParentId);
      if (!parent) break;
      currentParentId = parent.parentWorkItemId;
    }

    return depth;
  }

  /**
   * Count recent creations within the rate limit window.
   *
   * @param record - The agent's creation record
   * @returns Number of creations within the window
   */
  private getRecentCount(record: AgentCreationRecord): number {
    const cutoff = Date.now() - this.config.rateLimitWindowMs;
    return record.timestamps.filter(t => t > cutoff).length;
  }

  /**
   * Record a successful creation for rate limiting.
   *
   * @param agentId - The agent that created a sub-task
   */
  private recordCreation(agentId: string): void {
    let record = this.creationRecords.get(agentId);
    if (!record) {
      record = { agentId, timestamps: [] };
      this.creationRecords.set(agentId, record);
    }

    record.timestamps.push(Date.now());

    // Prune old timestamps outside the window
    const cutoff = Date.now() - this.config.rateLimitWindowMs;
    record.timestamps = record.timestamps.filter(t => t > cutoff);
  }

  /**
   * Record a violation for auditing.
   *
   * @param violationType - Which guardrail was violated
   * @param agentId - Agent that triggered the violation
   * @param parentWorkItemId - The parent WorkItem ID
   * @param missionId - Optional Mission ID
   * @param reason - Human-readable reason
   * @param currentValue - The value that exceeded the limit
   * @param configuredLimit - The configured limit
   */
  private recordViolation(
    violationType: FissionViolationType,
    agentId: string,
    parentWorkItemId: string,
    missionId: string | undefined,
    reason: string,
    currentValue: number,
    configuredLimit: number,
  ): void {
    const violation: FissionViolation = {
      id: uuidv4(),
      violationType,
      agentId,
      parentWorkItemId,
      missionId,
      reason,
      currentValue,
      configuredLimit,
      violatedAt: new Date().toISOString(),
    };

    this.violations.unshift(violation);

    // Trim history
    if (this.violations.length > this.config.maxViolationHistory) {
      this.violations = this.violations.slice(0, this.config.maxViolationHistory);
    }

    this.logger.warn('Fission guard violation', {
      violationType,
      agentId,
      parentWorkItemId,
      missionId,
      currentValue,
      configuredLimit,
    });
  }
}
