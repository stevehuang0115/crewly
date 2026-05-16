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
 * Intent classification types are owned by `v2/request.types.ts` — it's
 * the domain-shape file and `IntentLevel` / `IntentCategory` are properties
 * of `Request`. Re-exported here so existing import paths from this module
 * keep working. Issue #474.
 *
 * Imported locally below because subsequent type declarations in this
 * module reference these aliases; `export type {}` alone only re-exports
 * and doesn't bring the names into local scope.
 */
import type { IntentLevel, IntentCategory } from './v2/request.types.js';
export type { IntentLevel, IntentCategory };

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

// Bug A v0 (2026-05-06): classifier rule-set externalised to
// `backend/src/services/intent-task/intent-classifier.rules.ts` per Mia §5
// Q4 (code-of-record). Re-importing the EN action-verb pattern + the new
// ZH counterpart + the ZH non-actionable pre-filters keeps this file's
// historical EN rules in place while extending coverage symmetrically.
import {
  ACTION_VERB_EN,
  ACTION_VERB_ZH,
  NON_ACTIONABLE_PATTERNS_ZH,
  L2_QUANTIFIER_TRIGRAM,
  L2_TRIGRAM_STATE_CHANGE_VERB,
  L2_TRIGRAM_DELIVERABLE,
  L2_DOC_CREATION_TRIGGER,
  L2_FILE_EXTENSION_TRIGGER,
  L2_PR_ARTIFACT_TRIGGER,
  L2_MIGRATION_TRIGGER,
  L2_BUILD_SYSTEM_NOUN,
  L2_DEPLOY_ENV_NOUN,
  L2_E2E_SCOPE,
  L2_COORDINATE,
  L2_SEQUENCED_VERBS,
  L2_NUMBERED_LIST,
  L2_CROSS_SYSTEM_PIVOT,
  L3_SPRINT_OKR_MARKERS,
  L3_TIMEBOX_MARKERS,
  L3_DELIVER_SHIP_VERBS,
  L0_READ_VERB_PATTERN,
  L2_LENGTH_FLOORS,
  CATEGORY_KEYWORDS,
} from '../services/intent-task/intent-classifier.rules.js';

/**
 * Patterns that indicate a message is NOT actionable (should not become a task).
 * These cover greetings, acknowledgments, questions, feedback, opinions, and filler.
 *
 * Bug A v0 (2026-05-06): the ZH-specific patterns live in
 * {@link NON_ACTIONABLE_PATTERNS_ZH} (imported above) so the rule list is
 * grouped by language. Both arrays are checked in `isActionableIntent`.
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
 * Combined action-verb pattern (EN + ZH). A message must match ONE of
 * these to be considered actionable when no non-actionable pattern fires.
 *
 * Note: a regex test against this composite is implemented as two checks
 * in `isActionableIntent` rather than a single `|` union because the EN
 * pattern uses `\b` word boundaries (which behave incorrectly across CJK
 * codepoints) and the ZH pattern relies on negative lookaheads (kept
 * separate so each is type-clean).
 */
const ACTION_VERB_PATTERN = ACTION_VERB_EN;

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

  // Check EN non-actionable patterns first (fast reject).
  for (const pattern of NON_ACTIONABLE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  // Bug A v0 (Mia spec §3 + stricter-default 2026-05-06): ZH non-actionable
  // patterns including conversational-filler forms of dual-use verbs
  // (做了 / 搞砸 / 做不到) so the L2 promoter never sees a "completed" or
  // "denial" sentence.
  for (const pattern of NON_ACTIONABLE_PATTERNS_ZH) {
    if (pattern.test(trimmed)) return false;
  }

  // Must contain at least one action verb to be considered a task. EN
  // pattern uses \b word-boundaries (only meaningful in Latin); ZH pattern
  // is checked separately because \b does not interpret CJK boundaries.
  return ACTION_VERB_PATTERN.test(trimmed) || ACTION_VERB_ZH.test(trimmed);
}

// =============================================================================
// Classification Helpers
// =============================================================================

