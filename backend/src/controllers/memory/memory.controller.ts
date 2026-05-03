/**
 * Memory REST Controller
 *
 * Exposes agent memory operations via REST API for orchestrator bash skills.
 * Wraps the unified MemoryService to provide HTTP endpoints for storing,
 * retrieving, and recording learnings in agent and project memory.
 *
 * @module controllers/memory/memory.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { MemoryService } from '../../services/memory/memory.service.js';
import type { RememberCategory, MemoryScope } from '../../services/memory/memory.service.js';
import { GoalTrackingService } from '../../services/memory/goal-tracking.service.js';
import { DailyLogService } from '../../services/memory/daily-log.service.js';
import { LearningAccumulationService } from '../../services/memory/learning-accumulation.service.js';
import { KnowledgeService } from '../../services/knowledge/knowledge.service.js';
import { UserProfileService } from '../../services/memory/user-profile.service.js';
import { MemorySupersessionService } from '../../services/memory/memory-supersession.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('MemoryController');

/** Valid categories for the remember endpoint */
const VALID_REMEMBER_CATEGORIES: ReadonlySet<string> = new Set([
  'fact', 'pattern', 'decision', 'gotcha', 'preference', 'user_preference', 'relationship',
]);

/** Valid scopes for the remember endpoint */
const VALID_REMEMBER_SCOPES: ReadonlySet<string> = new Set(['agent', 'project']);

/** Valid scopes for the recall endpoint */
const VALID_RECALL_SCOPES: ReadonlySet<string> = new Set(['agent', 'project', 'both']);

/** Default character limit for learning accumulation tail reads */
const LEARNING_TAIL_CHARS = 3000;

/**
 * POST /api/memory/remember
 *
 * Store knowledge in agent or project memory. The content is categorized
 * and routed to the appropriate memory store based on the scope parameter.
 *
 * @param req - Express request with body: { agentId, content, category, scope, projectPath?, metadata? }
 * @param res - Express response returning { success, entryId }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/memory/remember
 * {
 *   "agentId": "dev-001",
 *   "content": "Always validate user input before processing",
 *   "category": "pattern",
 *   "scope": "agent"
 * }
 * ```
 */
