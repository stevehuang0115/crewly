/**
 * Memory Supersession Service (Memory Phase 1 — M4)
 *
 * Provides explicit supersession of agent memory entries: when a fact is
 * updated (e.g. "Pro pricing was $799 → now $800 + 1000 credits"), instead
 * of leaving both entries to confuse default recall, an agent or TL marks
 * the old entry as superseded by the new one. After supersession:
 *
 * - Old entry's `supersededBy` is set to the new entry's id.
 * - Old entry's `superseded` boolean is also set (legacy v2 field, kept for
 *   filter compatibility with existing scoring code).
 * - Old entry's `evidence` is extended with `supersession-reason:<reason>`
 *   so the audit trail survives.
 * - The old entry remains in the raw memory store (for audit) but is hidden
 *   by default recall (see {@link AgentMemoryService.isHiddenFromDefaultRecall}).
 *
 * @module services/memory/memory-supersession.service
 */

import { AgentMemoryService } from './agent-memory.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import type { RoleKnowledgeEntry } from '../../types/memory.types.js';

/**
 * Result of a supersede operation.
 */
export interface SupersedeResult {
  /** Old entry id that was just marked as superseded */
  oldId: string;
  /** New entry id that supersedes the old one */
  newId: string;
  /** ISO timestamp when supersession was recorded */
  supersededAt: string;
  /** Reason provided by caller (echoed back for confirmation) */
  reason?: string;
}

/**
 * Parameters for {@link MemorySupersessionService.supersede}.
 */
export interface SupersedeParams {
  /** Agent whose memory store contains both entries */
  agentId: string;
  /** Id of the entry being superseded */
  oldId: string;
  /** Id of the new entry that replaces the old one */
  newId: string;
  /** Optional human-readable reason; appended to old entry's evidence */
  reason?: string;
}

/**
 * Public interface of {@link MemorySupersessionService}.
 */
export interface IMemorySupersessionService {
  supersede(params: SupersedeParams): Promise<SupersedeResult>;
}

/**
 * Coordinates explicit supersession of memory entries.
 *
 * Singleton; delegates to {@link AgentMemoryService} for the actual disk read
 * + write so we don't bypass cache invalidation or atomic-write semantics.
 *
 * @example
 * ```typescript
 * const supersession = MemorySupersessionService.getInstance();
 * const result = await supersession.supersede({
 *   agentId: 'crewly-product-max-c69ce8e6',
 *   oldId: 'rk-pricing-799',
 *   newId: 'rk-pricing-800-plus-credits',
 *   reason: 'Steve updated pricing 2026-05-01: $800 + 1000 credits + overage',
 * });
 * // result.supersededAt = '2026-05-03T18:00:00.000Z'
 * ```
 */
export class MemorySupersessionService implements IMemorySupersessionService {
  private static instance: MemorySupersessionService | null = null;
  private readonly agentMemory: AgentMemoryService;
  private readonly logger: ComponentLogger;

  private constructor(agentMemory?: AgentMemoryService) {
    this.agentMemory = agentMemory ?? AgentMemoryService.getInstance();
    this.logger = LoggerService.getInstance().createComponentLogger('MemorySupersessionService');
  }

  /**
   * Get singleton instance. Pass `agentMemory` in tests to inject a custom
   * AgentMemoryService bound to a test directory.
   *
   * @param agentMemory - Optional custom AgentMemoryService for testing
   * @returns Singleton instance
   */
  public static getInstance(agentMemory?: AgentMemoryService): MemorySupersessionService {
    // If a custom agentMemory is provided (test path), always rebuild — it may
    // point at a different test dir than the cached singleton.
    if (agentMemory || !MemorySupersessionService.instance) {
      MemorySupersessionService.instance = new MemorySupersessionService(agentMemory);
    }
    return MemorySupersessionService.instance;
  }

  /**
   * Clear singleton instance — for test isolation.
   */
  public static clearInstance(): void {
    MemorySupersessionService.instance = null;
  }

  /**
   * Mark `oldId` as superseded by `newId` in the given agent's memory store.
   *
   * Validates:
   * - both ids resolve to existing entries
   * - they are not the same id (a memory cannot supersede itself)
   *
   * The write goes through `AgentMemoryService` so cache invalidation +
   * atomic file replacement are honored.
   *
   * @param params - Supersede parameters
   * @returns Result describing the supersession
   * @throws Error if the agent has no memory, either id is missing, or ids match
   */
  public async supersede(params: SupersedeParams): Promise<SupersedeResult> {
    const { agentId, oldId, newId, reason } = params;

    if (oldId === newId) {
      throw new Error(`oldId and newId must differ (got "${oldId}")`);
    }

    const memory = await this.agentMemory.getAgentMemory(agentId);
    if (!memory) {
      throw new Error(`Agent "${agentId}" has no memory store`);
    }

    const oldEntry = memory.roleKnowledge.find((e) => e.id === oldId);
    if (!oldEntry) {
      throw new Error(`Old memory entry "${oldId}" not found for agent "${agentId}"`);
    }

    const newEntry = memory.roleKnowledge.find((e) => e.id === newId);
    if (!newEntry) {
      throw new Error(`New memory entry "${newId}" not found for agent "${agentId}"`);
    }

    const supersededAt = new Date().toISOString();

    // Mutate the old entry in-memory. Both `superseded` and `supersededBy`
    // are set so downstream filters that check either field treat it as hidden.
    const evidenceTag = reason
      ? `supersession-reason:${reason}`
      : `supersession:${supersededAt}`;
    const updated: RoleKnowledgeEntry = {
      ...oldEntry,
      superseded: true,
      supersededBy: newId,
      evidence: [...(oldEntry.evidence ?? []), evidenceTag],
    };

    // Replace in-array — preserves order.
    const idx = memory.roleKnowledge.findIndex((e) => e.id === oldId);
    memory.roleKnowledge[idx] = updated;

    // Persist via the same path as other AgentMemoryService writes so cache
    // invalidation + atomic file write semantics are respected.
    await this.agentMemory.saveSupersededMemory(agentId, memory);

    this.logger.info('Memory entry superseded', {
      agentId,
      oldId,
      newId,
      hasReason: Boolean(reason),
    });

    return { oldId, newId, supersededAt, reason };
  }
}
