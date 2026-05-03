/**
 * Memory Data Models for Crewly Two-Level Memory System
 *
 * This module defines the data structures for the structured memory system:
 * - Agent-level memory: Role knowledge, preferences, and performance metrics
 * - Project-level memory: Patterns, decisions, gotchas, and relationships
 *
 * @module memory.types
 */

// ========================= AGENT-LEVEL MEMORY =========================

/**
 * Categories for role knowledge entries
 */
export type RoleKnowledgeCategory = 'best-practice' | 'anti-pattern' | 'tool-usage' | 'workflow';

/**
 * Memory type classification — determines how a memory entry is used.
 *
 * Different memory types serve different purposes and should be injected
 * differently (or not at all) into agent prompts:
 *
 * - **procedural**: How to do things — injected into worker prompts to guide execution
 * - **risk**: What to avoid — injected early in prompts as warnings
 * - **preference**: Style/approach preferences — injected with low weight, may be overridden
 * - **domain**: Business/architecture facts — injected but flagged for freshness verification
 * - **performance**: Agent strengths/weaknesses — injected into TL/orchestrator prompts for scheduling, NOT into worker prompts
 */
export type MemoryType =
  | 'procedural'    // Steps, workflows, how-to knowledge
  | 'risk'          // Failures, anti-patterns, prohibitions
  | 'preference'    // Style, approach, team convention preferences
  | 'domain'        // Business facts, architecture knowledge
  | 'performance';  // Agent capability assessment (for scheduling, not self-use)

/**
 * A single piece of role-specific knowledge learned by an agent
 *
 * @example
 * ```typescript
 * const entry: RoleKnowledgeEntry = {
 *   id: 'rk-001',
 *   category: 'best-practice',
 *   content: 'Always run tests before committing code changes',
 *   learnedFrom: 'TICKET-123',
 *   confidence: 0.85,
 *   createdAt: '2026-01-29T10:00:00Z',
 *   lastUsed: '2026-01-29T14:30:00Z'
 * };
 * ```
 */
export interface RoleKnowledgeEntry {
  /** Unique identifier for this knowledge entry */
  id: string;
  /** Category of knowledge */
  category: RoleKnowledgeCategory;
  /**
   * Memory type — determines injection strategy.
   * Risk memories are injected as early warnings. Performance memories go to TL/orchestrator only.
   * Defaults to 'procedural' for backward compatibility with existing entries.
   */
  memoryType?: MemoryType;
  /** The actual knowledge content */
  content: string;
  /** Task/Ticket ID where this was learned (optional) */
  learnedFrom?: string;
  /** Confidence score 0-1, increases with reinforcement */
  confidence: number;
  /** ISO timestamp when this entry was created */
  createdAt: string;
  /** ISO timestamp when this entry was last used/referenced */
  lastUsed?: string;
  /** Tags for additional categorization */
  tags?: string[];

  // === v2: Task-linked provenance ===

  /** Task ID where this knowledge was learned */
  sourceTaskId?: string;
  /** Objective/goal ID this knowledge relates to */
  sourceObjectiveId?: string;
  /** Outcome of the task where this was learned */
  sourceOutcome?: 'success' | 'failed' | 'partial';
  /** What contexts/domains this knowledge applies to */
  appliesTo?: string[];
  /** ISO timestamp when this knowledge was last verified as still valid */
  lastVerifiedAt?: string;
  /** Whether this entry has been superseded by newer knowledge */
  superseded?: boolean;
  /** ID of the entry that supersedes this one */
  supersededBy?: string;

  // === v3 (Memory Phase 1 — M3): importance / evidence / ttl / shouldInjectByDefault ===
  // All optional. Lazy-migrated to defaults on first load by AgentMemoryService.

  /**
   * Importance score 0–1. Default 0.5 (set by lazy migration).
   * Combined with confidence by recall to gate auto-injection
   * (importance >= 0.85 AND confidence >= 0.7 → eligible for auto-inject).
   */
  importance?: number;

  /**
   * Provenance refs that justify this entry. Each item is a free-form ref
   * such as `request:<id>`, `workItem:<id>`, `slack:<ts>`, or a file path.
   * Default `[]` (set by lazy migration).
   */
  evidence?: string[];

