/**
 * Backend-specific constants
 * Re-exported from the main config constants for backend use
 */

// Import from config directory for cross-domain constants
import {
  CREWLY_CONSTANTS as CONFIG_CREWLY_CONSTANTS,
  AGENT_IDENTITY_CONSTANTS as CONFIG_AGENT_IDENTITY_CONSTANTS,
  TIMING_CONSTANTS as CONFIG_TIMING_CONSTANTS,
  MEMORY_CONSTANTS as CONFIG_MEMORY_CONSTANTS,
  CONTINUATION_CONSTANTS as CONFIG_CONTINUATION_CONSTANTS,
  ORCHESTRATOR_RESTART_CONSTANTS as CONFIG_ORCHESTRATOR_RESTART_CONSTANTS,
  AGENT_SUSPEND_CONSTANTS as CONFIG_AGENT_SUSPEND_CONSTANTS,
  VERSION_CHECK_CONSTANTS as CONFIG_VERSION_CHECK_CONSTANTS,
  AGENT_HEARTBEAT_MONITOR_CONSTANTS as CONFIG_AGENT_HEARTBEAT_MONITOR_CONSTANTS,
  ORCHESTRATOR_HEARTBEAT_CONSTANTS as CONFIG_ORCHESTRATOR_HEARTBEAT_CONSTANTS,
  MARKETPLACE_CONSTANTS as CONFIG_MARKETPLACE_CONSTANTS,
} from '../../config/constants.js';

// Re-export the cross-domain constants for backend use
export const AGENT_IDENTITY_CONSTANTS = CONFIG_AGENT_IDENTITY_CONSTANTS;
export const TIMING_CONSTANTS = CONFIG_TIMING_CONSTANTS;
export const MEMORY_CONSTANTS = CONFIG_MEMORY_CONSTANTS;
export const CONTINUATION_CONSTANTS = CONFIG_CONTINUATION_CONSTANTS;
export const ORCHESTRATOR_RESTART_CONSTANTS = CONFIG_ORCHESTRATOR_RESTART_CONSTANTS;
export const AGENT_SUSPEND_CONSTANTS = CONFIG_AGENT_SUSPEND_CONSTANTS;
export const VERSION_CHECK_CONSTANTS = CONFIG_VERSION_CHECK_CONSTANTS;
export const AGENT_HEARTBEAT_MONITOR_CONSTANTS = CONFIG_AGENT_HEARTBEAT_MONITOR_CONSTANTS;
export const ORCHESTRATOR_HEARTBEAT_CONSTANTS = CONFIG_ORCHESTRATOR_HEARTBEAT_CONSTANTS;

// Re-export specific constants that the backend needs from the main config
export const ORCHESTRATOR_SESSION_NAME = CONFIG_CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;
export const ORCHESTRATOR_ROLE = 'orchestrator';
export const ORCHESTRATOR_WINDOW_NAME = 'Crewly Orchestrator';
export const AGENT_INITIALIZATION_TIMEOUT = 90000;
export const CLAUDE_INITIALIZATION_TIMEOUT = 45000;

// Merge cross-domain constants with backend-specific extensions
export const CREWLY_CONSTANTS = {
	...CONFIG_CREWLY_CONSTANTS,
	// Backend-specific extensions
	INIT_SCRIPTS: {
		CLAUDE: 'initialize_claude.sh',
	},
} as const;

// Environment variable names (duplicated from config/constants.ts for backend use)
export const ENV_CONSTANTS = {
	/** PTY session name used for agent identity and heartbeat tracking */
	CREWLY_SESSION_NAME: 'CREWLY_SESSION_NAME',
	CREWLY_ROLE: 'CREWLY_ROLE',
	/** Base URL for the Crewly backend API (used by orchestrator bash skills) */
	CREWLY_API_URL: 'CREWLY_API_URL',
	/** Gemini API key for embedding-based knowledge search */
	GEMINI_API_KEY: 'GEMINI_API_KEY',
} as const;

// Agent-specific timeout values (in milliseconds)
export const AGENT_TIMEOUTS = {
	ORCHESTRATOR_INITIALIZATION: 120000, // 2 minutes for orchestrator
	REGULAR_AGENT_INITIALIZATION: 75000, // 75 seconds for regular agents
} as const;

// Agent runtime types
export const RUNTIME_TYPES = {
	CLAUDE_CODE: 'claude-code',
	GEMINI_CLI: 'gemini-cli',
	CODEX_CLI: 'codex-cli',
} as const;

/** Error patterns indicating non-recoverable failures (e.g. missing CLI binary) that should not be retried. */
export const NON_RECOVERABLE_ERROR_PATTERNS = ['command not found', 'not installed', 'No such file'] as const;

