/**
 * Memory Service Coordinator
 *
 * Provides a unified interface for both agent-level and project-level memory services.
 * Handles cross-cutting concerns like logging, validation, and combined context generation.
 *
 * @module services/memory/memory.service
 */

import * as path from 'path';
import { existsSync, readdirSync } from 'fs';
import { AgentMemoryService, IAgentMemoryService } from './agent-memory.service.js';
import { ProjectMemoryService, IProjectMemoryService, SearchResults } from './project-memory.service.js';
import { LoggerService } from '../core/logger.service.js';
import { WikiSearchService } from '../wiki/wiki-search.service.js';
import { WikiIngestService } from '../wiki/wiki-ingest.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import { isHiddenFromDefaultRecall } from './role-knowledge-eligibility.js';
import { CREWLY_CONSTANTS, MEMORY_CONSTANTS } from '../../constants.js';
import type {
  RoleKnowledgeEntry,
  RoleKnowledgeCategory,
  PatternCategory,
  GotchaSeverity,
  AgentPreferences,
  ProjectAgentsIndex,
  TaskHistoryEntry,
} from '../../types/memory.types.js';

/**
 * Categories for the unified remember operation
 */
export type RememberCategory =
  | 'fact'
  | 'pattern'
  | 'decision'
  | 'gotcha'
  | 'preference'
  | 'user_preference'
  | 'relationship';

/**
 * Scope for memory operations
 */
export type MemoryScope = 'agent' | 'project' | 'both';

/**
 * Parameters for the remember operation
 */
export interface RememberParams {
  /** Agent identifier */
  agentId: string;
  /** Project path (required for project scope) */
  projectPath?: string;
  /** Content to remember */
  content: string;
  /** Category of memory */
  category: RememberCategory;
  /** Scope: agent or project */
  scope: 'agent' | 'project';
  /** Additional metadata */
  metadata?: {
    /** Task ID where this was learned */
    taskId?: string;
    /** Title for patterns/decisions/gotchas */
    title?: string;
    /** Pattern category */
    patternCategory?: PatternCategory;
    /** Code example */
    example?: string;
    /** Related files */
    files?: string[];
    /** Rationale for decisions */
    rationale?: string;
    /** Alternatives considered for decisions */
    alternatives?: string[];
    /** Areas affected by decisions */
    affectedAreas?: string[];
    /** Solution for gotchas */
    solution?: string;
    /** Severity for gotchas */
    severity?: GotchaSeverity;
    /** Relationship type */
    relationshipType?: 'depends-on' | 'uses' | 'extends' | 'implements' | 'calls' | 'imported-by';
    /** Target component for relationships */
    targetComponent?: string;

    // === v2: Task-linked provenance ===

    /** Task ID where this knowledge was learned */
    sourceTaskId?: string;
    /** Objective/goal ID this knowledge relates to */
    sourceObjectiveId?: string;
    /** Outcome of the task where this was learned */
    sourceOutcome?: string;
    /** What contexts/domains this knowledge applies to */
    appliesTo?: string[];
    /** ID of entry being superseded by this one */
    supersedes?: string;
  };
}

/**
 * Parameters for the recall operation
 */
export interface RecallParams {
  /** Agent identifier */
  agentId: string;
  /** Project path (required for project/both scope) */
  projectPath?: string;
  /** Context/query for finding relevant memories */
  context: string;
  /** Scope: agent, project, or both */
  scope: MemoryScope;
  /** Maximum number of results */
  limit?: number;
  /**
   * v3 (M4 — NOTE-A): Include entries that are normally hidden from default
   * recall (superseded or TTL-expired entries). Default `false`.
   *
   * Use this to surface audit-only memories — e.g. when a TL is reviewing
   * what an agent learned before a fact was superseded, or when a debugging
   * tool needs the full trail. Production prompt-injection paths must keep
   * this `false` (or unset) so superseded entries do not pollute context.
   */
  includeHidden?: boolean;
  /**
   * Optional capability filter. When set, recall queries the project's
   * task-history ledger for entries whose `capabilities[]` contains an
   * exact match. The matching entries surface on
   * {@link RecallResult.taskHistory} sorted most-recent first.
   *
   * This is the load-bearing field for "who in my team has done X?"
   * — the orchestrator's delegation-first prompt queries with this
   * parameter before deciding whether to delegate or self-execute.
   *
   * Format: canonical `<category>:<resource>` strings
   * (`gmail:read`, `oauth:gmail`, `slack:post`, etc. — see
   * CapabilityInferenceService for the registry).
   */
  capability?: string;
}

/**
 * Result of a recall operation
 */
export interface RecallResult {
  /** Memories from agent level */
  agentMemories: string[];
  /** Memories from project level */
  projectMemories: string[];
  /** Combined formatted result */
  combined: string;

  // === v2: Operational context (lightweight, always included when available) ===

  /** Current project goals (if projectPath provided) */
  activeGoals?: string[];
  /** Current team focus (if projectPath provided) */
  currentFocus?: string;
  /** Active tasks for this agent */
  activeTasks?: Array<{ id: string; name: string; status: string; hasWorkingNotes: boolean }>;
  /**
   * Task-history entries matching {@link RecallParams.capability}. Present
   * when the caller passed a capability filter. Sorted most-recent first;
   * empty array means "no team member has demonstrated this capability."
   */
  taskHistory?: TaskHistoryEntry[];
}

/**
 * Parameters for recording a learning
 */
