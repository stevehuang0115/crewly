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
  TEMPLATE_MARKETPLACE_CONSTANTS as CONFIG_TEMPLATE_MARKETPLACE_CONSTANTS,
  ADDON_CONSTANTS as CONFIG_ADDON_CONSTANTS,
  AUDITOR_CONSTANTS as CONFIG_AUDITOR_CONSTANTS,
  PROCESS_EXIT_CODES as CONFIG_PROCESS_EXIT_CODES,
  WEB_CONSTANTS as CONFIG_WEB_CONSTANTS,
} from '../../config/constants.js';

// Re-export the cross-domain constants for backend use
export const PROCESS_EXIT_CODES = CONFIG_PROCESS_EXIT_CODES;
export const AGENT_IDENTITY_CONSTANTS = CONFIG_AGENT_IDENTITY_CONSTANTS;
export const TIMING_CONSTANTS = CONFIG_TIMING_CONSTANTS;
export const MEMORY_CONSTANTS = CONFIG_MEMORY_CONSTANTS;
export const CONTINUATION_CONSTANTS = CONFIG_CONTINUATION_CONSTANTS;
export const ORCHESTRATOR_RESTART_CONSTANTS = CONFIG_ORCHESTRATOR_RESTART_CONSTANTS;
export const AGENT_SUSPEND_CONSTANTS = CONFIG_AGENT_SUSPEND_CONSTANTS;
export const VERSION_CHECK_CONSTANTS = CONFIG_VERSION_CHECK_CONSTANTS;
export const AGENT_HEARTBEAT_MONITOR_CONSTANTS = CONFIG_AGENT_HEARTBEAT_MONITOR_CONSTANTS;
export const ORCHESTRATOR_HEARTBEAT_CONSTANTS = CONFIG_ORCHESTRATOR_HEARTBEAT_CONSTANTS;
export const WEB_CONSTANTS = CONFIG_WEB_CONSTANTS;
export const ADDON_CONSTANTS = CONFIG_ADDON_CONSTANTS;
export const AUDITOR_CONSTANTS = CONFIG_AUDITOR_CONSTANTS;

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
	/** Project path for auto-injecting into memory skill calls (#187) */
	CREWLY_PROJECT_PATH: 'CREWLY_PROJECT_PATH',
	/** Enable Claude Code telemetry for token tracking */
	CLAUDE_CODE_ENABLE_TELEMETRY: 'CLAUDE_CODE_ENABLE_TELEMETRY',
	/** #222: Absolute path to the Crewly installation directory (where config/skills/ lives) */
	CREWLY_INSTALL_DIR: 'CREWLY_INSTALL_DIR',
} as const;

// Agent-specific timeout values (in milliseconds)
export const AGENT_TIMEOUTS = {
	ORCHESTRATOR_INITIALIZATION: 120000, // 2 minutes for orchestrator
	REGULAR_AGENT_INITIALIZATION: 75000, // 75 seconds for regular agents
	/** #227: Extended timeout for Claude Code — PI protection evaluation takes 2-3 min */
	CLAUDE_CODE_INITIALIZATION: 300000, // 5 minutes for Claude Code agents
} as const;

