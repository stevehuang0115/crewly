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
 * Request body for updating a task's status and metadata.
 * Supports updating intent description, level, and category
 * (useful when orchestrator LLM refines understanding).
 */
export interface UpdateIntentTaskInput {
  /** New status */
  status?: IntentTaskStatus;
  /** Updated intent description (for LLM-driven refinement) */
  intent?: string;
  /** Updated complexity level */
  level?: IntentLevel;
  /** Updated category */
  category?: IntentCategory;
  /** Result summary (when completing) */
  result?: string;
  /** Additional sessions to assign */
  assignedSessions?: string[];
  /** Schedule ID to associate */
  scheduleId?: string;
}

/**
 * Request body for creating multiple intent tasks in a single batch.
 * Used by the orchestrator to create all tasks from one chat message at once.
 */
export interface BatchCreateIntentTaskInput {
  /** Array of tasks to create */
  tasks: CreateIntentTaskInput[];
  /** The original user message that produced these tasks */
  originalMessage?: string;
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
// Actionability Detection
// =============================================================================

/**
 * Patterns that indicate a message is NOT actionable (should not become a task).
 * These cover greetings, acknowledgments, questions, feedback, opinions, and filler.
 */
const NON_ACTIONABLE_PATTERNS: RegExp[] = [
  // Greetings / pleasantries
  /^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening|night)|thanks|thank\s+you|thx|cheers|bye|goodbye|welcome\s+back)\b/i,
  // Pure acknowledgments
  /^(ok|okay|sure|got\s+it|understood|roger|ack|yep|yup|yeah|yes|no|nah|nope|alright|right|fine|great|perfect|awesome|cool|nice|good\s+(job|work)|looks?\s+good|lgtm|approved|noted|agreed|sounds\s+good|will\s+do|on\s+it)\s*[.!]?$/i,
  // Pure questions with no action request (short, interrogative-only)
  /^(what|where|when|who|which|how|why|is|are|was|were|can|could|do|does|did|has|have|will|would|should)\b.{0,60}\?\s*$/i,
  // Opinions / discussion / thinking out loud (no imperative verb)
  /^(i\s+think|i\s+believe|i\s+feel|i\s+wonder|maybe\s+we|perhaps|it\s+seems|it\s+looks\s+like|fyi|btw|by\s+the\s+way|just\s+letting\s+you\s+know|heads\s+up|for\s+your\s+info)\b/i,
  // Status updates / reports (not requests)
  /^(i\s+(just|already)\s+(did|finished|completed|fixed|deployed|updated|pushed|merged|committed)|done\s+with|finished|completed|all\s+(set|done|good))\b/i,
  // Emoji-only or very short non-actionable
  /^[\p{Emoji}\s.,!?:;]+$/u,
];

/**
 * Action verbs that indicate a message contains an actionable intent.
 * Used as a positive signal when non-actionable patterns don't match.
 */
const ACTION_VERB_PATTERN = /\b(fix|build|create|deploy|implement|add|update|delete|remove|write|read|check|test|run|make|send|set\s+up|configure|install|download|upload|convert|transform|generate|export|import|refactor|migrate|upgrade|optimize|search|find|move|copy|rename|clean\s*up|set|start|stop|restart|enable|disable|schedule|assign|delegate|review|audit|analyze|investigate|research|explore|design|plan|document|monitor|track|debug|trace|patch|revert|rollback|merge|push|pull|commit|release|publish|integrate|connect|disconnect|setup|tear\s*down|provision|scale|backup|restore)\b/i;

/**
 * Minimum character count for a segment to be a meaningful intent.
 * Very short fragments like "ok" or "no" are not tasks.
 */
const MIN_ACTIONABLE_CHARS = 3;

/**
 * Determines whether a text segment represents an actionable intent
 * that should become a task (vs. a question, greeting, acknowledgment, or discussion).
 *
 * @param text - The text segment to evaluate
 * @returns true if the text is actionable and should become a task
 */