export interface LearningParams {
  /** Agent identifier */
  agentId: string;
  /** Agent's role */
  agentRole: string;
  /** Project path */
  projectPath: string;
  /** The learning content */
  learning: string;
  /** Related task/ticket ID */
  relatedTask?: string;
  /** Related file paths */
  relatedFiles?: string[];
}

/**
 * Interface for the unified Memory Service
 */
export interface IMemoryService {
  remember(params: RememberParams): Promise<string>;
  recall(params: RecallParams): Promise<RecallResult>;
  getFullContext(agentId: string, projectPath: string): Promise<string>;
  recordLearning(params: LearningParams): Promise<void>;
  initializeForSession(agentId: string, role: string, projectPath: string): Promise<void>;
  getAgentMemoryService(): IAgentMemoryService;
  getProjectMemoryService(): IProjectMemoryService;
}

/**
 * Unified Memory Service Coordinator
 *
 * Provides a single entry point for all memory operations, coordinating
 * between agent-level and project-level memory services.
 *
 * @example
 * ```typescript
 * const memoryService = MemoryService.getInstance();
 *
 * // Initialize for a session
 * await memoryService.initializeForSession('dev-001', 'developer', '/path/to/project');
 *
 * // Remember something
 * await memoryService.remember({
 *   agentId: 'dev-001',
 *   projectPath: '/path/to/project',
 *   content: 'Always use async/await instead of callbacks',
 *   category: 'pattern',
 *   scope: 'project',
 *   metadata: { title: 'Async Pattern' }
 * });
 *
 * // Get full context for prompts
 * const context = await memoryService.getFullContext('dev-001', '/path/to/project');
 * ```
 */
export class MemoryService implements IMemoryService {
  private static instance: MemoryService | null = null;

  private readonly agentMemory: AgentMemoryService;
  private readonly projectMemory: ProjectMemoryService;
  private readonly logger = LoggerService.getInstance().createComponentLogger('MemoryService');

  /**
   * Creates a new MemoryService instance
   */
  private constructor() {
    this.agentMemory = AgentMemoryService.getInstance();
    this.projectMemory = ProjectMemoryService.getInstance();
  }

  /**
   * Backwards-compatible no-op. Kept so existing call sites in `index.ts`
   * compile during the TaskTrackingService deletion window. Operational
   * context enrichment now reads from the V3 task-pool directly (see
   * {@link enrichWithOperational}).
   *
   * @deprecated Will be removed in a follow-up. Do not call from new code.
   */
  public setTaskTrackingService(_service: unknown): void {
    // intentionally empty
  }