/**
 * Heuristic rules for auto-classifying intent level into L0/L1/L2/L3.
 *
 * Decision order (highest precision first):
 *   1. **L0** — read-only / status / lookup; quantified read still L0.
 *   2. **L3** — sprint/OKR markers + system-level scope (§2.6 + §2.3).
 *   3. **L2** — quantifier-trigram (§2.1), doc/file/PR/migration triggers
 *      (§2.2), build/system + deploy/env + e2e + coordinate (§2.3),
 *      sequenced verbs / numbered list (§2.4), cross-system pivot (§2.5),
 *      sprint markers alone (§2.6), or length floor (§2.7 — wordCount > 35
 *      OR charCount > 80 for ZH parity).
 *   4. **L1** — fallback (single bounded directive).
 *
 * Spec: `specs/2026-05-06-intent-classifier-rules.md` §1.2 + §2.
 *
 * @param intent - User intent text
 * @returns Classified intent level
 */
export function classifyIntentLevel(intent: string): IntentLevel {
  const lower = intent.toLowerCase();
  const wordCount = intent.split(/\s+/).filter(Boolean).length;
  // Issue #473: trim before measuring so leading/trailing whitespace
  // doesn't trip the §2.7 length floor. The wordCount axis is already
  // trim-equivalent via `.filter(Boolean)` — charCount should match.
  const charCount = intent.trim().length;

  // ---------------------------------------------------------------------
  // L0 — read-only / status / lookup (no state change).
  //
  // Anti-promotion guard for §2.1 + §3 last paragraph: if the verb axis
  // is read-only AND the message is short AND no §2.2-§2.6 promoter
  // fires below, classify L0. We defer the L0 decision until AFTER §2
  // promoter checks so a quantified state-change ("做这两份 md 文档")
  // doesn't get squashed by the read-verb pattern when the read verb
  // happens to also appear (e.g. "look at and fix").
  // ---------------------------------------------------------------------
  const isShortMessage = wordCount <= 12 && charCount <= 60;
  const l0LegacyPatterns = [
    /^(what|where|when|who|how|is|are|can|does|do|show|list|get|check|find)\b/i,
    /\?$/,
    /\b(status|version|health|uptime|count|list)\b/i,
  ];

  // ---------------------------------------------------------------------
  // L3 — sprint/OKR initiative.
  //
  // §2.6 + §2.3: when sprint/OKR markers AND a system-level verb-noun
  // both fire, the message is a multi-day initiative. Routed identically
  // to L2 in v0; the label preserves intent for future routing-split.
  // ---------------------------------------------------------------------
  const sprintMarkerFires =
    L3_SPRINT_OKR_MARKERS.en.test(lower) ||
    L3_SPRINT_OKR_MARKERS.zh.test(intent) ||
    L3_TIMEBOX_MARKERS.en.test(lower) ||
    L3_TIMEBOX_MARKERS.zh.test(intent);
  // §2.3 — broad system-level verb-noun signal (build OR deploy OR e2e
  // OR coordinate). Matches Mia's spec: "If 2.6 + 2.3 both fire → L3."
  const l2_2_3_fires =
    L2_BUILD_SYSTEM_NOUN.en.test(lower) ||
    L2_BUILD_SYSTEM_NOUN.zh.test(intent) ||
    L2_DEPLOY_ENV_NOUN.en.test(lower) ||
    L2_DEPLOY_ENV_NOUN.zh.test(intent) ||
    L2_E2E_SCOPE.en.test(lower) ||
    L2_E2E_SCOPE.zh.test(intent) ||
    L2_COORDINATE.en.test(lower) ||
    L2_COORDINATE.zh.test(intent);
  const deliverShipFires =
    L3_DELIVER_SHIP_VERBS.en.test(lower) || L3_DELIVER_SHIP_VERBS.zh.test(intent);

  if (sprintMarkerFires && (l2_2_3_fires || deliverShipFires)) {
    return 'L3';
  }

  // ---------------------------------------------------------------------
  // L2 — multi-step / multi-artifact / multi-agent / cross-system / plural.
  //
  // Order within L2: highest-precision triggers first (§2.1 trigram), then
  // structural cues (§2.2/§2.3/§2.4/§2.5), then sprint-marker-alone
  // (§2.6), then the length floor.
  // ---------------------------------------------------------------------

  // §2.1 — quantifier + state-change verb + plural deliverable.
  // Three-axis check (order-agnostic) so VERB-QUANT-NOUN, QUANT-VERB-NOUN,
  // and QUANT-NOUN-VERB all promote. The §3 anti-pattern guard
  // ("quantifier alone is not L2") is preserved by requiring the verb
  // axis explicitly — a quantified read query like "show me all 3
  // statuses" fails the verb-axis check and stays L0.
  const quantifierFires =
    L2_QUANTIFIER_TRIGRAM.en.test(intent) || L2_QUANTIFIER_TRIGRAM.zh.test(intent);
  const stateChangeVerbFires =
    L2_TRIGRAM_STATE_CHANGE_VERB.en.test(lower) ||
    L2_TRIGRAM_STATE_CHANGE_VERB.zh.test(intent);
  const deliverableFires =
    L2_TRIGRAM_DELIVERABLE.en.test(lower) || L2_TRIGRAM_DELIVERABLE.zh.test(intent);
  if (quantifierFires && stateChangeVerbFires && deliverableFires) {
    return 'L2';
  }

  // §2.2 — doc/spec creation, file-with-extension, PR/commit artifact,
  // migration/schema. Each is a structural multi-artifact promoter.
  // (file-extension respects the read-only verb guard: a request that
  // ONLY references a file path with a read verb stays L0/L1.)
  const fileExtensionFires = L2_FILE_EXTENSION_TRIGGER.test(intent);
  const docCreationFires =
    L2_DOC_CREATION_TRIGGER.en.test(lower) || L2_DOC_CREATION_TRIGGER.zh.test(intent);
  const prArtifactFires =
    L2_PR_ARTIFACT_TRIGGER.en.test(lower) || L2_PR_ARTIFACT_TRIGGER.zh.test(intent);
  const migrationFires =
    L2_MIGRATION_TRIGGER.en.test(lower) || L2_MIGRATION_TRIGGER.zh.test(intent);

  if (docCreationFires || prArtifactFires || migrationFires) {
    return 'L2';
  }

  // File-extension triggers only when paired with non-read verb. This is
  // the §2.2 row 2 caveat: "any path with extension is L2 unless the verb
  // is read-only".
  if (fileExtensionFires) {
    const readOnly =
      L0_READ_VERB_PATTERN.en.test(lower) || L0_READ_VERB_PATTERN.zh.test(intent);
    if (!readOnly) return 'L2';
  }

  // §2.3 — build/system, deploy/env, e2e, coordinate.
  if (
    L2_BUILD_SYSTEM_NOUN.en.test(lower) ||
    L2_BUILD_SYSTEM_NOUN.zh.test(intent) ||
    L2_DEPLOY_ENV_NOUN.en.test(lower) ||
    L2_DEPLOY_ENV_NOUN.zh.test(intent) ||
    L2_E2E_SCOPE.en.test(lower) ||
    L2_E2E_SCOPE.zh.test(intent) ||
    L2_COORDINATE.en.test(lower) ||
    L2_COORDINATE.zh.test(intent) ||
    /\bmulti[- ]?(agent|step|phase|stage)\b/i.test(intent) ||
    /多.{0,4}(步|阶段|环节|轮)/.test(intent)
  ) {
    return 'L2';
  }

  // §2.4 — sequenced verbs / numbered list. Two distinct steps in a
  // single sentence is structurally L2.
  if (
    L2_SEQUENCED_VERBS.en.test(lower) ||
    L2_SEQUENCED_VERBS.zh.test(intent) ||
    L2_NUMBERED_LIST.test(intent)
  ) {
    return 'L2';
  }

  // §2.5 — cross-system pivot ("oss重启了 你现在再做这个").
  if (L2_CROSS_SYSTEM_PIVOT.en.test(lower) || L2_CROSS_SYSTEM_PIVOT.zh.test(intent)) {
    return 'L2';
  }

  // §2.6 alone — sprint marker without system noun. Still L2 (multi-step
  // by sprint definition); only combined with §2.3 does it become L3.
  if (sprintMarkerFires) {
    return 'L2';
  }

  // §2.7 — length floor. EN word-count OR ZH char-count.
  if (wordCount > L2_LENGTH_FLOORS.wordCount || charCount > L2_LENGTH_FLOORS.charCount) {
    return 'L2';
  }

  // ---------------------------------------------------------------------
  // L0 fallback — short read-shaped message that did not promote.
  // ---------------------------------------------------------------------
  if (isShortMessage && l0LegacyPatterns.some((p) => p.test(lower))) {
    return 'L0';
  }

  // ZH read-shaped: short query starting with what/which/how/where in ZH.
  if (
    isShortMessage &&
    (/^(什么|哪|多少|怎么|怎样|是否|有没有)/.test(intent) ||
      L0_READ_VERB_PATTERN.zh.test(intent))
  ) {
    return 'L0';
  }

  // L1 — standard single-agent task fallback.
  return 'L1';
}