export function isActionableIntent(text: string): boolean {
  const trimmed = text.trim();

  // Too short to be meaningful
  if (trimmed.length < MIN_ACTIONABLE_CHARS) return false;

  // Check non-actionable patterns first (fast reject)
  for (const pattern of NON_ACTIONABLE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // Must contain at least one action verb to be considered a task
  return ACTION_VERB_PATTERN.test(trimmed);
}

// =============================================================================
// Classification Helpers
// =============================================================================

/**
 * Heuristic rules for auto-classifying intent level.
 * Returns L0 for simple queries/lookups, L1 for standard tasks, L2 for complex multi-step.
 *
 * @param intent - User intent text
 * @returns Classified intent level
 */
export function classifyIntentLevel(intent: string): IntentLevel {
  const lower = intent.toLowerCase();
  const wordCount = intent.split(/\s+/).length;

  // L0: Simple lookups, status checks, single-tool operations
  const l0Patterns = [
    /^(what|where|when|who|how|is|are|can|does|do|show|list|get|check|find)\b/i,
    /\?$/,
    /\b(status|version|health|uptime|count|list)\b/i,
  ];
  if (wordCount <= 12 && l0Patterns.some((p) => p.test(lower))) {
    return 'L0';
  }

  // L2: Complex multi-agent, multi-step, or cross-system tasks
  const l2Patterns = [
    // Verb + complex noun = feature-level work
    /\b(implement|build|create|develop|design|architect|refactor)\b.*\b(feature|system|service|module|component|pipeline|workflow|framework|infrastructure)\b/i,
    // Deployment / migration / upgrade (multi-step by nature)
    /\b(deploy|migrate|upgrade|provision)\b.*\b(to|from|environment|server|cluster|staging|production)\b/i,
    // Explicit multi-step language
    /\bmulti[- ]?(agent|step|phase|stage)\b/i,
    /\b(coordinate|orchestrate|delegate|parallelize)\b/i,
    // End-to-end or full-stack scope
    /\b(end[- ]to[- ]end|full[- ]stack|e2e|integration)\b.*\b(test|setup|implementation)\b/i,
    // Sprint / project level work
    /\b(sprint|milestone|epic|project)\b.*\b(deliver|complete|implement|execute)\b/i,
  ];
  if (l2Patterns.some((p) => p.test(lower)) || wordCount > 35) {
    return 'L2';
  }

  // L1: Standard single-agent tasks
  return 'L1';
}

/**
 * Heuristic rules for auto-classifying intent category.
 * Uses prioritized pattern matching — first match wins.
 *
 * @param intent - User intent text
 * @returns Classified intent category
 */
export function classifyIntentCategory(intent: string): IntentCategory {
  const lower = intent.toLowerCase();

  // Debugging: bug fixes, error investigation, tracing
  if (/\b(fix|bug|error|crash|broken|issue|debug|trace|stack\s*trace|exception|segfault|panic|hang|leak|regression|flaky)\b/.test(lower)) return 'debugging';

  // Deployment: releases, CI/CD, infrastructure (require deployment-specific context)
  if (/\b(deploy|staging|production|docker|kubernetes|k8s|helm|terraform|ansible|nginx|container|image|rollback|rollout)\b/.test(lower)) return 'deployment';
  if (/\b(release)\b/.test(lower) && !/\b(announce|notify|tell|inform|message|communicate)\b/.test(lower)) return 'deployment';
  if (/\b(ci|cd)\b/.test(lower) && /\b(pipeline|build|run|trigger|fix)\b/.test(lower)) return 'deployment';

  // Review: code review, PR, audit
  if (/\b(review|pr\b|pull\s+request|code\s+review|audit|approve|reject|lgtm)\b/.test(lower)) return 'review';

  // Research: investigation, exploration, analysis, comparison
  if (/\b(research|investigate|explore|analyze|compare|evaluate|benchmark|measure|profile|survey|study)\b/.test(lower)) return 'research';

  // Planning: strategy, design, architecture, roadmap
  if (/\b(plan|roadmap|strategy|design|architect|spec|specification|rfc|proposal|estimate|prioritize|schedule|timeline|milestone)\b/.test(lower)) return 'planning';

  // Communication: messaging, notifications, announcements
  if (/\b(message|notify|slack|email|communicate|tell\s|announce|broadcast|ping|alert|report\s+to|inform|update\s+the\s+team)\b/.test(lower)) return 'communication';

  // Code change: implementation, modification, creation (broad — checked after more specific categories)
  if (/\b(implement|code|write|add|update|modify|refactor|create|build|develop|rename|move|copy|delete|remove|clean\s*up|optimize|improve|enhance|extend|extract|inline|merge|split|convert|transform|generate|scaffold|bootstrap|set\s*up|configure|install|integrate|connect|wire|hook\s*up|enable|disable)\b/.test(lower)) return 'code_change';

  // Query: information retrieval, status checks, lookups
  if (/\b(what|where|when|who|which|how|show|list|get|status|check|find|search|look\s*up|count|describe|explain)\b/.test(lower)) return 'query';

  return 'other';
}

// =============================================================================
// Decomposition Helpers
// =============================================================================

/**
 * Combined regex that splits on intent boundaries in a single pass.
 * Matches: "then", "after that", "and then", "and also", "also", "plus",
 * numbered lists ("1. ... 2. ..."), semicolons, and "and/," before action verbs.
 *
 * Uses non-capturing groups and alternation with priority ordering.
 */
const SPLIT_REGEX = /\s*(?:\band\s+then\b|\bafter\s+that\b|\band\s+also\b|\bthen\b|\balso\b|\bplus\b|\s*;\s*|\s*\d+\)\s*|\s*\d+\.\s+(?=[A-Z])|(?:,\s*|\s+and\s+)(?=(?:search|find|fix|build|create|deploy|implement|add|update|delete|remove|write|read|check|test|run|make|do|send|set\s*up|configure|install|download|upload|convert|transform|generate|export|import|review|audit|analyze|investigate|research|design|plan|monitor|debug|refactor|migrate|optimize|clean|start|stop|restart|enable|disable|schedule|assign|push|pull|commit|release|merge|connect|move|copy|rename|backup|restore)\b))\s*/i;