  /**
   * ISO date when this entry expires. Past-TTL entries are hidden from
   * default recall and considered archive candidates by the GC sweep.
   * Default `undefined` (no expiration).
   */
  ttl?: string;

  /**
   * Whether this entry should be auto-injected into the agent prompt
   * without an explicit `recall` call. Default `false` (set by lazy
   * migration). Recall is free to override at injection time based on
   * combined importance/confidence scoring.
   */
  shouldInjectByDefault?: boolean;
}

/**
 * Verbosity level for agent communication
 */
export type VerbosityLevel = 'concise' | 'detailed';

/**
 * Task breakdown size preference
 */
export type BreakdownSize = 'small' | 'medium' | 'large';

/**
 * Agent coding style preferences
 */
export interface CodingStylePreferences {
  /** Preferred programming language */
  language?: string;
  /** Preferred testing framework (e.g., 'jest', 'vitest', 'pytest') */
  testingFramework?: string;
  /** Linting rules preference (e.g., 'eslint-recommended', 'strict') */
  lintingRules?: string;
  /** Code formatting preferences */
  formatting?: {
    /** Indentation style ('tabs' or 'spaces') */
    indentStyle?: 'tabs' | 'spaces';
    /** Number of spaces for indentation */
    indentSize?: number;
    /** Maximum line length */
    maxLineLength?: number;
  };
}

/**
 * Agent communication style preferences
 */
export interface CommunicationStylePreferences {
  /** How verbose the agent should be in responses */
  verbosity: VerbosityLevel;
  /** Whether to ask for confirmation before taking actions */
  askBeforeAction: boolean;
  /** Whether to include explanations with code changes */
  includeExplanations?: boolean;
}

/**
 * Agent work pattern preferences
 */
export interface WorkPatternPreferences {
  /** How often to commit changes (e.g., 'after-each-task', 'at-milestones') */
  commitFrequency?: string;
  /** Preferred size for task breakdown */
  breakdownSize?: BreakdownSize;
  /** Preferred working hours (for scheduling) */
  preferredHours?: {
    start: string; // HH:MM format
    end: string;
  };
}

/**
 * Combined agent preferences
 */
export interface AgentPreferences {
  /** Coding style preferences */
  codingStyle?: CodingStylePreferences;
  /** Communication style preferences */
  communicationStyle?: CommunicationStylePreferences;
  /** Work pattern preferences */
  workPatterns?: WorkPatternPreferences;
  /** Custom preferences (key-value pairs) */
  custom?: Record<string, unknown>;
}

/**
 * A pattern of errors encountered by the agent
 */
export interface ErrorPattern {
  /** Identifier or description of the error pattern */
  pattern: string;
  /** Number of times this error has occurred */
  occurrences: number;
  /** ISO timestamp of the last occurrence */
  lastOccurred: string;
  /** Known resolution for this error (if any) */
  resolution?: string;
  /** Related file paths where this error commonly occurs */
  relatedFiles?: string[];
}

/**
 * Agent performance metrics over time
 */
export interface PerformanceMetrics {
  /** Total number of tasks completed */
  tasksCompleted: number;
  /** Average number of iterations per task */
  averageIterations: number;
  /** Percentage of quality gates passed on first try (0-100) */
  qualityGatePassRate: number;
  /** Common error patterns encountered */
  commonErrors: ErrorPattern[];
  /** Average time to complete a task (in minutes) */
  averageCompletionTime?: number;
  /** Success rate for different task types */
  taskTypeSuccessRates?: Record<string, number>;
}

/**
 * Complete agent-level memory structure
 *
 * Stored at: ~/.crewly/agents/{agentId}/memory.json
 *
 * @example
 * ```typescript
 * const agentMemory: AgentMemory = {
 *   agentId: 'frontend-dev-001',
 *   role: 'frontend-developer',
 *   createdAt: '2026-01-01T00:00:00Z',
 *   updatedAt: '2026-01-29T15:00:00Z',
 *   roleKnowledge: [...],
 *   preferences: { ... },
 *   performance: { ... }
 * };
 * ```
 */