// PTY session constants
export const PTY_CONSTANTS = {
	MAX_DATA_LISTENERS: 100,
	MAX_EXIT_LISTENERS: 50,
	DEFAULT_MAX_HISTORY_SIZE: 10 * 1024 * 1024, // 10MB
	DEFAULT_SCROLLBACK: 5000,
	DEFAULT_COLS: 80,
	DEFAULT_ROWS: 24,
	MAX_RESIZE_COLS: 1000,
	MAX_RESIZE_ROWS: 1000,
	/** Delay before escalating from SIGTERM to SIGKILL in forceKill (ms) */
	FORCE_KILL_ESCALATION_DELAY: 500,
	/** Delay before escalating from SIGTERM to SIGKILL in forceDestroyAll (ms) */
	FORCE_DESTROY_ESCALATION_DELAY: 1000,
	/** Minimum non-whitespace characters in stripped PTY output to count as meaningful activity */
	MIN_MEANINGFUL_OUTPUT_BYTES: 2,
	/** Minimum time (ms) an agent must remain in_progress before emitting busy/idle events */
	MIN_BUSY_DURATION_MS: 10000,
} as const;

// Session command timing delays (in milliseconds)
export const SESSION_COMMAND_DELAYS = {
	/** Delay after sending a message (allows terminal to process bracketed paste) */
	MESSAGE_DELAY: 1000,
	/** Delay after sending a key (allows key to be processed) */
	KEY_DELAY: 200,
	/** Delay after clearing command line (allows terminal to reset) */
	CLEAR_COMMAND_DELAY: 100,
	/** Delay after setting environment variable */
	ENV_VAR_DELAY: 100,
	/** Delay for Claude Code to recover from state changes */
	CLAUDE_RECOVERY_DELAY: 300,
	/** Delay between message delivery retry attempts */
	MESSAGE_RETRY_DELAY: 1000,
	/** Additional delay for Claude Code to start processing after message sent */
	MESSAGE_PROCESSING_DELAY: 500,
	/** Progressive re-check intervals for Claude Code delivery verification (ms).
	 *  Total window: 500ms (processing delay) + 1000 + 2000 + 3000 = 6.5s */
	CLAUDE_VERIFICATION_INTERVALS: [1000, 2000, 3000] as const,
} as const;

// Terminal controller constants
export const TERMINAL_CONTROLLER_CONSTANTS = {
	DEFAULT_CAPTURE_LINES: 50,
	MAX_CAPTURE_LINES: 500,
	MAX_OUTPUT_SIZE: 131072, // 128KB max output per request
} as const;

// Chat routing constants (message markers and patterns for orchestrator communication)
export const CHAT_ROUTING_CONSTANTS = {
	/** Regex pattern for extracting conversation ID from chat messages */
	CONVERSATION_ID_PATTERN: /\[CHAT:([^\]]+)\]/,
	/** Regex pattern for extracting conversation ID from response markers */
	RESPONSE_CONVERSATION_ID_PATTERN: /\[CHAT_RESPONSE:([^\]]+)\]/,
	/** Message format prefix for chat routing */
	MESSAGE_PREFIX: 'CHAT',
} as const;

/**
 * Unified notification marker constants.
 * Used by the orchestrator to send messages to chat, Slack, or both
 * via a single `[NOTIFY]...[/NOTIFY]` block with a JSON payload.
 */
export const NOTIFY_CONSTANTS = {
	/** Regex for extracting complete [NOTIFY]...[/NOTIFY] blocks from terminal output */
	MARKER_PATTERN: /\[NOTIFY\]([\s\S]*?)\[\/NOTIFY\]/g,
	/** Opening marker string for detection */
	OPEN_TAG: '[NOTIFY]',
	/** Closing marker string */
	CLOSE_TAG: '[/NOTIFY]',
} as const;

/**
 * Slack proactive notification constants.
 * @deprecated Use NOTIFY_CONSTANTS instead. Legacy [SLACK_NOTIFY] markers are still
 * processed for backward compatibility but new orchestrator output should use [NOTIFY].
 */
export const SLACK_NOTIFY_CONSTANTS = {
	/** Regex for extracting complete [SLACK_NOTIFY]...[/SLACK_NOTIFY] blocks from terminal output */
	MARKER_PATTERN: /\[SLACK_NOTIFY\]([\s\S]*?)\[\/SLACK_NOTIFY\]/g,
	/** Opening marker string for detection */
	OPEN_TAG: '[SLACK_NOTIFY]',
	/** Closing marker string */
	CLOSE_TAG: '[/SLACK_NOTIFY]',
} as const;