  /**
   * Resolve the wiki vault paths that back semantic recall for a given scope.
   *
   * The retired embedding/vector store has been replaced by BM25 search over
   * the LLM-wiki vaults (see {@link wikiRecallSearch}). This maps a memory
   * scope to the vaults whose `llm-curated/` content should be searched:
   *   - `project` → the project's own vault (`<projectPath>/.crewly/wiki`)
   *   - `global`  → the cross-project `~/.crewly/global-wiki` plus every team
   *     vault (`~/.crewly/teams/<id>/wiki`); agent-scope learnings are mirrored
   *     into these by {@link ingestToWiki}.
   *
   * Only vaults that actually exist (carry a `SCHEMA.md`) are returned.
   *
   * @param scope - Memory scope being recalled.
   * @param projectPath - Project root, required for `project` scope.
   * @returns Absolute vault paths to search (possibly empty).
   */
  private resolveRecallVaults(scope: 'global' | 'project', projectPath?: string): string[] {
    if (scope === 'project') {
      if (!projectPath) return [];
      const vault = path.join(projectPath, '.crewly', 'wiki');
      return existsSync(path.join(vault, 'SCHEMA.md')) ? [vault] : [];
    }
    // global: the cross-project vault + every team vault, anchored on the
    // resolved Crewly home (honours CREWLY_HOME so tests/dry-runs stay isolated
    // from the developer's real ~/.crewly). Only vaults carrying a SCHEMA.md
    // are returned; project vaults are intentionally excluded so global recall
    // stays cross-cutting rather than project-specific.
    const home = getCrewlyHomePath();
    const vaults: string[] = [];
    const globalVault = path.join(home, 'global-wiki');
    if (existsSync(path.join(globalVault, 'SCHEMA.md'))) vaults.push(globalVault);
    const teamsRoot = path.join(home, 'teams');
    if (existsSync(teamsRoot)) {
      try {
        for (const entry of readdirSync(teamsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const teamVault = path.join(teamsRoot, entry.name, 'wiki');
          if (existsSync(path.join(teamVault, 'SCHEMA.md'))) vaults.push(teamVault);
        }
      } catch {
        // partial discovery is fine — a missing/unreadable teams dir yields none
      }
    }
    return vaults;
  }

  /**
   * Gets the singleton instance of MemoryService
   *
   * @returns The singleton MemoryService instance
   */
  public static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  /**
   * Clears the singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    MemoryService.instance = null;
    AgentMemoryService.clearInstance();
    ProjectMemoryService.clearInstance();
  }

  /**
   * Gets the underlying AgentMemoryService
   *
   * @returns The AgentMemoryService instance
   */
  public getAgentMemoryService(): IAgentMemoryService {
    return this.agentMemory;
  }

  /**
   * Gets the underlying ProjectMemoryService
   *
   * @returns The ProjectMemoryService instance
   */
  public getProjectMemoryService(): IProjectMemoryService {
    return this.projectMemory;
  }

  /**
   * Maps RememberCategory to RoleKnowledgeCategory for agent memory.
   *
   * Public-API categories that map cleanly to internal storage:
   * - `fact` / `decision` → `best-practice` (positive learnings the agent should follow)
   * - `pattern` / `preference` → `workflow` (how-to / process knowledge)
   * - `gotcha` → `anti-pattern` (things to avoid; F4 fix 2026-05-06)
   *
   * Categories that do NOT reach this mapper because `rememberForAgent`
   * routes them differently or rejects them: `relationship` and
   * `user_preference` are project-only by design.
   */
  private mapToKnowledgeCategory(category: RememberCategory): RoleKnowledgeCategory {
    switch (category) {
      case 'fact':
      case 'decision':
        return 'best-practice';
      case 'pattern':
      case 'preference':
        return 'workflow';
      case 'gotcha':
        return 'anti-pattern';
      default:
        return 'best-practice';
    }
  }

  /**
   * Derives a content-aware title when the caller omits `metadata.title`.
   *
   * Defense-in-depth for the P0-SEV silent-success fix: even after dedup is
   * tightened to require title+content match, two different rememberings that
   * BOTH lacked an explicit title used to collide on the same default
   * ('Gotcha', 'Untitled Pattern', 'Untitled Decision'). Auto-deriving from
   * content makes those titles distinct, so any future dedup-predicate
   * regression cannot fully silently collapse them.
   *
   * Strategy: take the first ~60 chars of content, prefer a word boundary;
   * fall back to the caller-provided default if content is empty.
   *
   * @param content - The user-supplied content payload
   * @param fallback - The category-specific default title to use when content is empty
   * @returns A derived title string (max ~60 chars), never empty
   */
  private deriveTitleFromContent(content: string, fallback: string): string {
    const trimmed = (content ?? '').trim();
    if (trimmed.length === 0) return fallback;
    if (trimmed.length <= 60) return trimmed;

    // Try to cut on a word boundary near 60 chars; require at least 30 chars
    // before falling back to a hard char-cut, to avoid 'Th...' style stubs.
    const wordBoundary = trimmed.lastIndexOf(' ', 60);
    if (wordBoundary >= 30) {
      return trimmed.substring(0, wordBoundary).trim();
    }
    return trimmed.substring(0, 60).trim();
  }

  /**
   * Parses a preference string into AgentPreferences
   */
  private parsePreference(content: string): Partial<AgentPreferences> {
    // Simple parsing - in practice this would be more sophisticated
    const preferences: Partial<AgentPreferences> = {};

    const lowerContent = content.toLowerCase();

    if (lowerContent.includes('concise') || lowerContent.includes('brief')) {
      preferences.communicationStyle = {
        verbosity: 'concise',
        askBeforeAction: true,
      };
    } else if (lowerContent.includes('detailed') || lowerContent.includes('verbose')) {
      preferences.communicationStyle = {
        verbosity: 'detailed',
        askBeforeAction: true,
      };
    }

    if (lowerContent.includes('small task') || lowerContent.includes('small chunk')) {
      preferences.workPatterns = { breakdownSize: 'small' };
    } else if (lowerContent.includes('large task') || lowerContent.includes('large chunk')) {
      preferences.workPatterns = { breakdownSize: 'large' };
    }

    return preferences;
  }

  /**
   * Checks if a learning is role-relevant (should be stored in agent memory)
   */
  private isRoleRelevant(learning: string): boolean {
    const roleKeywords = [
      'always', 'never', 'should', 'must', 'prefer', 'avoid',
      'best practice', 'pattern', 'convention', 'standard',
      'remember to', 'don\'t forget', 'important to'
    ];

    const lowerLearning = learning.toLowerCase();
    return roleKeywords.some(keyword => lowerLearning.includes(keyword));
  }

  /**
   * Filters memories by relevance to a context.
   *
   * **M3 (spec §183-187):** Default recall hides superseded and expired
   * entries via {@link isHiddenFromDefaultRecall}. They remain in the raw
   * store for audit / explicit recall, but they no longer pollute the
   * agent's recall path.
   *
   * **M4 (NOTE-A):** Pass `includeHidden=true` to surface superseded /
   * expired entries (audit-only paths). Production prompt-injection callers
   * must leave this `false` (default).
   */
  private filterRelevant(
    knowledge: RoleKnowledgeEntry[],
    context: string,
    limit?: number,
    includeHidden = false,
  ): string[] {
    const contextWords = context.toLowerCase().split(/\s+/);

    const scored = knowledge
      .filter(entry => includeHidden || !isHiddenFromDefaultRecall(entry))
      .map(entry => {
        const contentWords = entry.content.toLowerCase().split(/\s+/);
        const matchCount = contextWords.filter(word =>
          contentWords.some(cw => cw.includes(word) || word.includes(cw))
        ).length;
        return {
          entry,
          score: matchCount * (entry.confidence ?? 0.7),
        };
      });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 10)
      .map(s => `[${s.entry.category}] ${s.entry.content}`);
  }

  /**
   * Formats search results into strings
   */
  private formatSearchResults(results: SearchResults, limit?: number): string[] {
    const formatted: string[] = [];
    const maxPerType = Math.ceil((limit || 10) / 4);

    results.patterns.slice(0, maxPerType).forEach(p => {
      formatted.push(`[pattern] ${p.title}: ${p.description}`);
    });

    results.decisions.slice(0, maxPerType).forEach(d => {
      formatted.push(`[decision] ${d.title}: ${d.decision}`);
    });

    results.gotchas.slice(0, maxPerType).forEach(g => {
      formatted.push(`[gotcha] ${g.title}: ${g.problem} → ${g.solution}`);
    });

    results.relationships.slice(0, maxPerType).forEach(r => {
      formatted.push(`[relationship] ${r.from} ${r.relationshipType} ${r.to}`);
    });

    return formatted.slice(0, limit || 10);
  }