export interface AgentMemory {
  /** Unique agent identifier */
  agentId: string;
  /** Agent's role (e.g., 'developer', 'qa', 'pm') */
  role: string;
  /** ISO timestamp when this memory was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Role-specific knowledge entries */
  roleKnowledge: RoleKnowledgeEntry[];
  /** Agent preferences */
  preferences: AgentPreferences;
  /** Performance metrics */
  performance: PerformanceMetrics;
  /** Schema version for migration support */
  schemaVersion?: number;
}

// ========================= PROJECT-LEVEL MEMORY =========================

/**
 * Categories for project code patterns
 */
export type PatternCategory =
  | 'api'
  | 'component'
  | 'service'
  | 'testing'
  | 'styling'
  | 'database'
  | 'config'
  | 'user_preference'
  | 'other';

/**
 * A code pattern discovered in the project
 *
 * @example
 * ```typescript
 * const pattern: PatternEntry = {
 *   id: 'pat-001',
 *   category: 'api',
 *   title: 'Error Handling Wrapper',
 *   description: 'All API endpoints use handleApiError() wrapper',
 *   example: 'app.get("/api/users", handleApiError(async (req, res) => {...}))',
 *   files: ['backend/src/utils/api-errors.ts'],
 *   discoveredBy: 'backend-dev-001',
 *   createdAt: '2026-01-15T10:00:00Z'
 * };
 * ```
 */
export interface PatternEntry {
  /** Unique identifier for this pattern */
  id: string;
  /** Category of the pattern */
  category: PatternCategory;
  /** Short title describing the pattern */
  title: string;
  /** Detailed description of the pattern */
  description: string;
  /** Code example demonstrating the pattern */
  example?: string;
  /** Related file paths */
  files?: string[];
  /** Agent ID that discovered this pattern */
  discoveredBy: string;
  /** ISO timestamp when discovered */
  createdAt: string;
  /** Tags for searchability */
  tags?: string[];

  // === v2: Task-linked provenance ===

  /** Task ID where this pattern was discovered */
  sourceTaskId?: string;
  /** Outcome of the task where this was learned */
  sourceOutcome?: 'success' | 'failed' | 'partial';
  /** ISO timestamp when this pattern was last verified */
  lastVerifiedAt?: string;
}

/**
 * An architecture or design decision made for the project
 *
 * @example
 * ```typescript
 * const decision: DecisionEntry = {
 *   id: 'dec-001',
 *   title: 'State Management Choice',
 *   decision: 'Use React Context API instead of Redux',
 *   rationale: 'Project scope is small, Redux would add unnecessary complexity',
 *   alternatives: ['Redux', 'MobX', 'Zustand'],
 *   decidedBy: 'tech-lead',
 *   decidedAt: '2026-01-10T14:00:00Z',
 *   affectedAreas: ['frontend/src/contexts/', 'frontend/src/components/']
 * };
 * ```
 */
export interface DecisionEntry {
  /** Unique identifier for this decision */
  id: string;
  /** Short title of the decision */
  title: string;
  /** The actual decision made */
  decision: string;
  /** Why this decision was made */
  rationale: string;
  /** Other options that were considered */
  alternatives?: string[];
  /** Who made this decision (agent ID or 'user') */
  decidedBy: string;
  /** ISO timestamp when decided */
  decidedAt: string;
  /** Areas of the codebase affected by this decision */
  affectedAreas?: string[];
  /** Current status of the decision */
  status?: 'active' | 'superseded' | 'deprecated';
  /** ID of the decision that supersedes this one */
  supersededBy?: string;
  /** What actually happened (filled retrospectively) */
  actualOutcome?: string;
  /** What was learned from this decision */
  learnings?: string;
  /** ISO timestamp when the outcome was recorded */
  outcomeRecordedAt?: string;
}

/**
 * Severity levels for gotcha entries
 */
export type GotchaSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A known issue or workaround in the project
 *
 * @example
 * ```typescript
 * const gotcha: GotchaEntry = {
 *   id: 'got-001',
 *   title: 'PostgreSQL connection pool exhaustion',
 *   problem: 'Database connections leak when using transactions without proper cleanup',
 *   solution: 'Always use try/finally with client.release() or use pool.query() for single queries',
 *   severity: 'high',
 *   discoveredBy: 'backend-dev-001',
 *   createdAt: '2026-01-20T09:00:00Z'
 * };
 * ```
 */
