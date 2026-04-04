/**
 * Intent Task Types — V2
 *
 * Defines the dual-layer Intent Task System with multi-intent decomposition:
 * - Intent Layer: User messages decomposed into multiple intents, each classified by complexity (L0/L1/L2)
 * - Execution Layer: Task -> Run -> Span model for tracking work
 * - Association Layer: Schedule follow-up and project task linkage
 *
 * Key v2 change: One chat message can produce multiple intent tasks.
 * Tasks are grouped by messageId and displayed as a todo list.
 *
 * Token usage binds to task_id + run_id via TokenUsageService integration.
 *
 * @module types/intent-task
 */

// =============================================================================
// Intent Classification
// =============================================================================

/**
 * Intent complexity levels:
 * - L0: Simple query — single agent, no tool calls (e.g., "what time is it?")
 * - L1: Standard task — single agent, may use tools (e.g., "fix this bug")
 * - L2: Complex task — multi-agent, multi-step orchestration (e.g., "build a feature")
 */
export type IntentLevel = 'L0' | 'L1' | 'L2';

/**
 * Intent classification labels for categorizing user requests
 */
export type IntentCategory =
  | 'query'
  | 'code_change'
  | 'debugging'
  | 'deployment'
  | 'research'
  | 'review'
  | 'planning'
  | 'communication'
  | 'other';

// =============================================================================
// Task Status
// =============================================================================

/**
 * Lifecycle states for an intent task
 */
export type IntentTaskStatus =
  | 'pending'
  | 'classified'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Lifecycle states for a run within a task
 */
export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Span types for tracking granular execution steps
 */
export type SpanType =
  | 'llm_call'
  | 'tool_call'
  | 'skill_call'
  | 'delegation'
  | 'waiting'
  | 'user_input';

// =============================================================================
// Core Models
// =============================================================================

/**
 * A span represents a single atomic operation within a run.
 * Spans track LLM calls, tool executions, and delegations.
 */