  /**
   * Combines agent and project memories into a formatted string
   */
  /**
   * Combines agent and project memories into a formatted string.
   *
   * Separates completed task markers (#219) into their own section so
   * orchestrators and PMs can easily identify work that is already done
   * and avoid re-delegating it.
   *
   * @param result - The recall result containing agent and project memories
   * @returns Formatted combined string with clear section headings
   */
  private combineMemories(result: RecallResult): string {
    const sections: string[] = [];

    // Separate completed task markers from regular agent memories (#219)
    const completedAgentTasks = result.agentMemories.filter(m => m.includes('[COMPLETED]'));
    const otherAgentMemories = result.agentMemories.filter(m => !m.includes('[COMPLETED]'));

    if (otherAgentMemories.length > 0) {
      sections.push('### From Your Experience\n' + otherAgentMemories.map(m => `- ${m}`).join('\n'));
    }

    // Separate completed task markers from regular project memories (#219)
    const completedProjectTasks = result.projectMemories.filter(m => m.includes('[COMPLETED]'));
    const otherProjectMemories = result.projectMemories.filter(m => !m.includes('[COMPLETED]'));

    if (otherProjectMemories.length > 0) {
      sections.push('### From Project Knowledge\n' + otherProjectMemories.map(m => `- ${m}`).join('\n'));
    }

    // Deduplicated completed tasks section (#219)
    const allCompleted = [...new Set([...completedAgentTasks, ...completedProjectTasks])];
    if (allCompleted.length > 0) {
      sections.push(
        '### Completed Tasks (do NOT re-delegate)\n' +
        allCompleted.map(m => `- ${m}`).join('\n'),
      );
    }


    return sections.join('\n\n');
  }