export interface GotchaEntry {
  /** Unique identifier for this gotcha */
  id: string;
  /** Short title of the issue */
  title: string;
  /** Description of the problem */
  problem: string;
  /** Known solution or workaround */
  solution: string;
  /** How severe is this issue */
  severity: GotchaSeverity;
  /** Agent ID that discovered this */
  discoveredBy: string;
  /** ISO timestamp when discovered */
  createdAt: string;
  /** Related file paths */
  relatedFiles?: string[];
  /** Whether this gotcha is still relevant */
  resolved?: boolean;
  /** ISO timestamp when resolved */
  resolvedAt?: string;

  // === v2: Task-linked provenance ===

  /** Task ID where this gotcha was discovered */
  sourceTaskId?: string;
  /** Outcome of the task where this was learned */
  sourceOutcome?: 'success' | 'failed' | 'partial';
  /** ISO timestamp when this gotcha was last verified */
  lastVerifiedAt?: string;
}

/**
 * Types of relationships between components
 */
export type RelationshipType = 'depends-on' | 'uses' | 'extends' | 'implements' | 'calls' | 'imported-by';

/**
 * A relationship between two components/services in the project
 *
 * @example
 * ```typescript
 * const relationship: RelationshipEntry = {
 *   id: 'rel-001',
 *   from: 'UserController',
 *   to: 'AuthService',
 *   relationshipType: 'depends-on',
 *   description: 'UserController requires AuthService for authentication checks'
 * };
 * ```
 */
export interface RelationshipEntry {
  /** Unique identifier for this relationship */
  id: string;
  /** Source component/service name */
  from: string;
  /** Target component/service name */
  to: string;
  /** Type of relationship */
  relationshipType: RelationshipType;
  /** Optional description of the relationship */
  description?: string;
  /** File path of the source component */
  fromFile?: string;
  /** File path of the target component */
  toFile?: string;
}

/**
 * Complete project-level memory structure
 *
 * Stored at: project/.crewly/knowledge/index.json
 *
 * @example
 * ```typescript
 * const projectMemory: ProjectMemory = {
 *   projectId: 'proj-001',
 *   projectPath: '/home/user/projects/my-app',
 *   createdAt: '2026-01-01T00:00:00Z',
 *   updatedAt: '2026-01-29T15:00:00Z',
 *   patterns: [...],
 *   decisions: [...],
 *   gotchas: [...],
 *   relationships: [...]
 * };
 * ```
 */
export interface ProjectMemory {
  /** Unique project identifier */
  projectId: string;
  /** Absolute path to the project directory */
  projectPath: string;
  /** ISO timestamp when this memory was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Code patterns discovered in the project */
  patterns: PatternEntry[];
  /** Architecture and design decisions */
  decisions: DecisionEntry[];
  /** Known issues and workarounds */
  gotchas: GotchaEntry[];
  /** Component/service relationships */
  relationships: RelationshipEntry[];
  /** Schema version for migration support */
  schemaVersion?: number;
}

// ========================= SHARED USER PROFILE =========================

/**
 * Shared user profile — preferences that apply across ALL agents.
 * Stored once at ~/.crewly/user-profile.json, readable by all agents.
 * Any agent can update it, but orchestrator is the primary writer.
 */
export interface SharedUserProfile {
  /** Display language preference (e.g., 'zh-CN', 'en') */
  language?: string;
  /** Communication style: concise vs detailed */
  reportingStyle?: 'concise' | 'detailed' | 'structured';
  /** Risk tolerance for autonomous decisions */
  riskTolerance?: 'conservative' | 'moderate' | 'aggressive';
  /** Timezone for scheduling and reporting (e.g., 'Asia/Shanghai') */
  timezone?: string;
  /** Domain knowledge context (e.g., "fintech startup, Series A") */
  domainContext?: string;
  /** Things the user explicitly does NOT want */
  prohibitions?: string[];
  /** Preferred tools, frameworks, or approaches */
  preferences?: Record<string, string>;
  /** Free-form notes about working with this user */
  notes?: string[];
  /** ISO timestamp of last update */
  updatedAt?: string;
  /** Who last updated this profile (agentId or 'user') */
  updatedBy?: string;
}