export async function remember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { agentId, content, category, scope, projectPath, metadata } = req.body;

    if (!agentId || !content || !category) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: agentId, content, category',
      });
      return;
    }

    if (!VALID_REMEMBER_CATEGORIES.has(category)) {
      res.status(400).json({
        success: false,
        error: `Invalid category '${category}'. Must be one of: ${[...VALID_REMEMBER_CATEGORIES].join(', ')}`,
      });
      return;
    }

    const resolvedScope: 'agent' | 'project' = scope || 'agent';
    if (!VALID_REMEMBER_SCOPES.has(resolvedScope)) {
      res.status(400).json({
        success: false,
        error: `Invalid scope '${resolvedScope}'. Must be one of: ${[...VALID_REMEMBER_SCOPES].join(', ')}`,
      });
      return;
    }

    if (resolvedScope === 'project' && !projectPath) {
      res.status(400).json({
        success: false,
        error: 'projectPath is required when scope is "project"',
      });
      return;
    }

    const memoryService = MemoryService.getInstance();
    const entryId = await memoryService.remember({
      agentId,
      content,
      category: category as RememberCategory,
      scope: resolvedScope,
      projectPath,
      metadata,
    });

    logger.info('Memory stored via REST', { agentId, category, scope: resolvedScope });

    res.json({ success: true, entryId });
  } catch (error) {
    logger.error('Failed to store memory', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/memory/recall
 *
 * Retrieve relevant knowledge from agent and/or project memory.
 * Performs relevance-based search across the specified scope(s).
 *
 * @param req - Express request with body: { agentId, context, scope?, limit?, projectPath? }
 * @param res - Express response returning { success, data: RecallResult }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/memory/recall
 * {
 *   "agentId": "dev-001",
 *   "context": "error handling in API endpoints",
 *   "scope": "both",
 *   "projectPath": "/path/to/project",
 *   "limit": 10
 * }
 * ```
 */
export async function recall(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { agentId, context, scope, limit, projectPath } = req.body;

    if (!agentId || !context) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: agentId, context',
      });
      return;
    }

    const resolvedScope: MemoryScope = scope || 'both';
    if (!VALID_RECALL_SCOPES.has(resolvedScope)) {
      res.status(400).json({
        success: false,
        error: `Invalid scope '${resolvedScope}'. Must be one of: ${[...VALID_RECALL_SCOPES].join(', ')}`,
      });
      return;
    }

    if ((resolvedScope === 'project' || resolvedScope === 'both') && !projectPath) {
      res.status(400).json({
        success: false,
        error: 'projectPath is required when scope is "project" or "both"',
      });
      return;
    }

    const memoryService = MemoryService.getInstance();
    const result = await memoryService.recall({
      agentId,
      context,
      scope: resolvedScope,
      limit: limit !== undefined ? Number(limit) : undefined,
      projectPath,
    });

    logger.debug('Memory recalled via REST', {
      agentId,
      scope: resolvedScope,
      agentCount: result.agentMemories.length,
      projectCount: result.projectMemories.length,
    });

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to recall memory', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/memory/supersede (Memory Phase 1 — M4)
 *
 * Mark an existing memory entry as superseded by a newer one. Both entries
 * must already exist in the agent's memory store. The old entry is hidden
 * from default recall after this call but remains in the raw store for
 * audit purposes.
 *
 * @param req - Express request with body: { agentId, oldId, newId, reason? }
 * @param res - Express response returning { success, data: SupersedeResult }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/memory/supersede
 * {
 *   "agentId": "crewly-product-max-c69ce8e6",
 *   "oldId": "rk-pricing-799",
 *   "newId": "rk-pricing-800-plus-credits",
 *   "reason": "Steve updated pricing 2026-05-01"
 * }
 * ```
 */
export async function supersedeMemory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { agentId, oldId, newId, reason } = req.body;

    if (!agentId || !oldId || !newId) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: agentId, oldId, newId',
      });
      return;
    }

    const supersessionService = MemorySupersessionService.getInstance();
    try {
      const result = await supersessionService.supersede({ agentId, oldId, newId, reason });
      logger.info('Memory entry superseded via REST', { agentId, oldId, newId });
      res.json({ success: true, data: result });
    } catch (err) {
      // Service throws on validation failures (id mismatch, missing entries,
      // missing memory store). Surface as 400 — the request was structurally
      // valid but referenced data that does not exist.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Supersede rejected', { agentId, oldId, newId, error: message });
      res.status(400).json({ success: false, error: message });
    }
  } catch (error) {
    logger.error('Failed to supersede memory', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/memory/record-learning
 *
 * Quickly record a learning or discovery. The learning is stored in
 * project memory and optionally promoted to agent memory if it contains
 * role-relevant patterns.
 *
 * @param req - Express request with body: { agentId, agentRole, projectPath, learning, relatedTask?, relatedFiles? }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/memory/record-learning
 * {
 *   "agentId": "dev-001",
 *   "agentRole": "developer",
 *   "projectPath": "/path/to/project",
 *   "learning": "Always use async/await for database operations",
 *   "relatedTask": "TICKET-456",
 *   "relatedFiles": ["src/db/queries.ts"]
 * }
 * ```
 */
export async function recordLearning(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { agentId, agentRole, projectPath, learning, relatedTask, relatedFiles } = req.body;

    if (!agentId || !agentRole || !projectPath || !learning) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: agentId, agentRole, projectPath, learning',
      });
      return;
    }

    const memoryService = MemoryService.getInstance();
    await memoryService.recordLearning({
      agentId,
      agentRole,
      projectPath,
      learning,
      relatedTask,
      relatedFiles,
    });

    logger.info('Learning recorded via REST', { agentId, agentRole, projectPath });

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to record learning', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/memory/goals
 *
 * Set or append a project goal.
 *
 * @param req - Express request with body: { goal, projectPath, setBy? }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 */
export async function setGoal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { goal, projectPath, setBy } = req.body;

    if (!goal || !projectPath) {
      res.status(400).json({ success: false, error: 'Missing required parameters: goal, projectPath' });
      return;
    }

    const service = GoalTrackingService.getInstance();
    await service.setGoal(projectPath, goal, setBy);

    logger.info('Goal set via REST', { projectPath, setBy });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to set goal', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * GET /api/memory/goals
 *
 * Get active project goals.
 *
 * @param req - Express request with query: { projectPath }
 * @param res - Express response returning { success, data }
 * @param next - Express next function for error propagation
 */
export async function getGoals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const projectPath = req.query.projectPath as string;

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'Missing required query parameter: projectPath' });
      return;
    }

    const service = GoalTrackingService.getInstance();
    const data = await service.getGoals(projectPath);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get goals', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * POST /api/memory/focus
 *
 * Update the team's current focus.
 *
 * @param req - Express request with body: { focus, projectPath, updatedBy? }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 */
export async function updateFocus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { focus, projectPath, updatedBy } = req.body;

    if (!focus || !projectPath) {
      res.status(400).json({ success: false, error: 'Missing required parameters: focus, projectPath' });
      return;
    }

    const service = GoalTrackingService.getInstance();
    await service.updateFocus(projectPath, focus, updatedBy);

    logger.info('Focus updated via REST', { projectPath, updatedBy });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update focus', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * GET /api/memory/focus
 *
 * Get the team's current focus.
 *
 * @param req - Express request with query: { projectPath }
 * @param res - Express response returning { success, data }
 * @param next - Express next function for error propagation
 */
export async function getFocus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const projectPath = req.query.projectPath as string;

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'Missing required query parameter: projectPath' });
      return;
    }

    const service = GoalTrackingService.getInstance();
    const data = await service.getCurrentFocus(projectPath);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get focus', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * POST /api/memory/daily-log
 *
 * Append an entry to today's daily log.
 *
 * @param req - Express request with body: { projectPath, agentId, role, entry }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 */
export async function appendDailyLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { projectPath, agentId, role, entry } = req.body;

    if (!projectPath || !agentId || !role || !entry) {
      res.status(400).json({ success: false, error: 'Missing required parameters: projectPath, agentId, role, entry' });
      return;
    }

    const service = DailyLogService.getInstance();
    await service.appendEntry(projectPath, agentId, role, entry);

    logger.debug('Daily log appended via REST', { projectPath, agentId, role });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to append daily log', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * GET /api/memory/daily-log
 *
 * Get today's daily log.
 *
 * @param req - Express request with query: { projectPath }
 * @param res - Express response returning { success, data }
 * @param next - Express next function for error propagation
 */
export async function getDailyLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const projectPath = req.query.projectPath as string;

    if (!projectPath) {
      res.status(400).json({ success: false, error: 'Missing required query parameter: projectPath' });
      return;
    }

    const service = DailyLogService.getInstance();
    const data = await service.getTodaysLog(projectPath);

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get daily log', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * POST /api/memory/record-success
 *
 * Record a successful pattern or approach.
 *
 * @param req - Express request with body: { projectPath, teamMemberId, description, context? }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 */
export async function recordSuccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { projectPath, teamMemberId, description, context, role, supersedes } = req.body;

    if (!projectPath || !description) {
      res.status(400).json({ success: false, error: 'Missing required parameters: projectPath, description' });
      return;
    }

    const service = LearningAccumulationService.getInstance();
    await service.recordSuccess(projectPath, teamMemberId || 'unknown', role || 'unknown', description, context, supersedes);

    logger.info('Success recorded via REST', { projectPath, teamMemberId, supersedes });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to record success', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * POST /api/memory/record-failure
 *
 * Record a failed approach or pitfall to avoid.
 *
 * @param req - Express request with body: { projectPath, teamMemberId, description, context? }
 * @param res - Express response returning { success }
 * @param next - Express next function for error propagation
 */
export async function recordFailure(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { projectPath, teamMemberId, description, context, role, supersedes } = req.body;

    if (!projectPath || !description) {
      res.status(400).json({ success: false, error: 'Missing required parameters: projectPath, description' });
      return;
    }

    const service = LearningAccumulationService.getInstance();
    await service.recordFailure(projectPath, teamMemberId || 'unknown', role || 'unknown', description, context, supersedes);

    logger.info('Failure recorded via REST', { projectPath, teamMemberId, supersedes });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to record failure', { error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
}

/**
 * POST /api/memory/my-context
 *
 * Retrieve combined context for an agent, including relevant memories,
 * project goals, current focus, today's daily log, and recent learnings.
 * This provides a single-call context briefing for agent startup or task transitions.
 *
 * @param req - Express request with body: { agentId, agentRole, projectPath }
 * @param res - Express response returning { success, data: { memories, goals, focus, dailyLog, learnings } }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/memory/my-context
 * {
 *   "agentId": "dev-001",
 *   "agentRole": "developer",
 *   "projectPath": "/path/to/project"
 * }
 * ```
 */
export async function getMyContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { agentId, agentRole, projectPath } = req.body;

    if (!agentId || !agentRole || !projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters: agentId, agentRole, projectPath',
      });
      return;
    }

    // Gather context from all memory subsystems in parallel
    const memoryService = MemoryService.getInstance();
    const goalService = GoalTrackingService.getInstance();
    const dailyLogService = DailyLogService.getInstance();
    const learningService = LearningAccumulationService.getInstance();
    const knowledgeService = KnowledgeService.getInstance();

    const [memories, goals, focus, dailyLog, successes, failures, globalKnowledgeDocs, projectKnowledgeDocs] = await Promise.all([
      memoryService.recall({
        agentId,
        context: `${agentRole} agent context for current work`,
        scope: 'both',
        projectPath,
      }),
      goalService.getGoals(projectPath),
      goalService.getCurrentFocus(projectPath),
      dailyLogService.getTodaysLog(projectPath),
      learningService.getSuccesses(projectPath, LEARNING_TAIL_CHARS),
      learningService.getFailures(projectPath, LEARNING_TAIL_CHARS),
      knowledgeService.listDocuments('global').catch(() => []),
      knowledgeService.listDocuments('project', projectPath).catch(() => []),
    ]);

    logger.debug('Agent context retrieved via REST', { agentId, agentRole, projectPath });

    res.json({
      success: true,
      data: {
        memories,
        goals,
        focus,
        dailyLog,
        learnings: {
          successes,
          failures,
        },
        knowledgeDocs: {
          global: globalKnowledgeDocs,
          project: projectKnowledgeDocs,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get agent context', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/memory/user-profile
 *
 * Get the shared user profile. Returns the full profile object,
 * or an empty object if no profile has been created yet.
 *
 * @param req - Express request (no parameters required)
 * @param res - Express response returning { success, data: SharedUserProfile }
 */
export async function getUserProfile(req: Request, res: Response): Promise<void> {
  try {
    const userProfileService = UserProfileService.getInstance();
    const profile = await userProfileService.getProfile();
    res.json({ success: true, data: profile });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get user profile' });
  }
}

/**
 * POST /api/memory/user-profile
 *
 * Update the shared user profile with a partial merge.
 * The `updatedBy` field is required to track who made the change.
 *
 * Merge strategy:
 * - Top-level scalars are overwritten
 * - `preferences` is shallow-merged
 * - `notes` and `prohibitions` are appended (deduplicated)
 *
 * @param req - Express request with body: { updatedBy, ...profileFields }
 * @param res - Express response returning { success, data: SharedUserProfile }
 *
 * @example
 * ```
 * POST /api/memory/user-profile
 * {
 *   "updatedBy": "crewly-orc",
 *   "language": "zh-CN",
 *   "reportingStyle": "detailed"
 * }
 * ```
 */
export async function updateUserProfile(req: Request, res: Response): Promise<void> {
  try {
    const { updatedBy, ...updates } = req.body;
    if (!updatedBy) {
      res.status(400).json({ success: false, error: 'updatedBy is required' });
      return;
    }
    const userProfileService = UserProfileService.getInstance();
    const profile = await userProfileService.updateProfile(updates, updatedBy);
    res.json({ success: true, data: profile });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
}