  /**
   * Mirror a remembered learning into the LLM-wiki so BM25 recall can surface
   * it. Replaces the retired embed-into-vector-store path: instead of computing
   * an embedding (the Gemini model was retired → 404), we append the content to
   * the target vault's `llm-curated/log.md` via {@link WikiIngestService}.
   *
   * No-ops silently when the target vault does not exist yet (no SCHEMA.md) so a
   * first-run machine without an initialised wiki still stores the file-based
   * memory without error. Fire-and-forget; never throws.
   *
   * @param id - Unique identifier for the memory entry (used as the source ref).
   * @param content - Text content to ingest.
   * @param metadata - Memory metadata (category/title surface in the log header).
   * @param scope - Storage scope ('global' → global-wiki, 'project' → project vault).
   * @param projectPath - Required when scope is 'project'.
   */
  private async ingestToWiki(
    id: string,
    content: string,
    metadata: Record<string, unknown>,
    scope: 'global' | 'project',
    projectPath?: string,
  ): Promise<void> {
    const vaultPath =
      scope === 'project'
        ? projectPath
          ? path.join(projectPath, '.crewly', 'wiki')
          : null
        : path.join(getCrewlyHomePath(), 'global-wiki');
    if (!vaultPath || !existsSync(path.join(vaultPath, 'SCHEMA.md'))) return;

    const title = typeof metadata['title'] === 'string' ? (metadata['title'] as string) : '';
    const category = typeof metadata['category'] === 'string' ? (metadata['category'] as string) : 'memory';
    const agentId = typeof metadata['agentId'] === 'string' ? (metadata['agentId'] as string) : undefined;
    const body = title ? `**${title}** (${category})\n\n${content}` : `(${category}) ${content}`;

    try {
      const outcome = await WikiIngestService.getInstance().ingest({
        vaultPath,
        sourceType: 'record_learning',
        sourceRef: id,
        sourceBody: body,
        callerSession: agentId,
      });
      if (outcome.ok) {
        this.logger.debug('Mirrored memory into wiki for BM25 recall', { id, scope, vaultPath });
      } else {
        this.logger.debug('Wiki ingest refused memory (non-fatal)', { id, reason: outcome.reason });
      }
    } catch (error) {
      this.logger.debug('Failed to ingest memory into wiki (non-fatal)', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * BM25 full-text search over the LLM-wiki vaults backing semantic recall.
   * Replaces the retired embedding/vector-store search: ranks `.md` pages by
   * Okapi BM25 (see {@link WikiSearchService}) — CJK-aware, no external index,
   * no API key. Falls back gracefully to empty results when no vault exists.
   *
   * @param context - Search query text.
   * @param scope - Storage scope ('global' or 'project').
   * @param projectPath - Required when scope is 'project'.
   * @param limit - Maximum number of results.
   * @returns Formatted memory strings from the BM25 search.
   */
  private async wikiRecallSearch(
    context: string,
    scope: 'global' | 'project',
    projectPath?: string,
    limit: number = 5,
  ): Promise<string[]> {
    const vaultPaths = this.resolveRecallVaults(scope, projectPath);
    if (vaultPaths.length === 0) return [];

    try {
      const outcome = await WikiSearchService.getInstance().searchAllVaults({
        vaults: vaultPaths.map((vaultPath) => ({ vaultPath, label: this.wikiVaultLabel(vaultPath) })),
        query: context,
      });
      if (!outcome.ok) return [];

      return outcome.hits.slice(0, limit).map((hit) => {
        const where = hit.vaultLabel ? `${hit.vaultLabel}/${hit.relativePath}` : hit.relativePath;
        const snippet = hit.snippets[0]?.text ?? '';
        return `[wiki:${where}] ${snippet} (score ${hit.score.toFixed(1)})`;
      });
    } catch (error) {
      this.logger.debug('Wiki BM25 recall failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Merge BM25 wiki hits into a base list of memory strings, de-duplicating
   * and capping the result to `limit`. The base (file-based) memories keep
   * priority; wiki hits fill any remaining slots.
   *
   * @param base - File-based memories already collected for this scope.
   * @param extra - BM25 wiki hits to fold in.
   * @param limit - Maximum size of the merged list.
   * @returns The merged, de-duplicated, capped list.
   */
  private mergeCapped(base: string[], extra: string[], limit: number): string[] {
    const merged = [...base];
    for (const hit of extra) {
      if (merged.length >= limit) break;
      if (!merged.includes(hit)) merged.push(hit);
    }
    return merged.length > limit ? merged.slice(0, limit) : merged;
  }

  /**
   * Human-readable label for a wiki vault, derived from its path:
   * `global-wiki` → `global`, `teams/<id>/wiki` → `team:<id>`,
   * `<project>/.crewly/wiki` → the project directory name.
   *
   * @param vaultPath - Absolute vault path.
   * @returns A short label used to prefix recall hits.
   */
  private wikiVaultLabel(vaultPath: string): string {
    if (vaultPath.endsWith('global-wiki')) return 'global';
    const teamMatch = vaultPath.match(/teams[/\\]([^/\\]+)[/\\]wiki$/);
    if (teamMatch) return `team:${teamMatch[1]}`;
    const projMatch = vaultPath.match(/([^/\\]+)[/\\]\.crewly[/\\]wiki$/);
    if (projMatch) return projMatch[1] as string;
    return path.basename(vaultPath);
  }

  // ========================= PUBLIC INTERFACE =========================

  /**
   * Unified remember operation - stores content in appropriate memory
   *
   * @param params - Remember parameters
   * @returns ID of the stored memory entry
   *
   * @example
   * ```typescript
   * // Remember a pattern for the project
   * await memoryService.remember({
   *   agentId: 'dev-001',
   *   projectPath: '/path/to/project',
   *   content: 'Use error wrapper for all API endpoints',
   *   category: 'pattern',
   *   scope: 'project',
   *   metadata: {
   *     title: 'API Error Handling',
   *     patternCategory: 'api',
   *     example: 'handleApiError(handler)'
   *   }
   * });
   * ```
   */
  public async remember(params: RememberParams): Promise<string> {
    this.logger.debug('Remember called', {
      agentId: params.agentId,
      scope: params.scope,
      category: params.category,
    });

    let id: string;
    if (params.scope === 'agent') {
      id = await this.rememberForAgent(params);
    } else {
      id = await this.rememberForProject(params);
    }

    // Mirror into the LLM-wiki for BM25 recall (fire-and-forget, non-blocking)
    const wikiScope = params.scope === 'agent' ? 'global' as const : 'project' as const;
    this.ingestToWiki(
      `mem:${params.scope}:${id}`,
      params.content,
      {
        category: params.category,
        content: params.content.slice(0, 500),
        agentId: params.agentId,
        title: params.metadata?.title,
      },
      wikiScope,
      params.projectPath,
    ).catch(() => { /* non-fatal */ });

    return id;
  }

  /**
   * Stores memory at agent level.
   *
   * Valid public-API categories for agent scope:
   * - `fact`, `pattern` → role knowledge (existing behavior)
   * - `gotcha` → role knowledge with internal `anti-pattern` category
   *   (F4 fix 2026-05-06: agents can now record personal gotchas without
   *    polluting project memory).
   * - `preference` → updates AgentPreferences struct
   *
   * Categories `relationship` and `user_preference` remain project-only
   * by design (relationship describes codebase component edges;
   * user_preference is scoped to a specific project's user).
   */
  private async rememberForAgent(params: RememberParams): Promise<string> {
    switch (params.category) {
      case 'fact':
      case 'pattern':
      case 'gotcha':
        return this.agentMemory.addRoleKnowledge(params.agentId, {
          category: this.mapToKnowledgeCategory(params.category),
          content: params.content,
          learnedFrom: params.metadata?.taskId,
          confidence: 0.5,
          // v2: Task-linked provenance
          sourceTaskId: params.metadata?.sourceTaskId || params.metadata?.taskId,
          sourceObjectiveId: params.metadata?.sourceObjectiveId,
          sourceOutcome: params.metadata?.sourceOutcome as 'success' | 'failed' | 'partial' | undefined,
          appliesTo: params.metadata?.appliesTo as string[] | undefined,
        });

      case 'preference':
        await this.agentMemory.updatePreferences(
          params.agentId,
          this.parsePreference(params.content)
        );
        return 'preference-updated';

      default:
        // Steve 2026-05-15 dogfood: agents (Sam, Atlas) repeatedly called
        // `category=decision, scope=agent` for completion summaries.
        // Throwing here dropped the memory content entirely. Coerce
        // instead of reject — preserve the data, warn so the agent's
        // next call uses the right shape, and prefer auto-promoting to
        // project scope when a projectPath is available (the content
        // usually IS a project-level decision).
        if (params.projectPath) {
          this.logger.warn(
            'Coerced project-only category to project scope (was agent scope)',
            {
              agentId: params.agentId,
              originalCategory: params.category,
              originalScope: 'agent',
              coercedScope: 'project',
              projectPath: params.projectPath,
            },
          );
          return this.rememberForProject(params);
        }
        // No projectPath — fall back to recording the content as a plain
        // `fact` in agent scope so we don't lose it. The agent's next
        // store attempt should pick a valid category.
        this.logger.warn(
          'Coerced project-only category to agent-scope fact (no projectPath)',
          {
            agentId: params.agentId,
            originalCategory: params.category,
            coercedCategory: 'fact',
          },
        );
        return this.agentMemory.addRoleKnowledge(params.agentId, {
          category: this.mapToKnowledgeCategory('fact'),
          content: `[coerced from category=${params.category}]\n${params.content}`,
          learnedFrom: params.metadata?.taskId,
          confidence: 0.5,
          sourceTaskId: params.metadata?.sourceTaskId || params.metadata?.taskId,
          sourceObjectiveId: params.metadata?.sourceObjectiveId,
          sourceOutcome: params.metadata?.sourceOutcome as 'success' | 'failed' | 'partial' | undefined,
          appliesTo: params.metadata?.appliesTo as string[] | undefined,
        });
    }
  }

  /**
   * Stores memory at project level
   */
  private async rememberForProject(params: RememberParams): Promise<string> {
    if (!params.projectPath) {
      throw new Error('projectPath is required for project scope');
    }

    switch (params.category) {
      case 'pattern':
        return this.projectMemory.addPattern(params.projectPath, {
          category: params.metadata?.patternCategory || 'other',
          // P0-SEV defense-in-depth: derive title from content when caller omits
          // metadata.title, instead of a static default that collides on every call.
          title: params.metadata?.title || this.deriveTitleFromContent(params.content, 'Untitled Pattern'),
          description: params.content,
          example: params.metadata?.example,
          files: params.metadata?.files,
          discoveredBy: params.agentId,
          // v2: provenance
          sourceTaskId: params.metadata?.sourceTaskId || params.metadata?.taskId,
          sourceOutcome: params.metadata?.sourceOutcome as 'success' | 'failed' | 'partial' | undefined,
        });

      case 'decision':
        return this.projectMemory.addDecision(params.projectPath, {
          title: params.metadata?.title || this.deriveTitleFromContent(params.content, 'Untitled Decision'),
          decision: params.content,
          rationale: params.metadata?.rationale || '',
          alternatives: params.metadata?.alternatives,
          decidedBy: params.agentId,
          affectedAreas: params.metadata?.affectedAreas,
        });

      case 'gotcha':
        return this.projectMemory.addGotcha(params.projectPath, {
          title: params.metadata?.title || this.deriveTitleFromContent(params.content, 'Gotcha'),
          problem: params.content,
          solution: params.metadata?.solution || '',
          severity: params.metadata?.severity || 'medium',
          discoveredBy: params.agentId,
          // v2: provenance
          sourceTaskId: params.metadata?.sourceTaskId || params.metadata?.taskId,
          sourceOutcome: params.metadata?.sourceOutcome as 'success' | 'failed' | 'partial' | undefined,
        });

      case 'relationship':
        if (!params.metadata?.targetComponent) {
          throw new Error('targetComponent is required in metadata for relationship category');
        }
        return this.projectMemory.addRelationship(params.projectPath, {
          from: params.content, // content is the source component
          to: params.metadata.targetComponent,
          relationshipType: params.metadata?.relationshipType || 'uses',
        });

      case 'user_preference':
        return this.projectMemory.addPattern(params.projectPath, {
          category: 'user_preference',
          title: params.metadata?.title || this.deriveTitleFromContent(params.content, 'User Preference'),
          description: params.content,
          example: params.metadata?.example,
          files: params.metadata?.files,
          discoveredBy: params.agentId,
        });

      default:
        throw new Error(
          `Category '${params.category}' is not valid for project scope. Use 'pattern', 'decision', 'gotcha', 'relationship', or 'user_preference'.`
        );
    }
  }

  /**
   * Unified recall operation - retrieves relevant memories
   *
   * @param params - Recall parameters
   * @returns Recall results from appropriate scopes
   *
   * @example
   * ```typescript
   * const memories = await memoryService.recall({
   *   agentId: 'dev-001',
   *   projectPath: '/path/to/project',
   *   context: 'error handling in API endpoints',
   *   scope: 'both',
   *   limit: 10
   * });
   * console.log(memories.combined);
   * ```
   */
  public async recall(params: RecallParams): Promise<RecallResult> {
    this.logger.debug('Recall called', {
      agentId: params.agentId,
      scope: params.scope,
      context: params.context.substring(0, 50),
    });

    const result: RecallResult = {
      agentMemories: [],
      projectMemories: [],
      combined: '',
    };

    // Build parallel fetch promises
    const promises: Promise<void>[] = [];

    // Fetch from agent memory
    if (params.scope === 'agent' || params.scope === 'both') {
      promises.push(
        this.agentMemory.getRoleKnowledge(params.agentId).then((knowledge) => {
          result.agentMemories = this.filterRelevant(
            knowledge,
            params.context,
            params.limit,
            params.includeHidden,
          );
        }),
      );
    }

    // Fetch from project memory
    if ((params.scope === 'project' || params.scope === 'both') && params.projectPath) {
      promises.push(
        this.projectMemory.searchAll(params.projectPath, params.context).then((searchResults) => {
          result.projectMemories = this.formatSearchResults(searchResults, params.limit);
        }),
      );
    }

    // BM25 full-text search across the LLM-wiki vaults (replaces embeddings).
    // Collect into local buffers and merge AFTER the barrier: the role-knowledge
    // and project promises ASSIGN their arrays, so merging here (rather than
    // pushing inside a concurrent `.then`) avoids a clobber race and lets us
    // enforce the caller's `limit` on the combined list.
    const semanticLimit = Math.max(3, Math.ceil((params.limit || 10) / 3));
    let agentWikiHits: string[] = [];
    let projectWikiHits: string[] = [];
    if (params.scope === 'agent' || params.scope === 'both') {
      promises.push(
        this.wikiRecallSearch(params.context, 'global', undefined, semanticLimit).then((hits) => {
          agentWikiHits = hits;
        }),
      );
    }
    if ((params.scope === 'project' || params.scope === 'both') && params.projectPath) {
      promises.push(
        this.wikiRecallSearch(params.context, 'project', params.projectPath, semanticLimit).then((hits) => {
          projectWikiHits = hits;
        }),
      );
    }

    // Capability filter — query the project task-history ledger for
    // members who have demonstrated this capability. Runs in parallel
    // with the other fetches.
    if (params.capability && params.projectPath) {
      promises.push(
        this.projectMemory
          .getTaskHistory(params.projectPath, params.capability)
          .then((entries) => {
            result.taskHistory = entries;
          })
          .catch(() => {
            // No history file yet, or read failed — surface as empty
            // rather than throwing. The orchestrator interprets [] as
            // "no prior demonstration; cold start."
            result.taskHistory = [];
          }),
      );
    }

    await Promise.all(promises);

    // Merge BM25 wiki hits into the file-based memories (dedup) and enforce the
    // caller's limit on the combined list so the wiki layer can't blow past it.
    const recallCap = params.limit && params.limit > 0 ? params.limit : 10;
    result.agentMemories = this.mergeCapped(result.agentMemories, agentWikiHits, recallCap);
    result.projectMemories = this.mergeCapped(result.projectMemories, projectWikiHits, recallCap);

    // v2: Enrich with operational context (goals, focus, active tasks)
    await this.enrichWithOperationalContext(result, params);

    result.combined = this.combineMemories(result);

    // v2: Append operational context to combined text
    if (result.activeGoals?.length || result.currentFocus || result.activeTasks?.length) {
      const opLines: string[] = ['\n### Operational Context'];
      if (result.currentFocus) opLines.push(`**Current Focus:** ${result.currentFocus}`);
      if (result.activeGoals?.length) opLines.push(`**Goals:** ${result.activeGoals.join('; ')}`);
      if (result.activeTasks?.length) {
        opLines.push('**Your Active Tasks:**');
        for (const t of result.activeTasks) {
          opLines.push(`- [${t.status}] ${t.name}${t.hasWorkingNotes ? ' (has working notes)' : ''}`);
        }
      }
      result.combined += opLines.join('\n');
    }

    // Capability-routing block — when a capability filter was active and
    // matches exist, surface a delegation-ready summary at the end so the
    // orchestrator sees "for this capability, prefer these members" in
    // its very next read.
    if (params.capability && result.taskHistory && result.taskHistory.length > 0) {
      const byMember = new Map<string, { count: number; lastAt: string; role: string }>();
      for (const entry of result.taskHistory) {
        const key = entry.agent.sessionName;
        const prior = byMember.get(key);
        if (!prior) {
          byMember.set(key, {
            count: 1,
            lastAt: entry.completedAt,
            role: entry.agent.role,
          });
        } else {
          prior.count += 1;
          if (entry.completedAt > prior.lastAt) prior.lastAt = entry.completedAt;
        }
      }
      const ranked = [...byMember.entries()].sort(
        (a, b) => b[1].lastAt.localeCompare(a[1].lastAt),
      );
      const lines: string[] = [`\n### Capability Routing — \`${params.capability}\``];
      lines.push(
        `${ranked.length} team member(s) have demonstrated this capability. Prefer delegating to them:`,
      );
      for (const [session, info] of ranked) {
        lines.push(`- **${session}** (${info.role}) — ${info.count}× last on ${info.lastAt}`);
      }
      result.combined += '\n' + lines.join('\n');
    }

    return result;
  }

  /**
   * Enrich recall result with operational context: goals, focus, active tasks.
   * All lookups are non-fatal — missing data is silently skipped.
   */
  private async enrichWithOperationalContext(result: RecallResult, params: RecallParams): Promise<void> {
    const opPromises: Promise<void>[] = [];

    if (params.projectPath) {
      opPromises.push(
        (async () => {
          try {
            const { GoalTrackingService } = await import('./goal-tracking.service.js');
            const gts = GoalTrackingService.getInstance();
            const goalsText = await gts.getGoals(params.projectPath!);
            if (goalsText) result.activeGoals = [goalsText];
            const focus = await gts.getCurrentFocus(params.projectPath!);
            if (focus) result.currentFocus = focus;
          } catch { /* non-fatal — goal tracking may not be initialized */ }
        })(),
      );
    }

    if (params.agentId) {
      opPromises.push(
        (async () => {
          try {
            // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
            // Replaces TaskTrackingService.getTasksBySessionName with a
            // direct V3 pool read + projection.
            const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
            const { projectWorkItemToInProgressTask } = await import('../v3/work-item-projection.js');
            const items = await TaskPoolService.getInstance().getAllItems();
            const tasks = items
              .filter((wi) => wi.target === params.agentId)
              .map(projectWorkItemToInProgressTask);
            const terminalStatuses = ['completed', 'verified', 'cancelled', 'done'];
            const active = tasks.filter((t) => !terminalStatuses.includes(t.status));
            if (active.length) {
              result.activeTasks = active.map((t) => ({
                id: t.id,
                name: t.taskName,
                status: t.status,
                // `workingNotes` doesn't exist on V3 — keep undefined for shape parity.
                hasWorkingNotes: false,
              }));
            }
          } catch { /* non-fatal */ }
        })(),
      );
    }

    await Promise.all(opPromises);
  }


  /**
   * Generates combined context from both agent and project memory
   *
   * @param agentId - Agent identifier
   * @param projectPath - Project path
   * @returns Combined context string for prompt injection
   */
  public async getFullContext(agentId: string, projectPath: string): Promise<string> {
    this.logger.debug('Getting full context', { agentId, projectPath });

    const [agentContext, projectContext] = await Promise.all([
      this.agentMemory.generateAgentContext(agentId),
      this.projectMemory.generateProjectContext(projectPath),
    ]);

    const sections: string[] = [];

    if (agentContext) {
      sections.push('# Your Agent Memory\n\n' + agentContext);
    }

    if (projectContext) {
      sections.push('# Project Knowledge\n\n' + projectContext);
    }

    return sections.join('\n\n---\n\n').trim();
  }

  /**
   * Records a learning to both project learnings and potentially agent memory
   *
   * @param params - Learning parameters
   */
  public async recordLearning(params: LearningParams): Promise<void> {
    this.logger.debug('Recording learning', {
      agentId: params.agentId,
      projectPath: params.projectPath,
    });

    // Record to project learnings (always)
    await this.projectMemory.recordLearning(
      params.projectPath,
      params.agentId,
      params.agentRole,
      params.learning,
      {
        relatedTask: params.relatedTask,
        relatedFiles: params.relatedFiles,
      }
    );

    // Also add to agent knowledge if it's role-relevant
    if (this.isRoleRelevant(params.learning)) {
      try {
        await this.agentMemory.addRoleKnowledge(params.agentId, {
          category: 'best-practice',
          content: params.learning,
          learnedFrom: params.relatedTask,
          confidence: 0.3, // Lower initial confidence for auto-extracted
        });
        this.logger.debug('Also added to agent knowledge', { agentId: params.agentId });
      } catch (error) {
        // Don't fail if agent memory write fails
        this.logger.warn('Failed to add learning to agent memory', { error });
      }
    }

    // Mirror into the project's LLM-wiki so the learning is BM25-recallable
    // (fire-and-forget; auto-learning is the high-volume path into this method).
    this.ingestToWiki(
      `learning:${params.agentId}:${params.relatedTask ?? 'adhoc'}`,
      params.learning,
      { category: 'learning', agentId: params.agentId },
      'project',
      params.projectPath,
    ).catch(() => { /* non-fatal */ });
  }

  /**
   * Initializes memory for a new session
   *
   * @param agentId - Agent identifier
   * @param role - Agent's role
   * @param projectPath - Project path
   */
  public async initializeForSession(agentId: string, role: string, projectPath: string): Promise<void> {
    this.logger.info('Initializing memory for session', { agentId, role, projectPath });

    await Promise.all([
      this.agentMemory.initializeAgent(agentId, role),
      this.projectMemory.initializeProject(projectPath),
    ]);

    this.logger.info('Memory initialized for session', { agentId, role, projectPath });
  }

  /**
   * Recalls knowledge from all agents that have worked on a project
   *
   * Reads the project's agents-index.json, then searches each agent's role
   * knowledge for entries relevant to the given context. Results are merged,
   * deduplicated, and sorted by relevance.
   *
   * @param projectPath - Absolute path to the project
   * @param context - Search context for relevance filtering
   * @param limit - Maximum number of results (default 20)
   * @returns Array of formatted memory strings from all agents
   *
   * @example
   * ```typescript
   * const teamKnowledge = await memoryService.recallFromAllAgents(
   *   '/projects/app',
   *   'authentication middleware',
   *   15,
   * );
   * ```
   */
  public async recallFromAllAgents(
    projectPath: string,
    context: string,
    limit: number = 20,
  ): Promise<string[]> {
    this.logger.debug('Recalling from all agents', { projectPath, context: context.substring(0, 50) });

    const indexPath = path.join(
      projectPath,
      CREWLY_CONSTANTS.PATHS.CREWLY_HOME,
      MEMORY_CONSTANTS.PATHS.AGENTS_INDEX,
    );

    const defaultIndex: ProjectAgentsIndex = { agents: [] };
    const index = await safeReadJson<ProjectAgentsIndex>(indexPath, defaultIndex, this.logger);

    if (index.agents.length === 0) {
      return [];
    }

    const allMemories: string[] = [];

    for (const agent of index.agents) {
      try {
        const knowledge = await this.agentMemory.getRoleKnowledge(agent.agentId);
        const relevant = this.filterRelevant(knowledge, context, Math.ceil(limit / index.agents.length));
        relevant.forEach(m => {
          allMemories.push(`[${agent.role}/${agent.agentId}] ${m}`);
        });
      } catch {
        this.logger.debug('Failed to read knowledge for agent', { agentId: agent.agentId });
      }
    }

    // Also include project-level knowledge
    try {
      const searchResults = await this.projectMemory.searchAll(projectPath, context);
      const projectMemories = this.formatSearchResults(searchResults, Math.ceil(limit / 2));
      allMemories.push(...projectMemories);
    } catch {
      this.logger.debug('Failed to search project knowledge', { projectPath });
    }

    return allMemories.slice(0, limit);
  }
}