// Event-driven message delivery constants
export const EVENT_DELIVERY_CONSTANTS = {
	/** Timeout for waiting for prompt detection (ms) */
	PROMPT_DETECTION_TIMEOUT: 10000,
	/** Timeout for waiting for delivery confirmation (ms) */
	DELIVERY_CONFIRMATION_TIMEOUT: 5000,
	/** Total timeout for message delivery with retries (ms) */
	TOTAL_DELIVERY_TIMEOUT: 30000,
	/** Default timeout for pattern matching (ms) */
	DEFAULT_PATTERN_TIMEOUT: 30000,
	/** Initial delay for terminal to echo short messages (ms) */
	INITIAL_MESSAGE_DELAY: 300,
	/** Extra time for multi-line paste indicator detection (ms) */
	PASTE_CHECK_DELAY: 1200,
	/** Delay between Enter key retry attempts (ms) */
	ENTER_RETRY_DELAY: 800,
	/** Maximum number of Enter key retry attempts */
	MAX_ENTER_RETRIES: 3,
	/** Delay after Enter retries exhausted before verifying message left input line (ms) */
	POST_ENTER_VERIFICATION_DELAY: 500,
	/** Maximum buffer size for terminal output collection (bytes) */
	MAX_BUFFER_SIZE: 10000,
	/** Minimum buffer length to consider processing detection valid */
	MIN_BUFFER_FOR_PROCESSING_DETECTION: 50,
	/** Timeout for waiting for agent to return to prompt before delivery (ms) */
	AGENT_READY_TIMEOUT: 120000,
	/** Shorter timeout for user messages (Slack/web chat) to reduce delivery delay (ms) */
	USER_MESSAGE_TIMEOUT: 30000,
	/** Whether to force-deliver user messages after timeout instead of re-queuing */
	USER_MESSAGE_FORCE_DELIVER: true,
	/** Shorter timeout for system events to reduce notification delay (ms) */
	SYSTEM_EVENT_TIMEOUT: 60000,
	/** Whether to force-deliver system events after timeout instead of re-queuing.
	 *  System events are fire-and-forget (no response expected), so force-delivery
	 *  is lower risk than for user messages. Prevents the 5×120s=10min retry loop. */
	SYSTEM_EVENT_FORCE_DELIVER: true,
	/** Interval for polling agent prompt readiness (ms) */
	AGENT_READY_POLL_INTERVAL: 2000,
	/** Interval for deep-scan polling with larger buffer when fast poll misses prompt (ms) */
	DEEP_SCAN_INTERVAL: 5000,
	/** Number of lines to capture for deep-scan prompt detection */
	DEEP_SCAN_LINES: 500,
} as const;

/**
 * Constants for terminal content formatting.
 * Used by formatMessageContent to safely process terminal output.
 */
export const TERMINAL_FORMATTING_CONSTANTS = {
	/** Maximum repeat count for cursor movement sequences (prevents memory exhaustion) */
	MAX_CURSOR_REPEAT: 1000,
} as const;

/**
 * Terminal detection patterns for Claude Code interaction.
 * These patterns are used across multiple services to detect terminal state.
 */