/**
 * Decompose a user message into multiple individual actionable intents.
 *
 * Three-phase pipeline:
 * 1. **Split**: Single-pass regex split on conjunctions and sequential markers.
 * 2. **Filter**: Remove non-actionable segments (questions, greetings, feedback, filler).
 * 3. **Classify**: Independently classify each actionable segment by level and category.
 *
 * @param message - The full user message
 * @returns DecomposeResult with the original message and extracted actionable intents.
 *          Returns empty intents array if no actionable content is found.
 *
 * @example
 * ```typescript
 * const result = decomposeIntents('Search for abc then make it into a PDF');
 * // result.intents = [
 * //   { intent: 'Search for abc', level: 'L0', category: 'query' },
 * //   { intent: 'make it into a PDF', level: 'L1', category: 'code_change' },
 * // ]
 *
 * // Non-actionable messages return empty
 * const result2 = decomposeIntents('Looks good, thanks!');
 * // result2.intents = []
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

  // Phase 1: Split on intent boundaries (single-pass)
  const rawSegments = trimmed.split(SPLIT_REGEX)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_ACTIONABLE_CHARS);

  // Phase 2: Filter to actionable intents only
  const actionable = rawSegments.filter((seg) => isActionableIntent(seg));

  // If splitting produced no actionable segments, check if the whole message is actionable
  if (actionable.length === 0) {
    if (isActionableIntent(trimmed)) {
      return {
        originalMessage: message,
        messageId: '',
        intents: [{
          intent: trimmed,
          level: classifyIntentLevel(trimmed),
          category: classifyIntentCategory(trimmed),
        }],
      };
    }
    // Entire message is non-actionable → no tasks
    return {
      originalMessage: message,
      messageId: '',
      intents: [],
    };
  }

  // Phase 3: Classify each actionable segment
  const intents: DecomposedIntent[] = actionable.map((seg) => ({
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