// ========================= LEARNING LOG TYPES =========================

/**
 * Categories for learning entries
 */
export type LearningCategory = 'pattern' | 'decision' | 'gotcha' | 'insight' | 'improvement';

/**
 * A single learning entry for the append-only log
 *
 * This is used for the human-readable learnings.md file
 */
export interface LearningEntry {
  /** ISO timestamp of the learning */
  timestamp: string;
  /** Agent ID that recorded this learning */
  agentId: string;
  /** Agent's role */
  agentRole: string;
  /** Category of learning */
  category: LearningCategory;
  /** Title of the learning */
  title: string;
  /** Content of the learning */
  content: string;
  /** Related file paths */
  relatedFiles?: string[];
  /** Related task/ticket ID */
  relatedTask?: string;
}

// ========================= SESSION & LIFECYCLE TYPES =========================

/**
 * Summary of an agent's work session, captured on session end
 */
export interface SessionSummary {
  /** Agent identifier */
  agentId: string;
  /** ISO timestamp when the session started */
  sessionStart: string;
  /** ISO timestamp when the session ended */
  sessionEnd: string;
  /** Human-readable summary of what was accomplished */
  summary: string;
  /** Description of unfinished work to pick up next session */
  unfinishedWork?: string;
  /** Agent's role during this session */
  role?: string;
  /** Project path for this session */
  projectPath?: string;
}

/**
 * Briefing assembled for an agent at session startup
 */
export interface StartupBriefing {
  /** Summary from the agent's most recent session (if any) */
  lastSessionSummary: string | null;
  /** Agent-level context (knowledge, preferences, performance) */
  agentContext: string;
  /** Project-level context (patterns, decisions, gotchas) */
  projectContext: string;
  /** Today's daily log entries (if any) */
  todaysDailyLog: string | null;
  /** Active goals for the project (if any) */
  activeGoals: string | null;
  /** Recent failures to avoid repeating */
  recentFailures: string | null;
  /** Recent successes to replicate */
  recentSuccesses: string | null;
}

/**
 * Entry in the project agents index, tracking which agents have worked on a project
 */
export interface AgentIndexEntry {
  /** Agent identifier */
  agentId: string;
  /** Agent's role */
  role: string;
  /** ISO timestamp of last activity */
  lastActive: string;
}

/**
 * Project agents index file structure
 */
export interface ProjectAgentsIndex {
  /** List of agents that have worked on this project */
  agents: AgentIndexEntry[];
}

/**
 * Entry in the daily log
 */
export interface DailyLogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Agent identifier */
  agentId: string;
  /** Agent's role */
  role: string;
  /** Log entry content */
  entry: string;
}

/**
 * A learning entry categorized as success or failure
 */
export interface LearningAccumulationEntry {
  /** ISO timestamp when recorded */
  timestamp: string;
  /** Agent that recorded this */
  agentId: string;
  /** Agent's role */
  role: string;
  /** Description of what worked or failed */
  description: string;
  /** Related context (file paths, task IDs, etc.) */
  context?: string;
}

// ========================= MEMORY OPERATION TYPES =========================

/**
 * Scope for memory operations
 */
export type MemoryScope = 'agent' | 'project';

/**
 * Options for querying memory
 */
export interface MemoryQueryOptions {
  /** Scope of the query */
  scope: MemoryScope;
  /** Category filter */
  category?: string;
  /** Tag filter */
  tags?: string[];
  /** Minimum confidence threshold (for agent memory) */
  minConfidence?: number;
  /** Maximum number of results */
  limit?: number;
  /** Search text for content matching */
  searchText?: string;
  /** Only return entries after this date */
  since?: string;
}

/**
 * Result of a memory query
 */
export interface MemoryQueryResult<T> {
  /** The matching entries */
  entries: T[];
  /** Total count (may be more than entries if limited) */
  totalCount: number;
  /** Whether there are more results */
  hasMore: boolean;
}

/**
 * Options for storing memory
 */
export interface MemoryStoreOptions {
  /** Scope for storage */
  scope: MemoryScope;
  /** Whether to merge with existing entry if ID exists */
  merge?: boolean;
  /** Whether to update the 'updatedAt' timestamp */
  updateTimestamp?: boolean;
}

