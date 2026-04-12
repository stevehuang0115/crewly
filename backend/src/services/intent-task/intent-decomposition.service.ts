/**
 * Intent Decomposition Service — Utility Layer
 *
 * Lightweight utility for pre-filtering non-actionable messages and
 * providing regex-based fallback decomposition.
 *
 * Architecture: The orchestrator LLM (Claude Code) performs the actual
 * intent decomposition using its own reasoning — no separate LLM API call
 * is needed. The orchestrator then calls POST /api/intent-tasks/batch
 * with structured task data.
 *
 * This service provides:
 * - Pre-filtering: quickly reject obviously non-actionable messages
 * - Regex fallback: basic decomposition when LLM-based flow is unavailable
 * - Task creation: wraps IntentTaskService for convenience
 *
 * @module services/intent-task/intent-decomposition.service
 */

import { IntentTaskService } from './intent-task.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type {
  IntentTask,
  DecomposedIntent,
} from '../../types/intent-task.types.js';
import {
  decomposeIntents,
} from '../../types/intent-task.types.js';
import { FissionGuardService } from '../fission/fission-guard.service.js';

// =============================================================================
// Constants
// =============================================================================

/** Maximum message length to process (skip extremely long pastes) */
const MAX_MESSAGE_LENGTH = 4000;

/** Minimum message length to bother with decomposition */
const MIN_MESSAGE_LENGTH = 5;

// =============================================================================
// Service
// =============================================================================

/**
 * Utility service for intent task decomposition.
 *
 * The primary decomposition path is:
 * 1. Orchestrator LLM receives a user message
 * 2. Orchestrator extracts tasks using its own reasoning
 * 3. Orchestrator calls POST /api/intent-tasks/batch with structured data
 *
 * This service provides a fallback regex-based path and pre-filtering utilities.
 *
 * @example
 * ```typescript
 * const service = IntentDecompositionService.getInstance();
 *
 * // Check if a message is worth processing
 * if (!service.isObviouslyNonActionable(message)) {
 *   // Let the orchestrator LLM handle decomposition
 * }
 *
 * // Fallback: regex-based decomposition
 * const tasks = service.decomposeWithRegexAndCreate(message, chatMessageId);
 * ```
 */
export class IntentDecompositionService {
  private static instance: IntentDecompositionService | null = null;

  private readonly logger: ComponentLogger;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('IntentDecomposition');
  }

  /**
   * Get the singleton instance.
   *
   * @returns Shared IntentDecompositionService instance
   */
  static getInstance(): IntentDecompositionService {
    if (!IntentDecompositionService.instance) {
      IntentDecompositionService.instance = new IntentDecompositionService();
    }
    return IntentDecompositionService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    IntentDecompositionService.instance = null;
  }

  // ===========================================================================
  // Pre-filters
  // ===========================================================================

  /**
   * Quick pre-filter to skip obviously non-actionable messages.
   * Used by the orchestrator to decide whether to bother with
   * intent extraction for a given message.
   *
   * @param message - Trimmed message
   * @returns true if the message is obviously not actionable
   */
  isObviouslyNonActionable(message: string): boolean {
    const trimmed = message.trim();

    // Too short to be meaningful
    if (trimmed.length < 3) return true;

    // Pure greetings
    if (/^(hi|hello|hey|yo|sup|thanks|thank\s+you|thx|bye|goodbye|welcome\s+back)\s*[.!]?$/i.test(trimmed)) return true;

    // Pure acknowledgments
    if (/^(ok|okay|sure|got\s+it|yes|no|yep|yup|yeah|nah|nope|alright|fine|great|perfect|awesome|cool|nice|lgtm|noted|agreed)\s*[.!]?$/i.test(trimmed)) return true;

    // Emoji-only
    if (/^[\p{Emoji}\s.,!?]+$/u.test(trimmed)) return true;

    return false;
  }

  /**
   * Check if a message is within processable bounds.
   *
   * @param message - Raw message
   * @returns true if the message length is within bounds for processing
   */
  isWithinBounds(message: string): boolean {
    const len = message.trim().length;
    return len >= MIN_MESSAGE_LENGTH && len <= MAX_MESSAGE_LENGTH;
  }

  // ===========================================================================
  // Regex Fallback
  // ===========================================================================

  /**
   * Regex-based decomposition fallback.
   * Uses heuristic pattern matching to split messages into intents.
   *
   * @param message - User message
   * @returns Array of decomposed intents
   */
  decomposeWithRegex(message: string): DecomposedIntent[] {
    const result = decomposeIntents(message);
    return result.intents;
  }

  /**
   * Regex-based decomposition with automatic task creation.
   * Falls back to this when the orchestrator LLM path is unavailable.
   *
   * @param message - User message
   * @param chatMessageId - Chat message ID for correlation
   * @returns Array of created IntentTasks
   */
  decomposeWithRegexAndCreate(message: string, chatMessageId: string): IntentTask[] {
    const trimmed = message.trim();

    if (!this.isWithinBounds(trimmed) || this.isObviouslyNonActionable(trimmed)) {
      return [];
    }

    const decomposed = this.decomposeWithRegex(trimmed);
    if (decomposed.length === 0) {
      return [];
    }

    // Fission guard: check rate limit before creating tasks via regex fallback
    try {
      const fissionGuard = FissionGuardService.getInstance();
      const rateCheck = fissionGuard.checkRateLimit('system-decomposition');
      if (!rateCheck.allowed) {
        this.logger.warn('Fission guard blocked regex decomposition', {
          chatMessageId,
          reason: rateCheck.reason,
        });
        return [];
      }
    } catch {
      // FissionGuardService not initialized — skip (non-fatal)
    }

    const taskService = IntentTaskService.getInstance();
    const tasks = taskService.batchCreateTasks({
      originalMessage: trimmed,
      tasks: decomposed.map((d, index) => ({
        intent: d.intent,
        level: d.level,
        category: d.category,
        order: index,
      })),
    });

    this.logger.info('Intent tasks created via regex fallback', {
      chatMessageId,
      taskCount: tasks.length,
    });

    return tasks;
  }
}