// Agent runtime types
export const RUNTIME_TYPES = {
	CLAUDE_CODE: 'claude-code',
	GEMINI_CLI: 'gemini-cli',
	CODEX_CLI: 'codex-cli',
	CREWLY_AGENT: 'crewly-agent',
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
	/** Max idle time (ms) to consider an agent busy. If PTY output occurred within this window, skip delivery. */
	AGENT_BUSY_IDLE_THRESHOLD_MS: 5000,
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

/** Constants for the TerminalGateway orchestrator output buffer management. */
export const TERMINAL_GATEWAY_CONSTANTS = {
	/** Maximum buffer size for orchestrator output (bytes) */
	MAX_BUFFER_SIZE: 100 * 1024,
	/** Trim threshold for partial line buffer (characters) */
	BUFFER_TRIM_THRESHOLD: 1000,
} as const;

// Chat routing constants (message markers and patterns for orchestrator communication)
export const CHAT_ROUTING_CONSTANTS = {
	/** Message format prefix for chat routing */
	MESSAGE_PREFIX: 'CHAT',
	/** Message format prefix for Google Chat routing (distinguishes from Slack) */
	GOOGLE_CHAT_PREFIX: 'GCHAT',
} as const;

/**
 * Unified notification marker constants.
 * Used by the orchestrator to send messages to chat, Slack, or both
 * via a single `[NOTIFY]...[/NOTIFY]` block with a JSON payload.
 */
export const NOTIFY_CONSTANTS = {
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
	/** Shorter timeout for system events to reduce notification delay (ms).
	 *  Reduced from 60s to 15s (#124) — agent completion notifications were
	 *  taking 3-10 minutes because system events waited too long for prompt. */
	SYSTEM_EVENT_TIMEOUT: 15000,
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
	/** Number of PTY lines to scan when verifying force-delivered message acknowledgment */
	PENDING_ACK_SCAN_LINES: 300,
	/** Maximum re-delivery attempts for force-delivered messages that were not acknowledged */
	PENDING_ACK_MAX_RETRIES: 3,
	/** Time in milliseconds before a pending-ack entry is considered stale and discarded */
	PENDING_ACK_TTL_MS: 600_000,
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
	 * Combined pattern for detecting spinner/working processing activity.
	 * Simple single-char alternation — O(n), no backtracking risk.
	 * Kept as RegExp for session-command-helper.ts waitForPattern() compatibility.
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
	DEFAULT_MESSAGE_TIMEOUT: 180000,
	/** Maximum number of completed/failed messages retained in history */
	MAX_HISTORY_SIZE: 50,
	/** Delay between processing consecutive messages (ms) */
	INTER_MESSAGE_DELAY: 500,
	/** Maximum number of requeue retries before permanently failing a message */
	MAX_REQUEUE_RETRIES: 5,
	/** Maximum number of system events to batch into a single delivery */
	MAX_SYSTEM_EVENT_BATCH: 100,
	/** Max combined chars when coalescing pending system events in-queue */
	MAX_SYSTEM_EVENT_COALESCE_CHARS: 12000,
	/** Maximum pending system events in queue before oldest are dropped (#218).
	 *  Prevents agent status event floods from burying user messages. */
	MAX_PENDING_SYSTEM_EVENTS: 10,
	/** Queue persistence file name (stored under crewly home) */
	PERSISTENCE_FILE: 'message-queue.json',
	/** Queue persistence directory name */
	PERSISTENCE_DIR: 'queue',
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
 * Activity monitor constants for agent idle/busy detection.
 * Used by ActivityMonitorService for terminal output polling.
 */
export const ACTIVITY_MONITOR_CONSTANTS = {
	/** Polling interval for checking terminal output changes (ms).
	 *  Reduced from 120s to 30s (#124) to detect agent idle state faster,
	 *  cutting notification delay from 2min to 30s worst-case. */
	POLLING_INTERVAL_MS: 30000,
	/** Maximum time an agent can stay in_progress before auto-reset to idle (ms).
	 *  Prevents workingStatus from getting stuck due to continuous terminal output
	 *  (spinners, TUI re-renders). Default: 15 minutes. */
	MAX_IN_PROGRESS_MS: 900_000,
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
	/** Threshold for cleaning stale entries from recentPublishMap */
	DEDUP_MAP_CLEANUP_THRESHOLD: 100,
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
 * Constants for Google Chat thread file storage.
 * Used by GoogleChatThreadStoreService to persist thread conversations.
 */
export const GCHAT_THREAD_CONSTANTS = {
	/** Directory name under crewly home for thread files */
	STORAGE_DIR: 'gchat-threads',
	/** File extension for thread conversation files */
	FILE_EXTENSION: '.md',
	/** Max recent messages to include as thread context in deliveries (#195) */
	MAX_CONTEXT_MESSAGES: 10,
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
 * Constants for Slack message deduplication.
 * Prevents identical messages from being sent to the same channel+thread
 * within a short time window.
 */
export const SLACK_DEDUP_CONSTANTS = {
	/** Time window in ms within which duplicate messages are suppressed (30 seconds) */
	DEDUP_WINDOW_MS: 30_000,
	/** Maximum number of message fingerprints to track in memory */
	MAX_TRACKED_MESSAGES: 100,
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

/**
 * Named pattern for Gemini CLI stuck-connectivity detection (#128).
 * Matches "Trying to reach <model> (Attempt N/M)" output, indicating
 * the CLI is in a retry loop and won't recover without intervention.
 * Used in both GEMINI_FAILURE_PATTERNS and the sendMessageWithRetry guard.
 */
export const GEMINI_STUCK_CONNECTIVITY_PATTERN = /Trying to reach .+\(Attempt \d+\/\d+\)/;

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
export const GEMINI_FAILURE_PATTERNS: RegExp[] = [
	/Request cancelled/,
	/RESOURCE_EXHAUSTED/,
	/UNAVAILABLE/,
	/Connection error/,
	/INTERNAL(?:\s*:|:)/,
	/DEADLINE_EXCEEDED/,
	/PERMISSION_DENIED/,
	/UNAUTHENTICATED/,
	/API connection failed/i,
	/Authentication expired/i,
	GEMINI_STUCK_CONNECTIVITY_PATTERN,
];

/**
 * Gemini CLI deliberation loop detection pattern (#188).
 * Matches repeated "Wait, I'll..." / "Actually, I'll..." planning text
 * that indicates the agent is stuck in an infinite deliberation cycle
 * without executing tool calls. A single occurrence is not a loop —
 * the RuntimeExitMonitorService counts occurrences in the output buffer
 * and only triggers recovery when the threshold is exceeded.
 */
export const GEMINI_DELIBERATION_PATTERN = /(?:Wait,\s+I['''\u2019]ll|Actually,\s+I['''\u2019]ll)/i;

/** Number of deliberation pattern matches in the terminal buffer before
 *  declaring the agent stuck in a deliberation loop (#188). */
export const GEMINI_DELIBERATION_THRESHOLD = 5;

/**
 * Gemini update/upgrade markers that should trigger forced recovery.
 * These indicate the CLI interrupted the current request for self-update.
 */
export const GEMINI_FORCE_RESTART_PATTERNS: RegExp[] = [
	/Gemini CLI update available!/i,
	/Attempting to automatically update now/i,
	/Gemini CLI is restarting to apply the trust changes/i,
	// Auto-update failure leaves the CLI in a broken state (#128).
	// The session needs a full restart to recover from npm EACCES errors.
	/Automatic update failed/i,
];

/**
 * Claude Code fatal error patterns that indicate the CLI is stuck in an
 * unrecoverable state. Unlike transient API errors, these require an
 * immediate restart — no retry will resolve them.
 *
 * Example: When conversation history gets compacted and thinking blocks
 * are modified, the Claude API permanently rejects all subsequent requests
 * with a 400 error. The only recovery is to kill and restart the session.
 *
 * Used by RuntimeExitMonitorService to detect stuck Claude Code sessions.
 */
export const CLAUDE_FATAL_PATTERNS: RegExp[] = [
	// Thinking block corruption: once modified, every subsequent API call fails with 400
	/thinking.*blocks.*cannot be modified/i,
	// Redacted thinking block corruption (same root cause)
	/redacted_thinking.*blocks.*cannot be modified/i,
];

/**
 * Gemini CLI ready-state patterns used for recovery detection.
 * When any of these strings appear in terminal output, the CLI is
 * considered operational and ready to accept input.
 * Shared by RuntimeExitMonitorService and GeminiRuntimeService.
 */
export const GEMINI_READY_PATTERNS: readonly string[] = [
	'Type your message',
	'shell mode',
	'gemini>',
	'Ready for input',
	'Model loaded',
	'context left)',
] as const;

/**
 * Constants for detecting Gemini CLI error-overlay state (#130).
 * Used to identify and dismiss MCP connection error overlays
 * before message delivery.
 */
export const GEMINI_ERROR_STATE_CONSTANTS = {
	/** Unicode marker for error state in Gemini CLI status bar */
	ERROR_MARKER: '\u2716',
	/** Regex matching error count in the status area (e.g., "3 errors") */
	ERROR_COUNT_PATTERN: /\d+ errors?\b/i,
	/** Number of terminal lines from the bottom to consider as "status area" */
	STATUS_AREA_LINES: 5,
} as const;

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
	'crewly-agent': '',
} as const;

/**
 * Constants for OAuth auto-relogin monitoring.
 * Used by OAuthReloginMonitorService to detect OAuth token expiry errors
 * in PTY session output and automatically send /login to re-authenticate.
 */
export const OAUTH_RELOGIN_CONSTANTS = {
	/** Maximum rolling buffer size for PTY output (bytes) */
	MAX_BUFFER_SIZE: 4096,
	/** Cooldown between /login attempts per session (ms) — 2 minutes */
	RELOGIN_COOLDOWN_MS: 120_000,
	/** Grace period after session start before monitoring begins (ms) */
	STARTUP_GRACE_PERIOD_MS: 30_000,
	/** Delay after detecting error before sending /login (ms) — debounce */
	DETECTION_DEBOUNCE_MS: 2_000,
	/** Maximum /login attempts per cooldown window before giving up */
	MAX_ATTEMPTS_PER_WINDOW: 3,
	/** Cooldown window for tracking max attempts (ms) — 10 minutes */
	ATTEMPT_WINDOW_MS: 600_000,
	/** Delay after sending Escape before writing /login command (ms) */
	PRE_COMMAND_DELAY_MS: 200,
	/** Timeout for waiting for OAuth URL to appear after /login (ms) — 30 seconds */
	URL_CAPTURE_TIMEOUT_MS: 30_000,
	/** Max buffer size during URL capture mode (bytes) — larger to capture full URL */
	URL_CAPTURE_BUFFER_SIZE: 8192,
} as const;

/**
 * String patterns that indicate authentication failure in PTY output.
 * Covers OAuth token expiry AND invalid/revoked credentials.
 * Uses plain string matching (indexOf) instead of regex to prevent ReDoS.
 * All patterns must be present (AND logic) within the rolling buffer.
 */
export const OAUTH_ERROR_PATTERN_SETS: string[][] = [
	['authentication_error', 'OAuth token has expired'],
	['authentication_error', 'oauth token expired'],
	['401', 'OAuth token has expired'],
	['invalid_api_key', 'OAuth token has expired'],
	['authentication_error', 'Invalid authentication credentials'],
	['401', 'Invalid authentication credentials'],
];

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
/**
 * Slack Socket Mode reconnection constants.
 * Controls automatic reconnection when network drops cause the WebSocket
 * to die and Bolt's built-in reconnect fails to recover.
 */
export const SLACK_RECONNECT_CONSTANTS = {
	/** Initial delay before first reconnection attempt (ms) */
	INITIAL_DELAY_MS: 2_000,
	/** Maximum delay between reconnection attempts (ms) */
	MAX_DELAY_MS: 60_000,
	/** Backoff multiplier applied after each failed attempt */
	BACKOFF_MULTIPLIER: 2,
	/** Maximum number of consecutive reconnection attempts before giving up (0 = unlimited) */
	MAX_ATTEMPTS: 0,
	/** Grace period after a disconnect before starting reconnection (ms).
	 *  Gives Bolt's built-in reconnect a chance to recover first. */
	GRACE_PERIOD_MS: 10_000,
	/** Interval for periodic connection health checks (ms) */
	HEALTH_CHECK_INTERVAL_MS: 30_000,
	/** Timeout for the auth.test API ping during health checks (ms) */
	PING_TIMEOUT_MS: 10_000,
	/** Number of consecutive ping failures before forcing a reconnect */
	PING_FAILURES_BEFORE_RECONNECT: 2,
} as const;

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
	GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1/models',
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
	GOOGLE_CHAT: 'google_chat',
	TELEGRAM: 'telegram',
} as const;

/**
 * Constants for Google Chat Pub/Sub integration.
 * Used by GoogleChatMessengerAdapter for pulling messages from a Pub/Sub subscription
 * and replying via the Chat API.
 */
export const GOOGLE_CHAT_PUBSUB_CONSTANTS = {
	/** Interval between Pub/Sub pull requests (ms) */
	PULL_INTERVAL_MS: 5_000,
	/** Maximum messages to pull per request */
	MAX_MESSAGES_PER_PULL: 10,
	/** OAuth2 scope for Pub/Sub API access */
	PUBSUB_SCOPE: 'https://www.googleapis.com/auth/pubsub',
	/** OAuth2 scope for Google Chat API access */
	CHAT_SCOPE: 'https://www.googleapis.com/auth/chat.bot',
	/** Pub/Sub REST API base URL */
	PUBSUB_API_BASE: 'https://pubsub.googleapis.com/v1',
	/** Google Chat REST API base URL */
	CHAT_API_BASE: 'https://chat.googleapis.com/v1',
	/** Timeout for Pub/Sub API calls (ms) */
	FETCH_TIMEOUT_MS: 15_000,
	/** Max consecutive pull failures before pausing */
	MAX_CONSECUTIVE_FAILURES: 5,
	/** Maximum message length for the Google Chat API (characters) */
	MAX_MESSAGE_LENGTH: 4096,
} as const;

/**
 * Constants for Telegram Bot API integration.
 * Used by TelegramService for polling incoming messages and sending replies.
 */
export const TELEGRAM_CONSTANTS = {
	/** Interval between getUpdates polling requests (ms) */
	POLL_INTERVAL_MS: 3_000,
	/** Timeout for long-polling requests (seconds, sent to Telegram API) */
	LONG_POLL_TIMEOUT_S: 30,
	/** Timeout for fetch requests (ms) */
	FETCH_TIMEOUT_MS: 35_000,
	/** Telegram Bot API base URL */
	API_BASE: 'https://api.telegram.org/bot',
	/** Maximum message length for Telegram API (characters) */
	MAX_MESSAGE_LENGTH: 4096,
	/** Max consecutive poll failures before pausing */
	MAX_CONSECUTIVE_FAILURES: 5,
	/** Credentials file name */
	CREDENTIALS_FILE: 'telegram-credentials.json',
	/** Chat routing prefix for incoming Telegram messages */
	CHAT_PREFIX: 'TELEGRAM',
} as const;

// Re-export marketplace constants from shared config
export const MARKETPLACE_CONSTANTS = CONFIG_MARKETPLACE_CONSTANTS;
export const TEMPLATE_MARKETPLACE_CONSTANTS = CONFIG_TEMPLATE_MARKETPLACE_CONSTANTS;

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
	/** Google Workspace scopes for agent-driven operations (Phase 1). */
	WORKSPACE_SCOPES: [
		'https://www.googleapis.com/auth/gmail.readonly',
		'https://www.googleapis.com/auth/gmail.send',
		'https://www.googleapis.com/auth/gmail.compose',
		'https://www.googleapis.com/auth/drive.file',
		'https://www.googleapis.com/auth/calendar.events',
		'https://www.googleapis.com/auth/documents',
	],
} as const;

/**
 * Constants for CrewlyAI Cloud integration.
 * Used by CloudClientService and CloudAuthMiddleware to connect
 * the open-source Crewly instance to CrewlyAI Cloud for premium features.
 */
export const CLOUD_CONSTANTS = {
	/** Default CrewlyAI Cloud API base URL (env: CREWLY_CLOUD_URL) */
	get DEFAULT_CLOUD_URL(): string {
		return process.env['CREWLY_CLOUD_URL'] || 'https://api.crewlyai.com';
	},
	/** API version prefix for all cloud endpoints */
	API_VERSION: '/v1',
	/** Cloud API endpoints */
	ENDPOINTS: {
		/** Authentication and token verification (matches crewly-auth /api/cloud/validate) */
		AUTH_TOKEN: '/api/cloud/validate',
		/** Sync local config with cloud subscription status */
		SYNC: '/v1/cloud/sync',
		/** List premium templates */
		TEMPLATES: '/v1/templates/premium',
		/** Get template detail by ID */
		TEMPLATE_DETAIL: '/v1/templates/premium/:id',
	},
	/** HTTP request timeouts (ms) */
	TIMEOUTS: {
		/** Timeout for connect/auth requests */
		CONNECT: 10000,
		/** Timeout for fetching template lists */
		FETCH_TEMPLATES: 15000,
		/** Timeout for fetching template detail */
		FETCH_TEMPLATE_DETAIL: 10000,
		/** Timeout for status/sync requests */
		STATUS: 5000,
	},
	/** Subscription tiers */
	TIERS: {
		FREE: 'free',
		PRO: 'pro',
		ENTERPRISE: 'enterprise',
	},
	/** Connection statuses */
	CONNECTION_STATUS: {
		DISCONNECTED: 'disconnected',
		CONNECTED: 'connected',
		ERROR: 'error',
		/** Token expired or revoked — cloud API returned 401/403 */
		TOKEN_EXPIRED: 'token_expired',
	},
	/** Relay-specific endpoints (Cloud Message Queue) */
	RELAY_ENDPOINTS: {
		/** Register a local instance as a relay node (legacy) */
		REGISTER: '/v1/relay/register',
		/** Get relay status (legacy) */
		STATUS: '/v1/relay/status',
		/** Queue: register and pair with peer */
		QUEUE_REGISTER: '/api/v1/relay/queue/register',
		/** Queue: send encrypted message to peer */
		QUEUE_SEND: '/api/v1/relay/queue/send',
		/** Queue: poll for incoming messages */
		QUEUE_POLL: '/api/v1/relay/queue/poll',
		/** Queue: acknowledge (delete) processed messages */
		QUEUE_ACK: '/api/v1/relay/queue/ack',
		/** Device discovery */
		DEVICES: '/api/v1/relay/devices',
		/** Cloud handshake: send device metadata + active teams on connect */
		HANDSHAKE: '/api/v1/relay/handshake',
	},
	/** Relay configuration (Cloud Message Queue — HTTP polling) */
	RELAY: {
		/** Default backend port (legacy, kept for local dev) */
		DEFAULT_PORT: 8787,
		/** Polling interval for queue messages (ms) */
		POLL_INTERVAL_MS: 5_000,
		/** Delay before attempting reconnection after register failure (ms) */
		RECONNECT_BASE_DELAY_MS: 1_000,
		/** Maximum reconnection delay with exponential backoff (ms) */
		RECONNECT_MAX_DELAY_MS: 30_000,
		/** Maximum number of reconnection attempts before giving up */
		MAX_RECONNECT_ATTEMPTS: 10,
		/** HTTP request timeout for queue operations (ms) */
		REQUEST_TIMEOUT_MS: 10_000,
		/** Maximum message payload size (1 MB) */
		MAX_PAYLOAD_BYTES: 1_048_576,
		/** E2EE key derivation iterations (PBKDF2) */
		KEY_DERIVATION_ITERATIONS: 100_000,
		/** AES-GCM IV length (bytes) */
		IV_LENGTH: 12,
		/** AES-GCM auth tag length (bytes) */
		AUTH_TAG_LENGTH: 16,
		/** Encryption algorithm */
		CIPHER_ALGORITHM: 'aes-256-gcm',
		/** Key length (bytes) */
		KEY_LENGTH: 32,
		/** Default WebSocket relay URL for Cloud Relay auto-connect */
		DEFAULT_WS_URL: 'wss://api.crewlyai.com/relay',
	},
} as const;

/**
 * Constants for the Cloud Sync system.
 * Replaces the WebSocket Relay pairing model with heartbeat-based device
 * discovery and HTTP-polled messaging.
 *
 * @see docs/cloud-sync-design.md
 */
export const CLOUD_SYNC_CONSTANTS = {
	/** Interval between heartbeat uploads (ms) */
	HEARTBEAT_INTERVAL_MS: 30_000,
	/** Interval between message poll requests (ms) */
	MESSAGE_POLL_INTERVAL_MS: 5_000,
	/** Interval between device list poll requests (ms) */
	DEVICE_POLL_INTERVAL_MS: 30_000,
	/** Device considered offline after this threshold (ms) */
	OFFLINE_THRESHOLD_MS: 60_000,
	/** Messages older than this are considered stale (ms) */
	MESSAGE_TTL_MS: 300_000,
	/** Maximum messages per device queue */
	MAX_QUEUE_SIZE: 1_000,
	/** HTTP request timeout for sync API calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
	/** Maximum consecutive failures before entering error state */
	MAX_CONSECUTIVE_FAILURES: 10,
	/** Base delay for exponential backoff on failure (ms) */
	BACKOFF_BASE_MS: 1_000,
	/** Maximum backoff delay (ms) */
	BACKOFF_MAX_MS: 60_000,
	/** Cloud Sync API endpoints (relative to cloudUrl) */
	ENDPOINTS: {
		/** Device heartbeat — reuses the relay handshake endpoint to register/update device status */
		HEARTBEAT: '/api/v1/relay/handshake',
		/** List all devices for account */
		DEVICES: '/api/v1/relay/devices',
		/** Send messages to another device's queue */
		MESSAGES: '/api/v1/relay/queue/send',
		/** Poll for incoming messages */
		MESSAGES_POLL: '/api/v1/relay/queue/poll',
		/** Acknowledge processed messages */
		MESSAGES_ACK: '/api/v1/relay/queue/ack',
	},
} as const;

/** Subscription tier type */
export type CloudTier = (typeof CLOUD_CONSTANTS.TIERS)[keyof typeof CLOUD_CONSTANTS.TIERS];

/** Cloud connection status type */
export type CloudConnectionStatus =
	(typeof CLOUD_CONSTANTS.CONNECTION_STATUS)[keyof typeof CLOUD_CONSTANTS.CONNECTION_STATUS];

/**
 * Constants for CrewlyAI Cloud account authentication and licensing.
 * Used by AuthService and JwtAuthMiddleware for user registration,
 * login, JWT management, and plan-based feature gating.
 */
export const AUTH_CONSTANTS = {
	/** JWT configuration */
	JWT: {
		/** JWT secret (env: CREWLY_JWT_SECRET, falls back to dev default) */
		get DEFAULT_SECRET(): string {
			return process.env['CREWLY_JWT_SECRET'] || 'crewly-dev-jwt-secret-change-in-production';
		},
		/** Access token expiry in seconds (1 hour) */
		ACCESS_TOKEN_EXPIRY_S: 3600,
		/** Refresh token expiry in seconds (30 days) */
		REFRESH_TOKEN_EXPIRY_S: 2_592_000,
		/** JWT algorithm identifier */
		ALGORITHM: 'HS256',
		/** JWT issuer claim */
		ISSUER: 'crewly-cloud',
	},
	/** User plans */
	PLANS: {
		FREE: 'free',
		PRO: 'pro',
		ENTERPRISE: 'enterprise',
	},
	/** Storage paths relative to ~/.crewly/ */
	STORAGE: {
		/** Directory for cloud user data */
		CLOUD_DIR: 'cloud',
		/** Directory for user accounts */
		USERS_DIR: 'cloud/users',
		/** File storing user index (email → id mapping) */
		USER_INDEX_FILE: 'cloud/users/index.json',
	},
	/** Pro features list */
	PRO_FEATURES: [
		'template-marketplace',
		'cloud-relay',
		'premium-templates',
		'priority-support',
	],
} as const;

/** User plan type */
export type UserPlan = (typeof AUTH_CONSTANTS.PLANS)[keyof typeof AUTH_CONSTANTS.PLANS];

/** Device heartbeat constants for dual-machine connectivity */
export const DEVICE_CONSTANTS = {
	/** Time-to-live for device heartbeat (ms) */
	HEARTBEAT_TTL_MS: 60_000,
	/** Storage directory for device state (relative to ~/.crewly/) */
	DEVICES_DIR: 'cloud/devices',
	/** Maximum teams per heartbeat payload */
	MAX_TEAMS_PER_HEARTBEAT: 50,
} as const;

/**
 * Constants for Supabase-backed Cloud Auth.
 * Used by CloudAuthService for user registration, login,
 * session management, and license verification via Supabase.
 *
 * Supabase credentials are read from env vars (CREWLY_SUPABASE_URL,
 * CREWLY_SUPABASE_ANON_KEY) with dev-project defaults as fallback.
 */
export const CLOUD_AUTH_CONSTANTS = {
	/** Google OAuth configuration for Cloud Console login */
	GOOGLE: {
		/** Google OAuth Client ID (env: GOOGLE_CLIENT_ID) */
		get CLIENT_ID(): string {
			return process.env['GOOGLE_CLIENT_ID'] || '';
		},
	},
	/** MongoDB collections */
	COLLECTIONS: {
		USERS: 'users',
		SESSIONS: 'sessions',
	},
	/** License statuses */
	LICENSE_STATUS: {
		ACTIVE: 'active',
		EXPIRED: 'expired',
		CANCELLED: 'cancelled',
	},
} as const;

/**
 * Constants for the Auditor Scheduler Service.
 * Controls periodic, event-driven, and API audit triggers.
 *
 * The auditor operates in always-active mode: initialized at server start,
 * remains alive between audits, and only shuts down when the service stops.
 */
export const AUDITOR_SCHEDULER_CONSTANTS = {
	/** Periodic full-sweep audit interval (15 minutes) */
	AUDIT_INTERVAL_MS: 15 * 60 * 1000,
	/** Debounce window for event-driven triggers (30 seconds) */
	EVENT_DEBOUNCE_MS: 30_000,
	/** Maximum time a single audit run can take before timeout (10 minutes).
	 *  Note: timeout does NOT shutdown the runtime (always-active mode). */
	AUDIT_TIMEOUT_MS: 10 * 60 * 1000,
	/** Session name for the auditor agent */
	AUDITOR_SESSION_NAME: 'crewly-auditor',
	/** Event types that trigger an audit run */
	TRIGGER_EVENT_TYPES: ['agent:inactive', 'task:failed'] as readonly string[],
	/** Command message sent to the auditor agent to start an audit cycle */
	AUDIT_COMMAND: 'Run a full audit cycle: check team status, review agent logs for errors, verify task alignment with goals, and write findings to the audit report.',
	/** Slack auditor prefix regex pattern (used in SlackOrchestratorBridge) */
	SLACK_PREFIX_PATTERN: /^\/?auditor\s+(.*)/is,
	/** Maximum session creation retries before entering cooldown */
	MAX_SESSION_RETRIES: 3,
	/** Cooldown period after max retries exhausted (5 minutes) */
	SESSION_RETRY_COOLDOWN_MS: 5 * 60 * 1000,
	/** Initial backoff between session creation retries (10 seconds) */
	SESSION_RETRY_INITIAL_BACKOFF_MS: 10_000,
	/** Backoff multiplier for exponential retry */
	SESSION_RETRY_BACKOFF_MULTIPLIER: 2,
	/** Delay before re-triggering after auditor's own session goes inactive (30 seconds).
	 *  This bridges the gap between the auditor exiting and the next L1 periodic trigger
	 *  (up to 15 min away), ensuring the auditor recovers quickly after context exhaustion. */
	SESSION_RECOVERY_DELAY_MS: 30_000,
} as const;

/** Log rotation service constants for managing session log file sizes */
export const LOG_ROTATION_CONSTANTS = {
	/** Maximum size for active session logs before truncation (20MB) */
	MAX_LOG_SIZE_BYTES: 20 * 1024 * 1024,
	/** Maximum size for orphan logs (no active session) before truncation (5MB) */
	ORPHAN_LOG_MAX_SIZE_BYTES: 5 * 1024 * 1024,
	/** Days to retain archived log files before deletion */
	ARCHIVE_RETENTION_DAYS: 7,
	/** Interval between rotation checks in milliseconds (1 hour) */
	LOG_ROTATION_INTERVAL_MS: 60 * 60 * 1000,
	/** Whether to archive old log content before truncation */
	LOG_ROTATION_ARCHIVE_ENABLED: true,
	/** Directory name for session logs under ~/.crewly/logs/ */
	SESSIONS_LOG_DIR: 'sessions',
	/** Directory name for archived logs under ~/.crewly/logs/ */
	ARCHIVE_DIR: 'archive',
	/** Base log directory under ~/.crewly/ */
	LOGS_DIR: 'logs',
} as const;

/** OpenTelemetry tracing configuration constants */
export const TRACING_CONSTANTS = {
	/** Default OTLP exporter endpoint */
	DEFAULT_EXPORTER_ENDPOINT: 'http://localhost:4318/v1/traces',
	/** Default service name reported in traces */
	DEFAULT_SERVICE_NAME: 'crewly-backend',
	/** Environment variable names */
	ENV_VARS: {
		ENABLED: 'OTEL_ENABLED',
		ENDPOINT: 'OTEL_EXPORTER_ENDPOINT',
		SERVICE_NAME: 'OTEL_SERVICE_NAME',
	},
	/** Span names for key operations */
	SPANS: {
		HTTP_REQUEST: 'http.request',
		AGENT_CREATE_SESSION: 'agent.createSession',
		AGENT_SEND_MESSAGE: 'agent.sendMessage',
		AGENT_REGISTER: 'agent.register',
		TASK_CREATE: 'task.create',
		TASK_UPDATE: 'task.update',
		TASK_ASSIGN: 'task.assign',
		AUDIT_TRIGGER: 'audit.trigger',
		SCHEDULER_RUN: 'scheduler.run',
		MEMORY_RECALL: 'memory.recall',
		MEMORY_STORE: 'memory.store',
		TASK_COMPLETE: 'task.complete',
		AGENT_RUN: 'agent.run',
	},
} as const;

/** License status type */
export type CloudLicenseStatus = (typeof CLOUD_AUTH_CONSTANTS.LICENSE_STATUS)[keyof typeof CLOUD_AUTH_CONSTANTS.LICENSE_STATUS];

// Type helpers
export type AgentStatus =
	(typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES];
export type WorkingStatus =
	(typeof CREWLY_CONSTANTS.WORKING_STATUSES)[keyof typeof CREWLY_CONSTANTS.WORKING_STATUSES];
export type RuntimeType = (typeof RUNTIME_TYPES)[keyof typeof RUNTIME_TYPES];
export type AgentId = string; // Agent identifier type for heartbeat service