// ========================= FILE STRUCTURE TYPES =========================

/**
 * Agent memory file structure
 *
 * Location: ~/.crewly/agents/{agentId}/
 */
export interface AgentMemoryFileStructure {
  /** Main memory file containing AgentMemory */
  memoryFile: 'memory.json';
  /** Detailed role knowledge entries */
  roleKnowledgeFile: 'role-knowledge.json';
  /** Agent preferences */
  preferencesFile: 'preferences.json';
  /** Performance metrics */
  performanceFile: 'performance.json';
  /** Custom SOPs directory */
  sopCustomDir: 'sop-custom';
}

/**
 * Project memory file structure
 *
 * Location: project/.crewly/knowledge/
 */
export interface ProjectMemoryFileStructure {
  /** Main index file containing ProjectMemory summary */
  indexFile: 'index.json';
  /** All pattern entries */
  patternsFile: 'patterns.json';
  /** All decision entries */
  decisionsFile: 'decisions.json';
  /** All gotcha entries */
  gotchasFile: 'gotchas.json';
  /** All relationship entries */
  relationshipsFile: 'relationships.json';
  /** Append-only human-readable log */
  learningsFile: 'learnings.md';
}

// ========================= VALIDATION AND DEFAULTS =========================

/**
 * Default values for new agent memory.
 *
 * `schemaVersion` is hardcoded to 2 (current MEMORY_SCHEMA_VERSION) — kept in sync
 * with the const declared below to avoid module-load forward-reference issues.
 * If you bump MEMORY_SCHEMA_VERSION, also bump this literal.
 */
export const DEFAULT_AGENT_MEMORY: Omit<AgentMemory, 'agentId' | 'role' | 'createdAt' | 'updatedAt'> = {
  roleKnowledge: [],
  preferences: {
    communicationStyle: {
      verbosity: 'detailed',
      askBeforeAction: true,
    },
    workPatterns: {
      breakdownSize: 'medium',
    },
  },
  performance: {
    tasksCompleted: 0,
    averageIterations: 0,
    qualityGatePassRate: 0,
    commonErrors: [],
  },
  schemaVersion: 2,
};

/**
 * Default values for new project memory.
 *
 * `schemaVersion` is bumped in lock-step with MEMORY_SCHEMA_VERSION so the
 * file-format identifier is consistent across agent + project memory stores,
 * even though M3 (Memory Phase 1) only adds new fields to RoleKnowledgeEntry
 * — ProjectMemory entry shapes are unchanged at v2.
 */
export const DEFAULT_PROJECT_MEMORY: Omit<ProjectMemory, 'projectId' | 'projectPath' | 'createdAt' | 'updatedAt'> = {
  patterns: [],
  decisions: [],
  gotchas: [],
  relationships: [],
  schemaVersion: 2,
};

/**
 * Current schema version for memory files.
 *
 * - **v1**: Original schema with `confidence`, `superseded`, v2 task-linked provenance.
 * - **v2**: Added Memory Phase 1 (M3) fields — `importance`, `evidence`, `ttl`,
 *   `shouldInjectByDefault`. Lazy non-destructive migration: when an entry
 *   from a v1 store is read by AgentMemoryService.loadAgentMemory(), missing
 *   fields are filled with `MEMORY_V2_MIGRATION_DEFAULTS` values. The
 *   schemaVersion of the persisted memory bumps to 2 on first save after read.
 */
export const MEMORY_SCHEMA_VERSION = 2;

/**
 * Default values applied when migrating a v1 RoleKnowledgeEntry to v2.
 *
 * - `importance = 0.5`: middle of scale, neither auto-inject candidate nor low-priority
 * - `confidence = 0.7`: only used if the entry has `confidence === undefined`
 *   (existing v1 entries always have `confidence` populated, so this is a safety net)
 * - `evidence = []`: no provenance refs known retroactively
 * - `shouldInjectByDefault = false`: opt-in only; v1 entries do not auto-inject
 *
 * `ttl` is intentionally left `undefined` — pre-v2 entries do not expire.
 */
export const MEMORY_V2_MIGRATION_DEFAULTS = {
  importance: 0.5,
  confidence: 0.7,
  evidence: [] as string[],
  shouldInjectByDefault: false,
} as const;