export const TERMINAL_PATTERNS = {
	/**
	 * Braille spinner characters used by Claude Code to indicate processing.
	 * Pattern: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
	 */
	SPINNER: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,

	/**
	 * Claude Code's "working" indicator (filled circle).
	 */
	WORKING_INDICATOR: /⏺/,

	/**
	 * Combined pattern for detecting any processing activity.
	 * Includes spinner, working indicator, and status text.
	 */
	PROCESSING: /⏺|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,

	/**
	 * Pattern for detecting paste indicator in bracketed paste mode.
	 * Appears as "[Pasted text #N +M lines]" in Claude Code.
	 */
	PASTE_INDICATOR: /\[Pasted text/,

	/**
	 * Pattern to detect if paste indicator is still visible (stuck state).
	 */
	PASTE_STUCK: /\[Pasted text #\d+ \+\d+ lines\]/,

	/**
	 * Agent prompt indicators (characters that appear at input prompts).
	 * Includes Claude Code (❯, >, ⏵), bash ($), and Gemini CLI (!).
	 */
	PROMPT_CHARS: ['❯', '>', '›', '⏵', '$', '!'] as const,

	/**
	 * Claude Code idle prompt detection.
	 * Matches:
	 * - ❯ or ⏵ or $ alone on a line (standard Claude Code prompt)
	 * - ❯❯ or ⏵⏵ followed by space or end-of-line (bypass permissions prompt,
	 *   e.g. "⏵⏵ bypass permissions on (shift+tab to cycle)")
	 */
	CLAUDE_CODE_PROMPT: /(?:^|\n)\s*(?:[❯⏵$]\s*(?:\n|$)|❯❯(?:\s|$))/,

	/**
	 * Gemini CLI idle prompt detection.
	 * Matches:
	 * - > or ! followed by a space (TUI prompt, may have placeholder text)
	 * - Box-drawing border (│, ┃) followed by > or ! (TUI bordered prompt)
	 * - "Type your message …" or "YOLO mode …" textual prompts
	 */
	GEMINI_CLI_PROMPT: /(?:^|\n)\s*(?:[>!]\s|[│┃]\s*[>!]\s|.*?(?:Type\s+your\s+message|YOLO\s+mode))/i,

	/**
	 * Codex CLI idle prompt detection.
	 * Matches:
	 * - `› ` prompt lines (Codex TUI prompt indicator)
	 * - Box-drawing border followed by `›` or `>`
	 * - Textual input placeholder shown by Codex
	 */
	CODEX_CLI_PROMPT: /(?:^|\n)\s*(?:›\s|[│┃]\s*[›>]\s|.*?Type\s+your\s+message(?:\s+or\s+@path\/to\/file)?)/i,

	/**
	 * Combined prompt pattern for any runtime (union of Claude Code + Gemini CLI).
	 * Use runtime-specific patterns when you need to distinguish between runtimes.
	 */
	PROMPT_STREAM: /(?:^|\n)\s*(?:[❯⏵$]\s*(?:\n|$)|❯❯(?:\s|$)|[>!]\s|[│┃]\s*[>!]\s|[›>]\s|[│┃]\s*[›>]\s|.*?(?:Type\s+your\s+message|YOLO\s+mode))/i,

	/**
	 * Processing indicators including status text patterns.
	 */
	PROCESSING_INDICATORS: [
		/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Spinner characters
		/Thinking|Processing|Analyzing|Running/i, // Status text
		/\[\d+\/\d+\]/, // Progress indicators like [1/3]
		/\.\.\.$/, // Trailing dots indicating activity
	] as const,

	/**
	 * Pattern for detecting Claude Code processing with status text.
	 * Includes spinner characters, working indicator (⏺), and common status verbs.
	 */
	PROCESSING_WITH_TEXT: /thinking|processing|analyzing|running|calling|frosting|⏺|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/i,

	/**
	 * Pattern for detecting Claude Code's "esc to interrupt" status bar text.
	 * This text only appears when the agent is actively processing, making it
	 * a reliable busy indicator. It's absent when the agent is idle at prompt.
	 */
	BUSY_STATUS_BAR: /esc\s+to\s+interrupt/i,

	/**
	 * Pattern for detecting Claude Code's Rewind mode.
	 * Rewind mode is triggered by ESC during processing and displays a
	 * restore UI. If detected, send 'q' to exit before attempting delivery.
	 */
	REWIND_MODE: /Rewind[\s\S]*?Restore the code/,
} as const;

/**
 * Patterns for detecting Claude Code plan mode in terminal output.
 * When plan mode is detected, the session command helper should send
 * Escape to dismiss it before delivering messages.
 *
 * Re-exported from waiting-patterns to maintain a single source of truth.
 */
export { PLAN_MODE_PATTERNS as PLAN_MODE_DISMISS_PATTERNS } from './services/continuation/patterns/waiting-patterns.js';

/**
 * Message queue constants for sequential message processing.
 * Used by the MessageQueueService for orchestrator communication.
 */
export const MESSAGE_QUEUE_CONSTANTS = {
	/** Maximum number of messages allowed in the queue */
	MAX_QUEUE_SIZE: 100,
	/** Default timeout for a single message response (ms) */
	DEFAULT_MESSAGE_TIMEOUT: 120000,
	/** Maximum number of completed/failed messages retained in history */
	MAX_HISTORY_SIZE: 50,
	/** Delay between processing consecutive messages (ms) */
	INTER_MESSAGE_DELAY: 500,
	/** Maximum number of requeue retries before permanently failing a message */
	MAX_REQUEUE_RETRIES: 5,
	/** Early ACK check timeout — if no terminal output within this window after
	 *  delivery, the orchestrator is likely context-exhausted (ms) */
	ACK_TIMEOUT: 15000,
	/** Maximum number of system events to batch into a single delivery */
	MAX_SYSTEM_EVENT_BATCH: 100,
	/** Max combined chars when coalescing pending system events in-queue */
	MAX_SYSTEM_EVENT_COALESCE_CHARS: 12000,
	/** Queue persistence file name (stored under crewly home) */
	PERSISTENCE_FILE: 'message-queue.json',
	/** Queue persistence directory name */
	PERSISTENCE_DIR: 'queue',
	/** Initial delay before the first progress message in waitForResponse (ms) */
	PROGRESS_INITIAL_MS: 90_000,
	/** Interval between subsequent progress messages (ms) */
	PROGRESS_INTERVAL_MS: 60_000,
	/** Socket.IO event names for queue status updates */
	SOCKET_EVENTS: {
		/** Emitted when a new message is enqueued */
		MESSAGE_ENQUEUED: 'queue:message_enqueued',
		/** Emitted when a message starts processing */
		MESSAGE_PROCESSING: 'queue:message_processing',
		/** Emitted when a message is completed */
		MESSAGE_COMPLETED: 'queue:message_completed',
		/** Emitted when a message fails */
		MESSAGE_FAILED: 'queue:message_failed',
		/** Emitted when a message is cancelled */
		MESSAGE_CANCELLED: 'queue:message_cancelled',
		/** Emitted with full queue status update */
		STATUS_UPDATE: 'queue:status_update',
	},
} as const;

/**
 * Event bus constants for the agent event pub/sub system.
 * Used by EventBusService for subscription management and notification delivery.
 */
export const EVENT_BUS_CONSTANTS = {
	/** Debounce window for batching event notifications (ms).
	 *  Events within this window are deduplicated per agent and delivered
	 *  as a single combined message to reduce orchestrator context consumption. */
	EVENT_DEBOUNCE_WINDOW_MS: 5000,
	/** Default subscription time-to-live in minutes (2 hours) */
	DEFAULT_SUBSCRIPTION_TTL_MINUTES: 120,
	/** Maximum allowed subscription TTL in minutes (24 hours) */
	MAX_SUBSCRIPTION_TTL_MINUTES: 1440,
	/** Maximum subscriptions per subscriber session */
	MAX_SUBSCRIPTIONS_PER_SESSION: 50,
	/** Maximum total subscriptions across all sessions */
	MAX_TOTAL_SUBSCRIPTIONS: 200,
	/** Interval for cleaning up expired subscriptions (ms) */
	CLEANUP_INTERVAL: 60000,
	/** Prefix for event notification messages delivered to orchestrator */
	EVENT_MESSAGE_PREFIX: 'EVENT',
} as const;

/**
 * Constants for Slack thread file storage.
 * Used by SlackThreadStoreService to persist thread conversations
 * and agent-thread associations.
 */
export const SLACK_THREAD_CONSTANTS = {
	/** Directory name under crewly home for thread files */
	STORAGE_DIR: 'slack-threads',
	/** JSON file mapping agents to their originating threads */
	AGENT_INDEX_FILE: 'agent-index.json',
	/** File extension for thread conversation files */
	FILE_EXTENSION: '.md',
	/** Maximum age for thread files before cleanup (30 days) */
	MAX_THREAD_AGE_MS: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Constants for Slack bridge fallback delivery.
 * When the reply-slack skill doesn't deliver within the wait window,
 * the bridge sends the response directly as a fallback.
 */
export const SLACK_BRIDGE_CONSTANTS = {
	/** Time to wait for the reply-slack skill to deliver before fallback (ms) */
	SKILL_DELIVERY_WAIT_MS: 10_000,
} as const;

/**
 * Constants for NOTIFY Slack delivery reconciliation.
 * Used by NotifyReconciliationService to retry failed Slack deliveries
 * using persisted chat messages as the source of truth.
 */
export const NOTIFY_RECONCILIATION_CONSTANTS = {
	/** Interval between reconciliation runs (5 minutes) */
	RECONCILIATION_INTERVAL_MS: 5 * 60 * 1000,
	/** Maximum age of messages to consider for reconciliation (24 hours) */
	MAX_MESSAGE_AGE_MS: 24 * 60 * 60 * 1000,
	/** Maximum number of delivery attempts before marking as failed */
	MAX_DELIVERY_ATTEMPTS: 5,
	/** Delay before first reconciliation run after startup (30 seconds) */
	STARTUP_DELAY_MS: 30 * 1000,
} as const;

/**
 * Constants for Claude Code session resume via /resume slash command.
 * Used when restarting agents that were previously running before a backend restart.
 */
export const CLAUDE_RESUME_CONSTANTS = {
	/** Delay after sending /resume for the session picker to appear (ms) */
	SESSION_PICKER_DELAY_MS: 3000,
	/** Timeout for Claude to resume and return to prompt (ms) */
	RESUME_READY_TIMEOUT_MS: 30000,
} as const;

/**
 * Constants for Gemini CLI shell mode detection and escape.
 * Gemini CLI enters "shell mode" when it receives a `!` prefix or via `/shell`.
 * In shell mode, input is executed as shell commands instead of being sent to the model.
 * The prompt changes from `>` to `!` (or `$` in some versions).
 */
export const GEMINI_SHELL_MODE_CONSTANTS = {
	/**
	 * Patterns that indicate Gemini CLI is in shell mode.
	 * Matches `!` prompt char (with optional box-drawing border) when NOT followed
	 * by typical chat prompt indicators like "Type your message".
	 */
	SHELL_MODE_PROMPT_PATTERNS: [
		/[│┃]\s*!\s*[│┃]/,      // Box-bordered shell prompt: │ ! │
		/[│┃]\s*!\s+\S/,        // Box-bordered shell prompt with text: │ ! command │
	] as const,
	/** Delay after sending Escape to wait for mode switch (ms) */
	ESCAPE_DELAY_MS: 500,
	/** Maximum attempts to exit shell mode */
	MAX_ESCAPE_ATTEMPTS: 3,
} as const;

/**
 * Gemini CLI failure patterns that indicate the CLI is stuck and needs recovery.
 * These patterns are distinct from exit patterns (which indicate the CLI has shut down
 * cleanly). Failure patterns match error states where the CLI may still be running
 * but is non-functional and requires a restart.
 *
 * Used by GeminiRuntimeService and RuntimeExitMonitorService.
 *
 * Note: Explicitly typed as `RegExp[]` instead of using `as const` because
 * `as const` produces a readonly tuple of regex literals, which complicates
 * usage with array methods like `.some()` and `.find()`.
 */
/**
 * Constants for Gemini CLI failure retry with exponential backoff.
 * When Gemini API errors (RESOURCE_EXHAUSTED, UNAVAILABLE, etc.) are detected,
 * the system waits and retries before declaring the agent dead. Gemini CLI
 * often recovers automatically from transient API errors.
 */
export const GEMINI_FAILURE_RETRY_CONSTANTS = {
	/** Maximum retry attempts before triggering exit/restart flow */
	MAX_RETRIES: 5,
	/** Initial backoff delay (ms) — doubles each retry */
	INITIAL_BACKOFF_MS: 1_000,
	/** Maximum backoff delay cap (ms) */
	MAX_BACKOFF_MS: 30_000,
	/** Backoff multiplier per retry */
	BACKOFF_MULTIPLIER: 2,
	/** Lines of terminal output to capture when checking for recovery */
	RECOVERY_CHECK_LINES: 50,
} as const;

export const GEMINI_FAILURE_PATTERNS: RegExp[] = [
	/Request cancelled/,
	/RESOURCE_EXHAUSTED/,
	/UNAVAILABLE/,
	/Connection error/,
	/INTERNAL(?:\s*:|:)/,
	/DEADLINE_EXCEEDED/,
	/PERMISSION_DENIED/,
	/UNAUTHENTICATED/,
];

/**
 * Gemini update/upgrade markers that should trigger forced recovery.
 * These indicate the CLI interrupted the current request for self-update.
 */
export const GEMINI_FORCE_RESTART_PATTERNS: RegExp[] = [
	/Gemini CLI update available!/i,
	/Attempting to automatically update now/i,
	/Gemini CLI is restarting to apply the trust changes/i,
];

/**
 * Constants for runtime exit detection monitoring.
 * Used by RuntimeExitMonitorService to detect when an agent CLI exits.
 */
export const RUNTIME_EXIT_CONSTANTS = {
	/** Maximum rolling buffer size for terminal output (bytes) */
	MAX_BUFFER_SIZE: 8192,
	/** Debounce delay after exit pattern match before confirming (ms) */
	CONFIRMATION_DELAY_MS: 500,
	/**
	 * Grace period after monitoring start to ignore false positives (ms).
	 * Set to 0 because exit patterns (e.g. "Agent powering down",
	 * "Interaction Summary") are specific enough to not appear during
	 * normal runtime initialization output.
	 */
	STARTUP_GRACE_PERIOD_MS: 0,
	/**
	 * Grace period for API activity before confirming a runtime exit (ms).
	 * If the agent made an API call within this window, the exit detection
	 * is treated as a false positive and skipped. This prevents false
	 * restarts when agents are actively calling skills/APIs but happen to
	 * produce PTY output that matches exit patterns.
	 */
	API_ACTIVITY_GRACE_PERIOD_MS: 120_000,
	/**
	 * Interval for polling child process liveness (ms).
	 * Used as a fallback when pattern-based exit detection misses an exit.
	 * Checks if the runtime process (e.g. claude) is still alive via pgrep.
	 */
	PROCESS_POLL_INTERVAL_MS: 10_000,
	/**
	 * Grace period after monitoring starts before process polling begins (ms).
	 * Prevents false positives during startup when the CLI process hasn't
	 * spawned yet.
	 */
	PROCESS_POLL_GRACE_PERIOD_MS: 30_000,
} as const;

/**
 * Constants for context window monitoring and auto-recovery.
 * Used by ContextWindowMonitorService to detect when an agent's Claude Code
 * session is running low on context and trigger proactive warnings or recovery.
 */
export const CONTEXT_WINDOW_MONITOR_CONSTANTS = {
	/** Interval for periodic stale detection and cleanup (ms) */
	CHECK_INTERVAL_MS: 30_000,
	/** Context usage threshold for yellow (warning) level (%) */
	YELLOW_THRESHOLD_PERCENT: 70,
	/** Context usage threshold for red (danger) level (%) */
	RED_THRESHOLD_PERCENT: 85,
	/** Context usage threshold for critical level (%) — triggers compact retry */
	CRITICAL_THRESHOLD_PERCENT: 95,
	/**
	 * Whether auto-recovery (session kill + restart) is enabled at critical threshold.
	 * Disabled by default — prefer runtime-native compact/compress commands which
	 * preserve session state. Auto-recovery is a last resort that loses all context.
	 */
	AUTO_RECOVERY_ENABLED: false,
	/** Maximum recovery attempts within the cooldown window */
	MAX_RECOVERIES_PER_WINDOW: 2,
	/** Cooldown window for recovery rate limiting (30 minutes) */
	COOLDOWN_WINDOW_MS: 30 * 60 * 1000,
	/** Grace period after monitoring start to ignore early readings (ms) */
	STARTUP_GRACE_PERIOD_MS: 60_000,
	/** Maximum rolling buffer size for PTY output (bytes) */
	MAX_BUFFER_SIZE: 4096,
	/** Threshold for considering a context state stale (5 minutes) */
	STALE_DETECTION_THRESHOLD_MS: 5 * 60 * 1000,
	/** Time to wait after sending compact command before checking result (ms) */
	COMPACT_WAIT_MS: 120_000,
	/** Maximum compact attempts per threshold episode before giving up */
	MAX_COMPACT_ATTEMPTS: 3,
	/** Cooldown between compact retries during periodic checks (ms) */
	COMPACT_RETRY_COOLDOWN_MS: 60_000,
	/** Cumulative output bytes threshold before triggering proactive compact (~500KB) */
	PROACTIVE_COMPACT_THRESHOLD_BYTES: 512_000,
	/** Cooldown between proactive compact triggers per session (10 minutes) */
	PROACTIVE_COMPACT_COOLDOWN_MS: 600_000,
} as const;

/**
 * Compact commands per runtime type.
 *
 * Each AI runtime has its own slash command to trigger context compression:
 * - Claude Code: `/compact`
 * - Gemini CLI: `/compress`
 * - Codex CLI: `/compact`
 */
export const RUNTIME_COMPACT_COMMANDS: Record<RuntimeType, string> = {
	'claude-code': '/compact',
	'gemini-cli': '/compress',
	'codex-cli': '/compact',
} as const;

/**
 * Constants for sub-agent message queue.
 * Used by SubAgentMessageQueue to buffer messages for agents that haven't
 * completed initialization (status !== 'active') yet.
 */
export const SUB_AGENT_QUEUE_CONSTANTS = {
	/** Maximum messages per agent before dropping oldest */
	MAX_QUEUE_SIZE: 50,
	/** Delay between flushed messages on registration (ms) */
	FLUSH_INTER_MESSAGE_DELAY: 2000,
} as const;

/**
 * Constants for proactive system resource monitoring and alerting.
 * Used by SystemResourceAlertService to poll metrics, check thresholds,
 * and send user-facing notifications before resources are exhausted.
 */
export const SYSTEM_RESOURCE_ALERT_CONSTANTS = {
	/** Polling interval for resource checks (ms) */
	POLL_INTERVAL: 60000, // 1 minute
	/** Cooldown between repeated alerts for the same metric (ms) */
	ALERT_COOLDOWN: 600000, // 10 minutes
	/** Thresholds for triggering alerts */
	THRESHOLDS: {
		DISK_WARNING: 85,     // 85% used
		DISK_CRITICAL: 95,    // 95% used
		MEMORY_WARNING: 85,   // 85% used
		MEMORY_CRITICAL: 95,  // 95% used
		CPU_WARNING: 80,      // load avg 80% of cores
		CPU_CRITICAL: 95,     // load avg 95% of cores
	},
} as const;

/**
 * Shared Slack API limits used by both image and file upload services.
 */
export const SLACK_API_LIMITS = {
	/** Maximum allowed file size (20 MB — Slack limit) */
	MAX_FILE_SIZE: 20 * 1024 * 1024,
	/** Maximum number of retry attempts for Slack API 429 responses */
	UPLOAD_MAX_RETRIES: 3,
	/** Default backoff delay (ms) when no Retry-After header is present */
	UPLOAD_DEFAULT_BACKOFF_MS: 5000,
} as const;

/**
 * Constants for Slack image download and temporary storage.
 * Used by SlackImageService to validate, download, and manage
 * images sent by users in Slack messages.
 */
export const SLACK_IMAGE_CONSTANTS = {
	/** Temp directory for downloaded images (relative to ~/.crewly/) */
	TEMP_DIR: 'tmp/slack-images',
	/** Maximum allowed file size for image downloads (20 MB) */
	MAX_FILE_SIZE: SLACK_API_LIMITS.MAX_FILE_SIZE,
	/** Supported image MIME types for download (SVG excluded — not accepted by LLM vision APIs) */
	SUPPORTED_MIMES: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const,
	/**
	 * Expected Content-Type prefixes for valid image responses from Slack.
	 * Used to detect when Slack returns an HTML error page instead of an image.
	 */
	VALID_RESPONSE_CONTENT_TYPES: ['image/'] as const,
	/**
	 * Magic byte signatures for supported image formats.
	 * Used to verify that a downloaded file is actually an image
	 * (Slack can return 200 OK with an HTML body when auth fails).
	 */
	IMAGE_MAGIC_BYTES: {
		PNG: [0x89, 0x50, 0x4E, 0x47],      // \x89PNG
		JPEG: [0xFF, 0xD8, 0xFF],             // JPEG SOI marker
		GIF87: [0x47, 0x49, 0x46, 0x38, 0x37], // GIF87a
		GIF89: [0x47, 0x49, 0x46, 0x38, 0x39], // GIF89a
		WEBP_RIFF: [0x52, 0x49, 0x46, 0x46],  // RIFF (WebP container)
	} as const,
	/** Interval for cleaning up expired temp files (1 hour) */
	CLEANUP_INTERVAL: 60 * 60 * 1000,
	/** Maximum age for temp files before cleanup (24 hours) */
	FILE_TTL: 24 * 60 * 60 * 1000,
	/** Maximum concurrent image downloads per message */
	MAX_CONCURRENT_DOWNLOADS: 3,
	/** Warning threshold for temp directory total size (500 MB) */
	MAX_TEMP_DIR_SIZE: 500 * 1024 * 1024,
	/** Maximum redirect hops to follow during file download */
	MAX_DOWNLOAD_REDIRECTS: 5,
	/** Maximum number of retry attempts for Slack API 429 responses */
	UPLOAD_MAX_RETRIES: SLACK_API_LIMITS.UPLOAD_MAX_RETRIES,
	/** Default backoff delay (ms) when no Retry-After header is present */
	UPLOAD_DEFAULT_BACKOFF_MS: SLACK_API_LIMITS.UPLOAD_DEFAULT_BACKOFF_MS,
} as const;

/**
 * Constants for generic file uploads to Slack channels.
 * Used by the upload-file endpoint and send-pdf-to-slack skill
 * to validate and upload arbitrary file types (PDF, images, docs, etc.).
 */
export const SLACK_FILE_UPLOAD_CONSTANTS = {
	/** Temp directory for generated PDFs (relative to ~/.crewly/) */
	TEMP_DIR: 'tmp/slack-pdfs',
	/** Maximum allowed file size for uploads (20 MB — Slack limit) */
	MAX_FILE_SIZE: SLACK_API_LIMITS.MAX_FILE_SIZE,
	/** File extensions accepted for upload */
	SUPPORTED_EXTENSIONS: [
		'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
		'.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx',
		'.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.zip',
	] as const,
	/** Maximum number of retry attempts for Slack API 429 responses */
	UPLOAD_MAX_RETRIES: SLACK_API_LIMITS.UPLOAD_MAX_RETRIES,
	/** Default backoff delay (ms) when no Retry-After header is present */
	UPLOAD_DEFAULT_BACKOFF_MS: SLACK_API_LIMITS.UPLOAD_DEFAULT_BACKOFF_MS,
} as const;

/**
 * Constants for downloading non-image file attachments from Slack messages.
 * Used by SlackOrchestratorBridge to download generic files (PDFs, docs, etc.)
 * sent by users so agents can access them via file-reading tools.
 */
export const SLACK_FILE_DOWNLOAD_CONSTANTS = {
	/** Temp directory for downloaded files (relative to ~/.crewly/) */
	TEMP_DIR: 'tmp/slack-files',
	/** Maximum allowed file size for downloads (20 MB — Slack limit) */
	MAX_FILE_SIZE: SLACK_API_LIMITS.MAX_FILE_SIZE,
	/** Maximum concurrent file downloads per message */
	MAX_CONCURRENT_DOWNLOADS: 3,
	/** Maximum redirect hops to follow during file download */
	MAX_DOWNLOAD_REDIRECTS: 5,
	/** Timeout for individual file download requests (ms) */
	DOWNLOAD_TIMEOUT_MS: 60_000,
	/** Maximum extracted text length included inline in messages (characters) */
	MAX_EXTRACTED_TEXT_LENGTH: 8000,
	/** MIME types eligible for text extraction */
	EXTRACTABLE_MIMES: ['application/pdf'] as readonly string[],
} as const;

/**
 * Constants for Gemini embedding-based knowledge search.
 * Used by KnowledgeSearchService when GEMINI_API_KEY is configured.
 */
export const EMBEDDING_CONSTANTS = {
	/** Gemini embedding model identifier */
	GEMINI_MODEL: 'text-embedding-004',
	/** Base endpoint for Gemini generative language API */
	GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',
	/** Timeout for embedding API calls (ms) */
	TIMEOUT_MS: 10000,
	/** Maximum documents to embed in a single batch */
	MAX_BATCH_SIZE: 20,
	/** Expected embedding vector dimensions */
	EMBEDDING_DIMENSIONS: 768,
} as const;

/**
 * Message source identifiers for the queue processor.
 * Determines delivery strategy (timeouts, retry behavior).
 */
export const MESSAGE_SOURCES = {
	SLACK: 'slack',
	WHATSAPP: 'whatsapp',
	WEB_CHAT: 'web_chat',
	SYSTEM_EVENT: 'system_event',
} as const;

// Re-export marketplace constants from shared config
export const MARKETPLACE_CONSTANTS = CONFIG_MARKETPLACE_CONSTANTS;

/** Typed message source value */
export type MessageSource = (typeof MESSAGE_SOURCES)[keyof typeof MESSAGE_SOURCES];

/**
 * Constants for WhatsApp integration via Baileys.
 * Used by WhatsAppService, WhatsAppOrchestratorBridge, and WhatsApp controller
 * for connection management and message handling.
 */
export const WHATSAPP_CONSTANTS = {
	/** Directory name for auth state persistence (under ~/.crewly/) */
	AUTH_DIR: 'whatsapp-auth',
	/** Maximum text message length (WhatsApp limit) */
	MAX_MESSAGE_LENGTH: 4000,
	/** Maximum file size for sending documents (5 MB) */
	MAX_FILE_SIZE: 5 * 1024 * 1024,
	/** Delay between reconnection attempts (ms) */
	RECONNECT_INTERVAL_MS: 5000,
	/** Timeout for QR code scanning before expiry (ms) */
	QR_TIMEOUT_MS: 60000,
	/** Maximum response length from orchestrator before truncation */
	MAX_RESPONSE_LENGTH: 3000,
	/** Buffer added to message queue timeout for response timeout (ms) */
	RESPONSE_TIMEOUT_BUFFER_MS: 5000,
	/** Regex pattern for WhatsApp JID suffix */
	JID_SUFFIX_PATTERN: /@s\.whatsapp\.net$/,
	/** Regex pattern for phone number + prefix */
	PHONE_PREFIX_PATTERN: /^\+/,
	/** Fallback timeout when MESSAGE_QUEUE_CONSTANTS is unavailable (ms) */
	DEFAULT_FALLBACK_TIMEOUT_MS: 120000,
} as const;

/** Google OAuth endpoint URLs and default scopes. */
export const GOOGLE_OAUTH_CONSTANTS = {
	AUTH_BASE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
	TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
	USERINFO_ENDPOINT: 'https://www.googleapis.com/oauth2/v2/userinfo',
	DEFAULT_SCOPES: [
		'openid',
		'email',
		'https://www.googleapis.com/auth/gmail.readonly',
		'https://www.googleapis.com/auth/gmail.send',
	],
} as const;

// Type helpers
export type AgentStatus =
	(typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES];
export type WorkingStatus =
	(typeof CREWLY_CONSTANTS.WORKING_STATUSES)[keyof typeof CREWLY_CONSTANTS.WORKING_STATUSES];
export type RuntimeType = (typeof RUNTIME_TYPES)[keyof typeof RUNTIME_TYPES];
export type AgentId = string; // Agent identifier type for heartbeat service