/**
 * Heuristic rules for auto-classifying intent category.
 * Uses prioritized pattern matching — first match wins.
 *
 * Bug A v0 (2026-05-06): each category fires on EITHER the EN pattern OR
 * the ZH parity pattern from {@link CATEGORY_KEYWORDS}. Order is preserved
 * from the pre-existing EN classifier so historical EN cases stay green.
 *
 * @param intent - User intent text
 * @returns Classified intent category
 */
export function classifyIntentCategory(intent: string): IntentCategory {
  const lower = intent.toLowerCase();

  // Debugging: bug fixes, error investigation, tracing
  if (
    CATEGORY_KEYWORDS.debugging.en.test(lower) ||
    CATEGORY_KEYWORDS.debugging.zh.test(intent)
  ) {
    return 'debugging';
  }

  // Deployment: releases, CI/CD, infrastructure (require deployment-specific context)
  if (
    CATEGORY_KEYWORDS.deployment.en.test(lower) ||
    CATEGORY_KEYWORDS.deployment.zh.test(intent)
  ) {
    return 'deployment';
  }
  if (
    (CATEGORY_KEYWORDS.release.en.test(lower) || CATEGORY_KEYWORDS.release.zh.test(intent)) &&
    !(CATEGORY_KEYWORDS.communication.en.test(lower) || CATEGORY_KEYWORDS.communication.zh.test(intent))
  ) {
    return 'deployment';
  }
  if (
    (CATEGORY_KEYWORDS.ciCdContext.en.test(lower) || CATEGORY_KEYWORDS.ciCdContext.zh.test(intent)) &&
    (CATEGORY_KEYWORDS.ciCdAction.en.test(lower) || CATEGORY_KEYWORDS.ciCdAction.zh.test(intent))
  ) {
    return 'deployment';
  }

  // Review: code review, PR, audit
  if (
    CATEGORY_KEYWORDS.review.en.test(lower) ||
    CATEGORY_KEYWORDS.review.zh.test(intent)
  ) {
    return 'review';
  }

  // Research: investigation, exploration, analysis, comparison
  if (
    CATEGORY_KEYWORDS.research.en.test(lower) ||
    CATEGORY_KEYWORDS.research.zh.test(intent)
  ) {
    return 'research';
  }

  // Planning: strategy, design, architecture, roadmap
  if (
    CATEGORY_KEYWORDS.planning.en.test(lower) ||
    CATEGORY_KEYWORDS.planning.zh.test(intent)
  ) {
    return 'planning';
  }

  // Communication: messaging, notifications, announcements
  if (
    CATEGORY_KEYWORDS.communication.en.test(lower) ||
    CATEGORY_KEYWORDS.communication.zh.test(intent)
  ) {
    return 'communication';
  }

  // Code change: implementation, modification, creation (broad — last among actionables)
  if (
    CATEGORY_KEYWORDS.codeChange.en.test(lower) ||
    CATEGORY_KEYWORDS.codeChange.zh.test(intent)
  ) {
    return 'code_change';
  }

  // Query: information retrieval, status checks, lookups
  if (
    CATEGORY_KEYWORDS.query.en.test(lower) ||
    CATEGORY_KEYWORDS.query.zh.test(intent)
  ) {
    return 'query';
  }

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