export interface TaskSpan {
  /** Unique span identifier */
  id: string;
  /** Parent run ID */
  runId: string;
  /** Type of operation */
  type: SpanType;
  /** Human-readable label (e.g., tool name, model name) */
  label: string;
  /** ISO timestamp when the span started */
  startedAt: string;
  /** ISO timestamp when the span ended (null if still running) */
  endedAt: string | null;
  /** Duration in milliseconds (computed on completion) */
  durationMs: number | null;
  /** Input tokens consumed (for llm_call spans) */
  inputTokens: number;
  /** Output tokens generated (for llm_call spans) */
  outputTokens: number;
  /** Direct cost override in USD (for skill_call spans with non-token costs) */
  costOverride?: number;
  /** Optional metadata (tool args preview, model name, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * A run represents a single execution attempt of a task.
 * A task may have multiple runs (retries, continuations).
 */
export interface TaskRun {
  /** Unique run identifier */
  id: string;
  /** Parent task ID */
  taskId: string;
  /** Run sequence number (1-based) */
  runNumber: number;
  /** Agent session executing this run */
  sessionName: string;
  /** Current status */
  status: RunStatus;
  /** ISO timestamp when the run started */
  startedAt: string;
  /** ISO timestamp when the run ended */
  endedAt: string | null;
  /** Total input tokens across all spans */
  totalInputTokens: number;
  /** Total output tokens across all spans */
  totalOutputTokens: number;
  /** Computed LLM cost in USD */
  cost: number;
  /** Computed skill cost in USD (API calls, browser automation, etc.) */
  skillCost: number;
  /** Spans within this run */
  spans: TaskSpan[];
  /** Error message if failed */
  error?: string;
}

/**
 * An intent task represents a single decomposed intent from a user message,
 * tracked through its lifecycle.
 *
 * V2: Multiple tasks can share the same messageId (from one chat message).
 */
export interface IntentTask {
  /** Unique task identifier */
  id: string;
  /** ID of the originating chat message (groups tasks from the same message) */
  messageId: string;
  /** Original user input / intent description */
  intent: string;
  /** Classified complexity level */
  level: IntentLevel;
  /** Intent category */
  category: IntentCategory;
  /** Current lifecycle status */
  status: IntentTaskStatus;
  /** ISO timestamp when created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** ISO timestamp when completed/failed */
  completedAt: string | null;
  /** Agent sessions involved */
  assignedSessions: string[];
  /** Execution runs */
  runs: TaskRun[];
  /** Aggregated input tokens across all runs */
  totalInputTokens: number;
  /** Aggregated output tokens across all runs */
  totalOutputTokens: number;
  /** Aggregated LLM cost in USD */
  totalCost: number;
  /** Aggregated skill cost in USD (API calls, browser automation, etc.) */
  totalSkillCost: number;
  /** Optional result summary */
  result?: string;
  /** Optional parent task ID for sub-task relationships */
  parentTaskId?: string;
  /** Optional tags for filtering */
  tags?: string[];
  /** Optional schedule ID for automatic follow-up checks */
  scheduleId?: string;
  /** Optional project task ID linking to .crewly/tasks/ project task */
  projectTaskId?: string;
  /** Order within the message (0-based, for display ordering) */
  order: number;
}

// =============================================================================
// Decomposition Types
// =============================================================================

/**
 * A single decomposed intent extracted from a user message.
 */
export interface DecomposedIntent {
  /** The extracted intent description */
  intent: string;
  /** Auto-classified complexity level */
  level: IntentLevel;
  /** Auto-classified category */
  category: IntentCategory;
}

/**
 * Result of decomposing a user message into multiple intents.
 */
export interface DecomposeResult {
  /** The original user message */
  originalMessage: string;
  /** Generated message ID for grouping */
  messageId: string;
  /** Array of decomposed intents */
  intents: DecomposedIntent[];
}

/**
 * A message group containing all tasks from a single chat message.
 * Used for the todo-list UI display.
 */
export interface MessageGroup {
  /** Message ID shared by all tasks in this group */
  messageId: string;
  /** The original user message (reconstructed or stored) */
  originalMessage: string;
  /** ISO timestamp of the earliest task in this group */
  createdAt: string;
  /** Tasks belonging to this message, ordered by their order field */
  tasks: IntentTaskSummary[];
  /** Number of completed tasks in this group */
  completedCount: number;
  /** Total number of tasks in this group */
  totalCount: number;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/**
 * Request body for creating a new intent task
 */
export interface CreateIntentTaskInput {
  /** User intent description */
  intent: string;
  /** Message ID to group tasks from the same chat message */
  messageId?: string;
  /** Optional pre-classified level (auto-classified if omitted) */
  level?: IntentLevel;
  /** Optional category (auto-classified if omitted) */
  category?: IntentCategory;
  /** Optional parent task ID */
  parentTaskId?: string;
  /** Optional tags */
  tags?: string[];
  /** Optional schedule ID for follow-up */
  scheduleId?: string;
  /** Optional project task ID */
  projectTaskId?: string;
  /** Optional order within message group */
  order?: number;
}

/**
 * Request body for decomposing a message into multiple intent tasks.
 */
export interface DecomposeMessageInput {
  /** The full user message to decompose */
  message: string;
  /** Optional project task ID to associate all decomposed tasks with */
  projectTaskId?: string;
  /** Optional tags to apply to all decomposed tasks */
  tags?: string[];
  /** Whether to auto-create schedule follow-ups for each task */
  autoSchedule?: boolean;
}

/**
 * Request body for updating a task's status
 */
export interface UpdateIntentTaskInput {
  /** New status */
  status?: IntentTaskStatus;
  /** Result summary (when completing) */
  result?: string;
  /** Additional sessions to assign */
  assignedSessions?: string[];
  /** Schedule ID to associate */
  scheduleId?: string;
}

/**
 * Request body for starting a new run
 */
export interface StartRunInput {
  /** Agent session executing the run */
  sessionName: string;
}

/**
 * Request body for recording a span
 */
export interface RecordSpanInput {
  /** Span type */
  type: SpanType;
  /** Human-readable label */
  label: string;
  /** Input tokens (for llm_call) */
  inputTokens?: number;
  /** Output tokens (for llm_call) */
  outputTokens?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Direct cost override in USD (for skill_call spans with non-token costs) */
  costOverride?: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Summary view of a task for list display
 */
export interface IntentTaskSummary {
  /** Task ID */
  id: string;
  /** Message ID for grouping */
  messageId: string;
  /** Intent description (truncated) */
  intent: string;
  /** Complexity level */
  level: IntentLevel;
  /** Category */
  category: IntentCategory;
  /** Current status */
  status: IntentTaskStatus;
  /** When created */
  createdAt: string;
  /** When last updated */
  updatedAt: string;
  /** Number of runs */
  runCount: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Total LLM cost in USD */
  totalCost: number;
  /** Total skill cost in USD */
  totalSkillCost: number;
  /** Assigned sessions */
  assignedSessions: string[];
  /** Order within message group */
  order: number;
  /** Schedule ID if associated */
  scheduleId?: string;
  /** Project task ID if associated */
  projectTaskId?: string;
  /** Original message text for this task's message group (preserves user input) */
  originalMessage?: string;
}

/**
 * Status of a project task based on its linked intent tasks.
 */
export interface ProjectTaskStatus {
  /** Project task ID */
  projectTaskId: string;
  /** Total linked intent tasks */
  totalTasks: number;
  /** Completed intent tasks */
  completedTasks: number;
  /** Whether all linked tasks are done */
  allCompleted: boolean;
  /** List of linked task summaries */
  tasks: IntentTaskSummary[];
}

// =============================================================================
// Classification Helpers
// =============================================================================

/**
 * Heuristic rules for auto-classifying intent level.
 * Returns L0 for simple queries, L1 for standard tasks, L2 for complex.
 *
 * @param intent - User intent text
 * @returns Classified intent level
 */
export function classifyIntentLevel(intent: string): IntentLevel {
  const lower = intent.toLowerCase();
  const wordCount = intent.split(/\s+/).length;

  // L0: Simple queries — short, question-like
  const queryPatterns = [
    /^(what|where|when|who|how|is|are|can|does|do|show|list|get)\b/i,
    /\?$/,
  ];
  if (wordCount <= 10 && queryPatterns.some((p) => p.test(lower))) {
    return 'L0';
  }

  // L2: Complex multi-agent tasks
  const complexPatterns = [
    /\b(implement|build|create|develop|design|architect|refactor)\b.*\b(feature|system|service|module|component)\b/i,
    /\b(deploy|migrate|upgrade)\b/i,
    /\bmulti[- ]?(agent|step|phase)\b/i,
    /\b(coordinate|orchestrate|delegate)\b/i,
  ];
  if (complexPatterns.some((p) => p.test(lower)) || wordCount > 30) {
    return 'L2';
  }

  // L1: Everything else — standard single-agent tasks
  return 'L1';
}

/**
 * Heuristic rules for auto-classifying intent category.
 *
 * @param intent - User intent text
 * @returns Classified intent category
 */
export function classifyIntentCategory(intent: string): IntentCategory {
  const lower = intent.toLowerCase();

  if (/\b(fix|bug|error|crash|broken|issue|debug|trace|stack)\b/.test(lower)) return 'debugging';
  if (/\b(deploy|release|staging|production|ci|cd|docker|kubernetes)\b/.test(lower)) return 'deployment';
  if (/\b(review|pr|pull request|code review|audit)\b/.test(lower)) return 'review';
  if (/\b(research|investigate|explore|analyze|compare|evaluate)\b/.test(lower)) return 'research';
  if (/\b(plan|roadmap|strategy|design|architect|spec)\b/.test(lower)) return 'planning';
  if (/\b(message|notify|slack|email|communicate|tell|ask)\b/.test(lower)) return 'communication';
  if (/\b(implement|code|write|add|update|modify|refactor|create|build)\b/.test(lower)) return 'code_change';
  if (/\b(what|where|when|who|how|show|list|get|status)\b/.test(lower)) return 'query';

  return 'other';
}

// =============================================================================
// Decomposition Helpers
// =============================================================================

/**
 * Sentence/clause splitting patterns that indicate intent boundaries.
 * Order matters — earlier patterns are checked first.
 */
const SPLIT_PATTERNS: RegExp[] = [
  /\bthen\b/i,
  /\bafter that\b/i,
  /\band then\b/i,
  /\band also\b/i,
  /\balso\b/i,
  /\bplus\b/i,
  /\b(?:and|,)\s+(?=(?:search|find|fix|build|create|deploy|implement|add|update|delete|remove|write|read|check|test|run|make|do|send|set|configure|install|download|upload|convert|transform|generate|export|import)\b)/i,
];

/**
 * Decompose a user message into multiple individual intents using heuristic splitting.
 *
 * Splits on conjunctions and sequential markers ("then", "and also", etc.),
 * classifies each resulting intent independently.
 *
 * @param message - The full user message
 * @returns DecomposeResult with the original message, a generated messageId, and the extracted intents
 *
 * @example
 * ```typescript
 * const result = decomposeIntents('Search for abc then make it into a PDF');
 * // result.intents = [
 * //   { intent: 'Search for abc', level: 'L1', category: 'research' },
 * //   { intent: 'make it into a PDF', level: 'L1', category: 'code_change' },
 * // ]
 * ```
 */
export function decomposeIntents(message: string): DecomposeResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      originalMessage: message,
      messageId: '',
      intents: [],
    };
  }

  // Try splitting with each pattern
  let segments: string[] = [trimmed];

  for (const pattern of SPLIT_PATTERNS) {
    const newSegments: string[] = [];
    for (const seg of segments) {
      const parts = seg.split(pattern).map((s) => s.trim()).filter(Boolean);
      newSegments.push(...parts);
    }
    segments = newSegments;
  }

  // Filter out segments that are too short to be meaningful (< 3 chars)
  segments = segments.filter((s) => s.length >= 3);

  // If no meaningful split found, treat the whole message as one intent
  if (segments.length === 0) {
    segments = [trimmed];
  }

  const intents: DecomposedIntent[] = segments.map((seg) => ({
    intent: seg,
    level: classifyIntentLevel(seg),
    category: classifyIntentCategory(seg),
  }));

  return {
    originalMessage: message,
    messageId: '', // Service will generate the UUID
    intents,
  };
}
