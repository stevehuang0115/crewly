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
  SAFE_RESTART_CONSTANTS as CONFIG_SAFE_RESTART_CONSTANTS,
  WEB_CONSTANTS as CONFIG_WEB_CONSTANTS,
  API_SECURITY_CONSTANTS as CONFIG_API_SECURITY_CONSTANTS,
} from '../../config/constants.js';

// Re-export the cross-domain constants for backend use
export const PROCESS_EXIT_CODES = CONFIG_PROCESS_EXIT_CODES;

/**
 * Safe restart: drain in-flight agent turns before a shutdown kills the PTYs,
 * and resume the ones that were cut off after the next boot.
 *
 * The shared budget (drain timeout, env override, supervisor margin) lives in
 * `config/constants.ts` so the CLI and the systemd unit read the same numbers;
 * the rest is backend-only.
 */
export const SAFE_RESTART = {
	...CONFIG_SAFE_RESTART_CONSTANTS,
	/** How often the drain re-checks whether any agent is still mid-turn (ms) */
	DRAIN_POLL_INTERVAL_MS: 2_000,
	/** How often the drain repeats its "still waiting on …" log line (ms) */
	DRAIN_LOG_INTERVAL_MS: 15_000,
	/**
	 * A turn is over once the PTY has been quiet this long and shows no
	 * "esc to interrupt" status bar (ms). Claude Code and Codex repaint a
	 * ticking timer while working, so a quiet screen means a resting agent.
	 */
	TURN_QUIET_MS: 15_000,
	/** A delivery younger than this is always treated as in progress (ms) */
	TURN_START_GRACE_MS: 5_000,
	/** Trailing screen lines inspected for the busy status bar */
	PROBE_TAIL_LINES: 15,
	/** Open messages kept per session (oldest dropped beyond this) */
	MAX_OPEN_MESSAGES_PER_SESSION: 5,
	/** Characters of the delivered text kept as a preview */
	PREVIEW_CHARS: 160,
	/** File under CREWLY_HOME holding turns cut off by the last shutdown */
	INTERRUPTED_TURNS_FILE: 'interrupted-turns.json',
	/** Interrupted turns older than this are not resumed (ms) */
	INTERRUPTED_TURN_MAX_AGE_MS: 6 * 60 * 60 * 1000,
	/** How long the resumer waits for the orchestrator to become active (ms) */
	RESUME_ORC_READY_TIMEOUT_MS: 10 * 60 * 1000,
	/** Poll interval while waiting for the orchestrator to become active (ms) */
	RESUME_ORC_POLL_MS: 5_000,
	/** Prefix of the notice re-delivered with an interrupted message */
	RESUME_NOTICE: '[CREWLY] You were interrupted by a restart while handling this message; pick it up again:',
} as const;
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
export const API_SECURITY_CONSTANTS = CONFIG_API_SECURITY_CONSTANTS;

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
	/**
	 * Explicit working directory for the orchestrator's PTY. When unset the
	 * orchestrator starts in the first assigned project path, then CREWLY_HOME —
	 * never in the package install dir or the server's process.cwd().
	 */
	CREWLY_ORC_CWD: 'CREWLY_ORC_CWD',
} as const;

// Agent-specific timeout values (in milliseconds)
export const AGENT_TIMEOUTS = {
	ORCHESTRATOR_INITIALIZATION: 120000, // 2 minutes for orchestrator
	REGULAR_AGENT_INITIALIZATION: 75000, // 75 seconds for regular agents
	/** #227: Extended timeout for Claude Code — PI protection evaluation takes 2-3 min */
	CLAUDE_CODE_INITIALIZATION: 300000, // 5 minutes for Claude Code agents
	/** #252: Watchdog timeout — if agent is still in 'starting' state after this period, mark as error */
	STARTING_WATCHDOG: 300000, // 5 minutes
} as const;

// Crewly in Chrome constants for Chrome Extension WebSocket bridge
export const BROWSER_BRIDGE_CONSTANTS = {
	/** WebSocket server path for Chrome Extension connections */
	WS_PATH: '/ws/browser',
	/** Default timeout for commands sent to Chrome Extension (ms) */
	COMMAND_TIMEOUT_MS: 30000,
	/**
	 * Per-tab dispatch (1 agent : 1 tab) — see
	 * `.crewly/specs/crewly-in-chrome-per-tab-fix-2026-04-25.md`.
	 */
	/** Hard cap on concurrent agent→tab bindings. POST /api/browser/bind returns 503 above this. */
	TAB_BIND_HARD_CAP: 50,
	/** Soft warning threshold — log + alert when crossed, but bind still succeeds. */
	TAB_BIND_SOFT_WARN: 25,
	/** Default TTL for an idle binding in minutes (configurable via CREWLY_TAB_BIND_TTL_MINUTES). */
	TAB_BIND_TTL_MINUTES: 30,
	/** Cadence of the orphan/TTL sweep timer in milliseconds. */
	TAB_BIND_SWEEP_MS: 5 * 60 * 1000,
	/** Default tabId on a 503 retry hint (milliseconds the skill should back off). */
	TAB_BIND_RETRY_AFTER_MS: 30000,
	/**
	 * Logged reason when tab-inventory reconcile closes a tab: this backend
	 * created it and no agent has it bound any more. Reconcile never closes a
	 * Crewly tab this backend did not create (it may be another client's).
	 */
	RECONCILE_CLOSE_REASON_OWN_UNBOUND: 'own_unbound_tab',
	/** Longest agent goal forwarded to the extension banner and the live view. */
	MAX_AGENT_GOAL_LENGTH: 200,
} as const;

/**
 * Crewly Cloud Relay proxy constants for browser instance lifecycle hygiene.
 * Used by `BrowserProxyService` to keep its in-memory instances Map free of
 * stale entries when the relay drops a `disconnected` event or when the user
 * reinstalls the extension (fresh `instanceId` UUID — old one would otherwise
 * linger forever).
 *
 * See `.crewly/specs/browser-ext-stale-status-fix-2026-04-30.md`.
 */
export const BROWSER_PROXY_CONSTANTS = {
	/** Cadence of the wall-clock TTL sweep (ms). Every interval the service
	 *  walks `this.instances` and purges entries whose `lastSeenAt` exceeds
	 *  `STALE_PURGE_THRESHOLD_MS`. */
	SWEEP_INTERVAL_MS: 60_000,
	/** Inactivity threshold (ms) after which an instance is considered stale
	 *  and purged by the sweep. 5 min is generous enough to tolerate transient
	 *  relay/network blips without prematurely evicting a live ext connection
	 *  (heartbeat fires every 25s, so 5 min = ~12 missed heartbeats). */
	STALE_PURGE_THRESHOLD_MS: 5 * 60_000,
	/** Re-issue `list_browsers` to the relay every Nth heartbeat tick.
	 *  Defensive sync against missing `browser_event:updated` pushes from
	 *  the cloud relay. With heartbeat at 25s and N=8, refresh fires every
	 *  ~200s — comfortably under STALE_PURGE_THRESHOLD_MS (300s) so a live
	 *  ext that is mid-refresh never crosses the purge boundary.
	 *  Boundary math: register@T0 → first refresh@T0+200s → next sweep
	 *  evaluates lastSeenAt at most 200s old → far below 300s threshold. */
	LIST_REFRESH_EVERY_N_HEARTBEATS: 8,
	/**
	 * Deadline (ms) for receiving a `heartbeat_ack` from the relay after a
	 * `heartbeat` is sent. If no ack arrives within this window the relay
	 * socket is treated as dead/half-open and the proxy reconnects proactively
	 * rather than riding the socket until the relay's 180s `4002` eviction.
	 *
	 * Set to 2x the 25s heartbeat interval (50s): comfortably above one RTT on
	 * slow networks (avoids false reconnects) yet well under the relay's 180s
	 * timeout (so the backend never churns drop→re-register→count:0 every
	 * ~3min). Liveness invariant — see the long-term browser-relay fix design.
	 */
	HEARTBEAT_ACK_DEADLINE_MS: 50_000,
} as const;

// Agent runtime types
export const RUNTIME_TYPES = {
	CLAUDE_CODE: 'claude-code',
	GEMINI_CLI: 'gemini-cli',
	CODEX_CLI: 'codex-cli',
	/** OpenCode (opencode.ai) — open-source TUI coding agent, issue #306 */
	OPENCODE_CLI: 'opencode-cli',
	CREWLY_AGENT: 'crewly-agent',
} as const;

/**
 * The canonical managed binary name for the Crewly Agent runtime.
 *
 * After PR #599 (Plan A) the agent reasoning loop lives in the standalone
 * `crewly-agent` npm package; OSS spawns it as a subprocess. This is the
 * default value of `settings.general.runtimeCommands['crewly-agent']` and the
 * command `resolveRuntimeCommand()` returns (no shell) when no genuine custom
 * shell command is configured.
 */
export const CREWLY_AGENT_MANAGED_COMMAND = 'crewly-agent' as const;

/**
 * Legacy / sentinel values for `runtimeCommands['crewly-agent']` that must NOT
 * be treated as real shell commands.
 *
 * `'crewly-agent-in-process'` was the factory default before PR #599 switched
 * the runtime to an external binary. It is not a real executable — when shelled
 * out via `sh -lc` it fails with exit-127 (issue #693). Any value listed here is
 * recognized as "use the managed default binary" and is rewritten to
 * `CREWLY_AGENT_MANAGED_COMMAND` on settings load (migration) and at command
 * resolution time (defensive guard).
 */
export const LEGACY_CREWLY_AGENT_SENTINELS = ['crewly-agent-in-process'] as const;

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
	/** Minimum non-whitespace characters in stripped PTY output to count as meaningful activity.
	 * Set to 8 to filter out Gemini CLI TUI noise (cursor movements, spinner chars, single-char
	 * redraws) that have 1-5 residual chars after ANSI stripping. Real output (tool results,
	 * response text, bash output) is always longer. */
	MIN_MEANINGFUL_OUTPUT_BYTES: 8,
	/** Minimum time (ms) an agent must remain in_progress before emitting busy/idle events */
	MIN_BUSY_DURATION_MS: 10000,
	/**
	 * Cadence of the orphan-PTY reaper sweep (ms).
	 *
	 * The reaper walks the live sessionName→PtySession registry and tears down
	 * any PTY whose owning session is no longer active (killed, exited, or whose
	 * child shell has died) but which was never routed through centralized
	 * teardown — a defensive backstop against `/dev/ptmx` + `/dev/ttysNNN` FD
	 * accumulation (the 6-day backend that leaked 319 orphaned master FDs).
	 * 5 minutes is frequent enough to bound leakage well under the open-file
	 * ceiling yet cheap (an O(n) walk over a handful of sessions).
	 */
	ORPHAN_REAPER_INTERVAL_MS: 5 * 60 * 1000,
} as const;

/**
 * Session recreation (Step 2 full recreation in AgentRegistrationService).
 *
 * D3 (2026-09-21): the runtime init sequence leads with Ctrl-C
 * (session-command-helper sendCtrlC / clearCurrentCommandLine). Written a few
 * ms after spawn, before zsh has installed its interactive SIGINT handling,
 * that Ctrl-C ends the shell (Max's Step-2 shell died 11 ms after spawn). The
 * primary path is immune only by accident (it types five `export`s first,
 * ~0.5 s). Step 2 therefore waits — bounded — for the shell's first output
 * (its prompt) before the first write.
 */
export const SESSION_RECREATION_CONSTANTS = {
	/** Upper bound on waiting for the fresh shell to print its prompt (ms). */
	SHELL_READY_TIMEOUT_MS: 3_000,
	/** First non-whitespace byte the shell prints — its prompt, whatever the shell/theme. */
	SHELL_READY_PATTERN: /\S/,
	/** Terminal lines to inspect for a prompt that landed before we subscribed. */
	SHELL_READY_CAPTURE_LINES: 5,
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
	/**
	 * How long delivery waits on ActivityMonitor before assuming "not busy".
	 *
	 * `getWorkingStatusForSession` has hung before (2026-05-14); a message
	 * must not wedge behind it, so the probe is bounded and a timeout keeps
	 * the pre-existing behaviour.
	 */
	WORKING_STATUS_PROBE_TIMEOUT_MS: 2000,
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
	/**
	 * Backoff schedule (ms) for retrying eager orchestrator chat monitoring
	 * when the PTY session is not yet registered in the SessionBackend.
	 *
	 * Background: startOrchestratorChatMonitoring is invoked from boot,
	 * setup, and restart paths immediately after createAgentSession resolves.
	 * The SessionBackend may not have fully registered the new session by
	 * then — leaving the orchestrator's PTY without an onData listener for
	 * the rest of its lifetime, which silently drops responses to user
	 * messages until the side panel is opened (RCA 2026-04-29 / 2026-04-30).
	 *
	 * Total budget ≈ 8.6s with 5 attempts. Tuned to outlast typical
	 * createAgentSession→backend-register lag (sub-1s on local, up to ~3s
	 * under heavy load) without unbounded retries.
	 */
	MONITORING_RETRY_BACKOFFS_MS: [100, 500, 1000, 2000, 5000] as readonly number[],
} as const;

// Chat routing constants (message markers and patterns for orchestrator communication)
export const CHAT_ROUTING_CONSTANTS = {
	/** Message format prefix for chat routing */
	MESSAGE_PREFIX: 'CHAT',
	/** Message format prefix for Google Chat routing (distinguishes from Slack) */
	GOOGLE_CHAT_PREFIX: 'GCHAT',
	/** chat-v2 channel id prefix for recorded Google Chat conversations */
	GOOGLE_CHAT_CHANNEL_PREFIX: 'gchat',
	/** chat-v2 channel id prefix for recorded Telegram conversations */
	TELEGRAM_CHANNEL_PREFIX: 'telegram',
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
 * Message replay constants for replaying pending messages after orchestrator restarts (#247).
 * Used by the MessageReplayService to scan chat history for unreplied user messages
 * that arrived while the orchestrator was offline, and replay them into the queue.
 */
export const MESSAGE_REPLAY_CONSTANTS = {
	/** Maximum age of messages to consider for replay (ms). Default: 24 hours */
	MAX_REPLAY_WINDOW_MS: 24 * 60 * 60 * 1000,
	/** Minimum age of the persisted queue state before replaying (ms).
	 *  Prevents replaying on quick restarts where no messages were likely missed. */
	MIN_OFFLINE_DURATION_MS: 30_000,
	/** Maximum number of messages to replay in a single startup cycle */
	MAX_REPLAY_COUNT: 20,
	/** Prefix added to replayed messages for orchestrator awareness */
	REPLAY_PREFIX: '[REPLAYED]',
} as const;

/**
 * Thread Status Queue constants for tracking inbound message thread lifecycle.
 * Used by ThreadStatusQueueService for persistence, expiry, and recovery.
 */
export const THREAD_STATUS_CONSTANTS = {
	/** Persisted JSON filename under crewly home directory */
	STORAGE_FILE: 'thread-status-queue.json',
	/** Maximum number of entries to retain (oldest terminal entries pruned first) */
	MAX_ENTRIES: 500,
	/** Timeout in minutes before a non-terminal thread is marked as expired */
	STALE_TIMEOUT_MINUTES: 30,
	/** Retention period in hours for terminal entries before cleanup */
	CLEANUP_RETENTION_HOURS: 24,
	/**
	 * How long a compact tombstone of a cleaned-up terminal entry is kept.
	 * The restart resume scan looks back 24h by thread-file mtime, which can
	 * be later than the entry's last update (an agent posting a completion
	 * report into the thread). Without a record the thread read as
	 * "unreplied" on every restart (#757), so this must comfortably exceed
	 * that lookback.
	 */
	TOMBSTONE_RETENTION_HOURS: 24 * 30,
	/** Maximum tombstones kept (oldest dropped first) */
	MAX_TOMBSTONES: 5000,
	/** Debounce interval in ms for persisting state to disk */
	PERSIST_DEBOUNCE_MS: 100,
	/** Maximum number of delivery retries before marking as error */
	MAX_RETRY_COUNT: 3,
	/** Maximum length of the message preview stored with each entry */
	MAX_PREVIEW_LENGTH: 200,
	/** Markers in orchestrator replies that indicate delegation occurred */
	DELEGATION_MARKERS: ['[DELEGATED]', '[ASSIGNED]', 'delegate-task', 'delegated to'],
	/** Markers in orchestrator replies that indicate a follow-up question */
	FOLLOW_UP_MARKERS: ['?', 'please clarify', 'could you', 'can you elaborate'],
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
	/** Maximum wait time before forcing a flush of buffered notifications (ms).
	 *  Prevents indefinite deferral when new events keep resetting the debounce timer.
	 *  Set to 30 seconds — a reasonable ceiling for non-critical event delivery. */
	MAX_BATCH_WAIT_MS: 30_000,
	/** Default subscription time-to-live in minutes (8 hours).
	 *  Increased from 2h to handle long-running tasks without subscription expiry. */
	DEFAULT_SUBSCRIPTION_TTL_MINUTES: 480,
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
 * Constants for Slack team channels — one Slack channel + one chat-v2 huddle
 * per Crewly team, so the owner talks to a whole team (and to individual
 * agents by `@name`) without going through the orchestrator.
 */
/**
 * Slack DMs to an agent's own bot user (routed into the owner's chat-v2 DM
 * channel with that agent, never to the orchestrator).
 */
export const SLACK_AGENT_DM_CONSTANTS = {
	/** Link store filename under CREWLY_HOME */
	STORE_FILENAME: 'slack-agent-dms.json',
	/** Reaction added to a routed inbound DM while the agent works on it */
	INBOUND_REACTION: 'eyes',
	/**
	 * Owner of the DM channels on a single-user OSS install — the same
	 * principal the dashboard (no-JWT auth fallback) and the portal relay
	 * adapter use, so Slack DMs land in the DM channel the owner already sees.
	 */
	OWNER_USER_ID: 'dev-user-001',
} as const;

/**
 * "Agent is typing…" placeholder in Slack. Slack has no typing indicator
 * for bots, so the agent's bot posts a placeholder the moment a message is
 * handed to the agent and edits it into the reply.
 */
/**
 * LLM-wiki as a knowledge base (2026-09-19 review): retention gate,
 * two-step retrieval index, usage ledger, proposals, history, privacy.
 */
export const WIKI_KB_CONSTANTS = {
	/** Why a page earns a place in the vault (one is required to create a page). */
	KEEP_BECAUSE: ['changes_decision', 'contradicts', 'hard_fact', 'reusable_method'] as const,
	/** One-line conclusion ("what this means for us") — required on every page. */
	SUMMARY_MAX_CHARS: 240,
	TITLE_MAX_CHARS: 120,
	/** Per-vault one-line-per-page index read as retrieval step 1. */
	INDEX_FILENAME: 'index.md',
	/** Index bytes returned to an agent before it is cut down to the query's folders. */
	INDEX_MAX_BYTES: 48 * 1024,
	/** Retrieval ledger (JSONL): every query, what it read, and misses. */
	USAGE_FILENAME: 'usage.jsonl',
	USAGE_WINDOW_DAYS: 7,
	USAGE_MAX_BYTES: 4 * 1024 * 1024,
	/** Pages written by `proposed_only` roles wait here until a canonical role accepts. */
	PROPOSED_DIR: 'llm-curated/_proposed',
	/** Per-page prior revisions (who changed what) — capped per page. */
	HISTORY_DIR: '.wiki-history',
	HISTORY_MAX_REVISIONS: 20,
	/** Bridge: stop re-creating a legacy-migrate WI after this many no-progress strikes. */
	MIGRATE_MAX_STRIKES: 3,
	/** Lint: token-set Jaccard on title+summary above which two pages are flagged as possible duplicates/contradictions. */
	DUPLICATE_JACCARD: 0.5,
	/** Frontmatter keys agents may set. */
	FRONTMATTER_KEYS: ['title', 'summary', 'keep_because', 'tags', 'visibility', 'source', 'caller', 'recorded', 'updated', 'superseded_by', 'superseded_at', 'superseded_reason', 'proposed_by'] as const,
} as const;

/** One of {@link WIKI_KB_CONSTANTS.KEEP_BECAUSE}. */
export type WikiKeepBecause = (typeof WIKI_KB_CONSTANTS.KEEP_BECAUSE)[number];

/** How many recent thread channels an owner notification tries before giving up when SLACK_DEFAULT_CHANNEL is unset. */
export const SLACK_NOTIFICATION_FALLBACK_MAX_CANDIDATES = 4;

/**
 * Appended to every reply instruction an agent gets (owner, 2026-09-24): size
 * the job first; a long one gets a short interim note (understanding + plan)
 * before the work, so the owner is not left with only "is working on it…".
 * `{cmd}` is the interim form of the agent's reply skill.
 */
export const CHAT_REPLY_PACING_HINT =
	'回复节奏: 动手前先判断工作量。一两分钟内能做完的（查一下、答一句、改一处）→ 直接做，做完一次性回复。' +
	'要花更久的（多个步骤、要跑命令/开浏览器/查很多资料、预计超过约 3 分钟）→ **先**用一两句话回复（{cmd}）：你理解的需求、打算怎么做、大概多久，有要对方确认的就一并问；' +
	'发完再开始做，做完发最终回复。中间不要刷进度，除非遇到阻塞或计划变了。' +
	'对方是在回答你问的问题、或给了你新信息/决定时，至少回一句简短确认（例如「收到，按 X 来」）——不回会让对方以为没人看；只有「好」「ok」「谢谢」这类收尾可以不回。';

/** Unassigned work goes to a decider and moves up when not taken (owner, 2026-09-24). */
export const UNASSIGNED_ROUTE_CONSTANTS = {
	/** A decider has this long to take an item before it moves one level up (ms) */
	ESCALATE_AFTER_MS: 30 * 60 * 1000,
	/** How often routed items are checked (ms) */
	SWEEP_INTERVAL_MS: 5 * 60 * 1000,
} as const;

export const SLACK_TYPING_CONSTANTS = {
	/** Placeholder text once the agent holds the message. "working on it", not "typing": an agent that has the message is usually reading files, running commands or looking things up — typing is the last step. */
	TYPING_TEXT: '⚙️ {name} is working on it…',
	/** Shown while an idle agent is being started + registered (cold start) */
	WAKING_TEXT: '🌙 {name} is waking up…',
	/** Shown when a cold start is taking longer than WAKING_SLOW_MS */
	WAKING_SLOW_TEXT: '🌙 {name} is still starting up (a cold start takes 1–2 minutes)…',
	WAKING_SLOW_MS: 60 * 1000,
	/** Shown when the agent could not be started or the message could not be delivered */
	FAILED_TEXT: '⚠️ {name} could not be reached right now — please try again in a minute.',
	/** What the placeholder becomes when the agent has not replied in time */
	TIMEOUT_TEXT: '⏱ {name} is still working on this — the reply will follow.',
	/** How long a placeholder waits for the reply before it is edited to TIMEOUT_TEXT */
	TIMEOUT_MS: 5 * 60 * 1000,
	/** A timed-out placeholder is still removed by a reply arriving within this long (ms) */
	EXPIRED_KEEP_MS: 24 * 60 * 60 * 1000,
	/** A placeholder younger than this is not taken down when the turn ends (race with delivery) */
	SETTLE_MIN_AGE_MS: 30 * 1000,
	/** Fallback text when a settled placeholder cannot be deleted */
	SETTLED_TEXT: '✓ {name} read this — no reply needed.',
	/** Reaction put on the person's message when the agent settled it without replying */
	SETTLED_REACTION: 'white_check_mark',
	/**
	 * Metadata flag on an agent message that is an interim note ("got it —
	 * here is my plan") rather than the answer: the Slack mirror posts it and
	 * puts the working-on-it placeholder back under it, and the ticket loop
	 * does not count it as the answer (owner, 2026-09-24).
	 */
	INTERIM_METADATA_KEY: 'interim',
} as const;

export const SLACK_TEAM_CHANNEL_CONSTANTS = {
  /** How long a channel member list is trusted when picking between same-named agents. */
  MEMBER_CACHE_TTL_MS: 5 * 60 * 1000,
	/** Mapping store filename under CREWLY_HOME */
	STORE_FILENAME: 'slack-team-channels.json',
	/** Slack's hard limit on channel-name length */
	MAX_CHANNEL_NAME_LENGTH: 80,
	/** Slack's hard limit on channel purpose length */
	MAX_PURPOSE_LENGTH: 250,
	/** Max Levenshtein distance for a "did you mean @x?" suggestion */
	MENTION_SUGGEST_MAX_DISTANCE: 2,
	/** Max suggestions offered for one unknown @name */
	MENTION_SUGGEST_MAX: 3,
	/** Reaction added to a routed inbound message while the team works on it */
	INBOUND_REACTION: 'eyes',
	/** How many routed Slack messages to remember for duplicate-copy suppression */
	SEEN_INBOUND_MAX: 500,
	/** Synthetic team-id prefix for channels linked on the fly (no Crewly team behind them) */
	ADHOC_TEAM_PREFIX: 'adhoc:',
	/** Fallback icon when a member has no avatar */
	DEFAULT_ICON_EMOJI: ':robot_face:',
	/** Per-role icon fallbacks (Slack emoji names) */
	ROLE_ICON_EMOJI: {
		'team-leader': ':crown:',
		tpm: ':clipboard:',
		developer: ':computer:',
		'frontend-developer': ':art:',
		'backend-developer': ':gear:',
		'fullstack-dev': ':hammer_and_wrench:',
		qa: ':mag:',
		'qa-engineer': ':mag:',
		designer: ':art:',
		'product-manager': ':compass:',
		architect: ':triangular_ruler:',
		sales: ':handshake:',
		support: ':telephone_receiver:',
		marketing: ':mega:',
	} as Record<string, string>,
} as const;

/**
 * Constants for Slack agent identities — one real Slack bot user per agent,
 * provisioned through Crewly Cloud (`/api/cloud/slack/*`).
 */
export const SLACK_AGENT_IDENTITY_CONSTANTS = {
	/** Local identity cache filename under CREWLY_HOME (mode 0600) */
	STORE_FILENAME: 'slack-agent-identities.json',
	/** Cloud API prefix (appended to the cloud URL) */
	CLOUD_PATH: '/api/cloud/slack',
	/** How often to ask Cloud about pending installs (ms) */
	PENDING_POLL_INTERVAL_MS: 30_000,
	/** Stop polling a pending install after this long (ms) */
	PENDING_POLL_MAX_AGE_MS: 24 * 60 * 60 * 1000,
	/** HTTP timeout for Cloud calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
} as const;

/**
 * Slack v3 — "Crewly Cloud owns Slack". Cloud installs the master Slack app
 * once per account, receives Slack events over HTTP and pushes them to the
 * right OSS instance through the relay queue; instances register themselves
 * (teams, channels, agents) so Cloud can route.
 */
export const SLACK_CLOUD_CONSTANTS = {
	/** Cached copy of `GET /api/cloud/slack/config` under CREWLY_HOME (mode 0600) */
	CONFIG_CACHE_FILENAME: 'slack-cloud-config.json',
	/** Per-instance Slack settings (currently only the `primary` flag) under CREWLY_HOME */
	INSTANCE_SETTINGS_FILENAME: 'slack-instance.json',
	/** Cloud API prefix (appended to the cloud URL) */
	CLOUD_PATH: '/api/cloud/slack',
	/** `GET` — master workspace + agent identities for this account */
	CONFIG_PATH: '/config',
	/** `DELETE` — remove the account's Slack workspace on Cloud */
	WORKSPACE_PATH: '/workspace',
	/** GET → every workspace on the account (redacted) */
	WORKSPACES_PATH: '/workspaces',
	/** A Cloud config appearing this soon after boot still counts as the boot decision — only when the recorded source is `cloud` */
	BOOT_PRECEDENCE_WINDOW_MS: 5 * 60 * 1000,
	/** Last Slack source that connected (`env` | `cloud`) under CREWLY_HOME; decides boot precedence when both exist (#753) */
	SOURCE_PREFERENCE_FILENAME: 'slack-source.json',
	/** `PUT /instances/:instanceId` — registry heartbeat */
	INSTANCES_PATH: '/instances',
	/** `POST` — provision per-agent apps for a team roster */
	AGENTS_SYNC_PATH: '/agents/sync',
	/** DELETE <AGENTS_PATH>/:agentSession removes one agent's Slack app */
	AGENTS_PATH: '/agents',
	/** `POST` — deliver a room message to an agent on another machine */
	HANDOFF_PATH: '/handoff',
	/** GET → who is who across the account (instances, teams, agents, bot users) */
	DIRECTORY_PATH: '/directory',
	/** Channel rosters are cached this long (users.info is rate-limited) */
	DIRECTORY_CACHE_MS: 5 * 60 * 1000,
	/** `GET` — one-click install redirect (token + returnUrl in the query) */
	INSTALL_PATH: '/install',
	/** Dashboard path the install flow returns to */
	INSTALL_RETURN_PATH: '/connections?platform=slack',
	/** How often the cached Cloud config is re-fetched (ms) */
	CONFIG_REFRESH_INTERVAL_MS: 10 * 60 * 1000,
	/** How often the instance registry heartbeat is sent (ms) */
	REGISTRY_HEARTBEAT_INTERVAL_MS: 5 * 60 * 1000,
	/** Coalesce bursts of `team-saved` events into one heartbeat (ms) */
	TEAM_SAVED_DEBOUNCE_MS: 5_000,
	/** Short retries while the relay queue is not registered yet (then the 5-min cadence takes over) */
	QUEUE_WAIT_MAX_RETRIES: 24,
	/** HTTP timeout for Cloud calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
	/** `env` = only local tokens, `cloud` = only Cloud, unset = the last connected source (else the self-hosted app) wins when both exist (#753) */
	SOURCE_ENV_VAR: 'CREWLY_SLACK_SOURCE',
	/** `1`/`true` marks this instance as the account's primary (DM / unmapped-channel target) */
	PRIMARY_ENV_VAR: 'CREWLY_SLACK_PRIMARY',
	/** Relay `type` of a Slack event pushed by Cloud */
	MESSAGE_TYPE: 'slack_event',
	/** `fromDeviceName` Cloud uses on pushed Slack events */
	CLOUD_DEVICE_NAME: 'crewly-cloud-slack',
	/**
	 * Slack `message` subtypes the cloud transport still hands to the shared
	 * inbound handler. Everything else (`message_changed`, `channel_join`,
	 * `bot_message`, …) is dropped before it reaches routing.
	 */
	INBOUND_ALLOWED_SUBTYPES: ['file_share', 'thread_broadcast'],
} as const;

/**
 * Which sub-agent `report-status` lines are forwarded to the orchestrator's
 * message queue. Every forwarded line is a full-context model turn for the
 * orchestrator, so progress chatter it cannot act on stays out.
 */
export const ORC_STATUS_FORWARDING = {
	/**
	 * Longest agent status forwarded to the orchestrator in full. A [DONE]
	 * report can run to several thousand characters, and every character
	 * stays in the orchestrator's conversation, re-read on every later turn.
	 * The full report is still in the conversation it was posted to.
	 */
	MAX_FORWARD_CHARS: 600,
	/**
	 * Markers that only say "still going" or "I am up" — not forwarded.
	 * [READY]/[ONLINE] joined the list on 2026-09-18: an agent woken by a
	 * Slack message announced itself and the orchestrator spent a full
	 * turn on it. Message delivery to a freshly started agent is the
	 * system's job (queued messages flush on registration), so the
	 * orchestrator has nothing to do with the announcement. Everything else
	 * ([DONE], [IDLE] (agent is free for the next task), [BLOCKED], [FAILED],
	 * structured reports, unknown formats) is forwarded.
	 */
	PROGRESS_ONLY_MARKERS: /^\s*\[(IN_PROGRESS|WORKING|ACTIVE|STARTED|STARTING|HEARTBEAT|READY|ONLINE)\]/i,
} as const;

/**
 * Owner-facing OKR guidance (OKROwnerGuidanceService): approval nudges and
 * the weekly digest.
 */
export const OKR_GUIDANCE_CONSTANTS = {
	/** Re-nudge a pending proposal no more often than this */
	APPROVAL_NUDGE_COOLDOWN_MS: 24 * 60 * 60 * 1000,
	/** Weekly digest schedule (cron, in DIGEST_TZ); env CREWLY_OKR_DIGEST_CRON */
	DIGEST_CRON: '0 9 * * 1',
	/** Timezone for DIGEST_CRON; env CREWLY_OKR_DIGEST_TZ */
	DIGEST_TZ: 'UTC',
	/** KR lines shown per mission in a message */
	MAX_KRS_IN_MESSAGE: 6,
	/** staleCycles at or above this flags a mission as "no progress" in the digest */
	STALE_CYCLES_FLAG: 2,
} as const;

/**
 * `skill_output` Key Result measurement (KRSkillMeasurerService).
 */
export const KR_SKILL_MEASURER_CONSTANTS = {
	/** Kill a measuring skill after this long */
	TIMEOUT_MS: 60_000,
	/** Largest stdout accepted from a measuring skill */
	MAX_OUTPUT_BYTES: 1_000_000,
	/** Dot path read when `measurementConfig.jsonPath` is absent */
	DEFAULT_JSON_PATH: '.value',
} as const;

/**
 * Constants for agent-initiated Slack posts (the `slack-post` skill).
 */
export const SLACK_AGENT_POST_CONSTANTS = {
	/** Max characters in one agent-initiated message */
	MAX_TEXT_LENGTH: 12_000,
} as const;

/**
 * Constants for cross-machine messaging via Slack.
 * Two Crewly instances communicate through a shared Slack channel.
 */
export const CROSS_MACHINE_CONSTANTS = {
	/** Maximum number of processed message IDs to track for deduplication */
	MAX_TRACKED_MESSAGE_IDS: 500,
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
 * Constants for cron next-run computation (`getNextRunTime`).
 */
export const CRON_SCHEDULE_CONSTANTS = {
	/**
	 * How far ahead a cron expression is searched for its next match. A
	 * specific date such as `0 13 16 10 *` can be up to a year away; the old
	 * 8-day scan fell through to a now+24h fallback for anything further out.
	 */
	NEXT_RUN_HORIZON_DAYS: 366,
	/**
	 * When skipping a day whose date fields do not match, jump to this many
	 * minutes before the day's end and finish hour-by-hour. Larger than any
	 * DST shift, so the jump can never land in (and skip the start of) the
	 * next day.
	 */
	DAY_END_SKIP_BUFFER_MINUTES: 120,
	/**
	 * Fallback returned for an expression with no match inside the horizon
	 * (e.g. `0 0 31 2 *`). Not schedule-aligned; logged at WARN.
	 */
	IMPOSSIBLE_EXPRESSION_FALLBACK_MS: 24 * 60 * 60 * 1000,
} as const;

/**
 * Constants for the V3 TriggerEngine one-shot scheduler.
 */
export const TRIGGER_ENGINE_CONSTANTS = {
	/**
	 * Largest delay a single Node timer can hold: 2^31 - 1 ms (~24.85 days).
	 * Above this, `setTimeout` emits TimeoutOverflowWarning and silently
	 * arms the timer for 1 ms — which is how a `--fire-at` three weeks out
	 * used to fire the instant it was created. Longer waits are chained in
	 * hops of at most this size.
	 */
	MAX_TIMER_DELAY_MS: 2_147_483_647,
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
 * #251: Gemini tool-check loop detection pattern.
 * Matches repeated "Ready. Final response." or "Wait, I will check if I should use mcp_"
 * cycling that indicates the agent is stuck checking Chrome DevTools MCP tools
 * without making progress. Time-windowed: triggers when the pattern appears
 * GEMINI_TOOL_CHECK_LOOP_THRESHOLD times within GEMINI_TOOL_CHECK_LOOP_WINDOW_MS.
 */
export const GEMINI_TOOL_CHECK_LOOP_PATTERN = /(?:Ready\.\s*Final\s+response\.?|Wait,\s*I[\u2019']?(?:ll|\s+will)\s+check\s+if\s+I\s+should\s+use\s+mcp_)/i;

/** #251: Number of tool-check loop pattern matches within the time window
 *  before declaring the agent stuck. */
export const GEMINI_TOOL_CHECK_LOOP_THRESHOLD = 5;

/** #251: Time window in milliseconds for counting tool-check loop occurrences.
 *  If THRESHOLD matches occur within this window, the agent is considered stuck. */
export const GEMINI_TOOL_CHECK_LOOP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

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
 * Claude Code start-up states that cannot resolve without the user, so the
 * agent start must fail fast with an actionable error instead of waiting out
 * the readiness timeout and every fallback (about 5 minutes before this).
 */
export const CLAUDE_STARTUP_CONSTANTS = {
	/** Error code on RuntimeStartupBlockedError and on the session result. */
	BLOCKED_ERROR_CODE: 'RUNTIME_STARTUP_BLOCKED',
	/** Claude refuses --dangerously-skip-permissions as root; this is its message. */
	ROOT_REFUSAL_MARKER: 'cannot be used with root/sudo privileges',
	/**
	 * Claude honours IS_SANDBOX=1 as "running in a sandbox" and then allows the
	 * skip-permissions flag as root (containers). Only then is root allowed.
	 */
	SANDBOX_ENV: 'IS_SANDBOX',
	/**
	 * Claude Code's first-run onboarding (theme picker), shown when `claude`
	 * has never been run on this machine. It precedes sign-in and nothing in
	 * Crewly can complete it.
	 */
	FIRST_RUN_MARKERS: ['Choose the text style'] as readonly string[],
	MESSAGES: {
		ROOT: 'Crewly agents cannot run as root: Claude Code refuses --dangerously-skip-permissions under root/sudo. Run Crewly as a normal (non-root) user, then start the team again.',
		FIRST_RUN: 'Claude Code has not been set up on this machine yet. Run `claude` once in a terminal, choose a theme and log in, then start the team again.',
	},
} as const;

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
 *
 * IMPORTANT: Detection must be narrow to avoid false positives (#130 follow-up).
 * Previous issues: STATUS_AREA_LINES=5 and generic /\d+ errors?/ matched normal
 * content (build output, test results), causing spurious F12 keypresses that
 * typed literal "F12" text into the terminal (because F12 was missing from KEY_CODES).
 *
 * Current approach: Only check the last 2 lines (actual status bar), and require
 * Gemini-specific patterns ("F12 for deta" or "✖" + "error") to avoid matching
 * generic error text from build tools, test runners, etc.
 */
export const GEMINI_ERROR_STATE_CONSTANTS = {
	/** Unicode marker for error state in Gemini CLI status bar */
	ERROR_MARKER: '\u2716',
	/**
	 * Regex matching Gemini CLI's specific error format in the status bar.
	 * Requires "F12" nearby to distinguish from generic "N errors" text in
	 * build output or test results. Matches: "3 errors (F12 for details)"
	 */
	ERROR_COUNT_PATTERN: /\d+ errors?.*F12/i,
	/**
	 * Number of terminal lines from the bottom to consider as "status area".
	 * Gemini CLI's status bar is 1-2 lines; using 3 for safety margin.
	 * Previously 5, which caught content lines and caused false positives.
	 */
	STATUS_AREA_LINES: 3,
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
/**
 * Claude transcript sync — reads Claude Code's own session JSONL files to get
 * exact per-turn token usage for `claude-code` agents.
 */
/**
 * Live browser view — per-agent browser sessions and the frames that make
 * them watchable.
 *
 * Frames are owner-surface only: in memory, never persisted, never attached
 * to a chat message or posted to any multi-party surface.
 */
/**
 * How much of a conversation an agent is shown when a message is dispatched
 * to it.
 *
 * Until now the answer was none: the prompt carried the one message and
 * nothing else, so an agent @-mentioned into a channel where a colleague had
 * just posted ten messages had no idea any of them existed. It also had no
 * way to check its own account of what was said, which is how one of them
 * ended up citing an instruction that did not exist.
 *
 * The caps are small on purpose. This is paid on *every* dispatch, and a
 * busy channel would otherwise add thousands of tokens to every wake-up —
 * the same cost shape that had one agent dragging 726k tokens through each
 * turn.
 */
/**
 * When the orchestrator's conversation is too big to carry on.
 *
 * On a 1M-window model Claude Code only compacts near the window, so an orc
 * that is resumed across every restart re-reads its whole history on every
 * turn — 612k tokens per turn on one machine (2026-09-23), growing ~64k a day,
 * with 0.1% of each turn new. At a restart (never mid-conversation) a history
 * above the threshold is closed and the orc starts fresh with a handover file
 * holding the tail of the old one. Its real state (tasks, teams, OKRs, wiki)
 * lives in Crewly and is read back at startup anyway.
 */
/** Remote desktop — the owner watching and driving this machine from the portal / phone. */
export const DESKTOP_REMOTE_CONSTANTS = {
	/** Under CREWLY_HOME; `{ enabled }`, switchable only on the machine */
	SETTINGS_FILE: 'desktop-remote.json',
	/** Widest frame sent over the relay, in pixels */
	FRAME_MAX_WIDTH: 1200,
	/** sips JPEG quality (0-100) */
	JPEG_QUALITY: 60,
	/** Longest text typed in one input */
	MAX_TYPE_CHARS: 2000,
} as const;

export const ORC_CONVERSATION_CONSTANTS = {
	/** Start fresh at a restart when the last turn carried at least this many tokens. Env: CREWLY_ORC_FRESH_CONTEXT_TOKENS */
	FRESH_CONTEXT_TOKENS: 300_000,
	/** How much of the old transcript's end is read to find the last turn's size */
	TAIL_BYTES: 2 * 1024 * 1024,
	/** Messages kept in the handover file, newest last */
	HANDOVER_MESSAGES: 40,
	/** Characters kept per handover message */
	HANDOVER_MESSAGE_CHARS: 800,
	/** Total cap on the handover file's body */
	HANDOVER_MAX_CHARS: 16_000,
	/** Directory under CREWLY_HOME for handover files */
	HANDOVER_DIR: 'handover',
} as const;

export const CHAT_CONTEXT_CONSTANTS = {
	/** Whether preceding messages are included at all */
	ENABLED: true,
	/**
	 * Messages to include from the same thread.
	 *
	 * A thread is the cheap, high-value case: everything in it is by
	 * construction about the same subject, so every line earns its tokens.
	 */
	THREAD_MAX: 12,
	/**
	 * Messages to include for a top-level channel message.
	 *
	 * Lower than the thread cap: a channel's recent traffic is often several
	 * unrelated conversations, so most of it is noise to the agent being
	 * asked.
	 */
	CHANNEL_MAX: 8,
	/** Characters kept per message before truncation */
	PER_MESSAGE_CHARS: 300,
	/**
	 * Ignore anything older than this. Yesterday's argument is not context
	 * for today's question, and including it invites an agent to answer the
	 * wrong one.
	 */
	MAX_AGE_MS: 6 * 60 * 60 * 1000,
} as const;

export const BROWSER_SESSION_CONSTANTS = {
	/** How often the capture loop wakes up (ms) */
	TICK_INTERVAL_MS: 1_500,
	/**
	 * A session counts as watched for this long after someone fetched its
	 * frame. Interest expires on its own, so there is no subscribe call to
	 * leak and a closed tab stops costing captures within seconds.
	 */
	WATCH_WINDOW_MS: 5_000,
	/** Minimum gap between frames while someone is watching (ms) */
	WATCHED_FRAME_INTERVAL_MS: 1_500,
	/**
	 * Minimum gap between frames when nobody is watching (ms). Only refreshed
	 * at all when the agent did something — a picture nobody looks at is pure
	 * cost on the agent's browser.
	 */
	IDLE_FRAME_INTERVAL_MS: 10_000,
	/**
	 * Frame encoding. A PNG viewport capture on a Retina display runs to
	 * several hundred kilobytes; half-scale JPEG lands around 30–80 KB, which
	 * is what makes once-a-second viable over a relay.
	 */
	FRAME_FORMAT: 'jpeg',
	/** JPEG quality for frames (0-100) */
	FRAME_QUALITY: 55,
	/** Downscale factor for frames */
	FRAME_SCALE: 0.5,
	/** How long a finished session stays listed before being pruned (ms) */
	RETAIN_FINISHED_MS: 10 * 60 * 1000,
} as const;

export const CLAUDE_TRANSCRIPT_SYNC_CONSTANTS = {
	/** How often to read the unread tail of each agent's transcript (ms) */
	SYNC_INTERVAL_MS: 60_000,
	/** Cursor file name, kept under CREWLY_HOME */
	CURSOR_FILE: 'claude-transcript-cursors.json',
	/**
	 * How many recent assistant message ids to remember per session for
	 * exactly-once counting. Only the newest turns can be rewritten in place,
	 * so a small window is enough and keeps the cursor file small.
	 */
	MAX_DEDUPE_IDS: 200,
	/**
	 * Context size, in tokens, above which a claude-code agent is asked to
	 * compact.
	 *
	 * Expressed as an absolute ceiling rather than a percentage of the model's
	 * window on purpose: the window differs per model and is not reported by
	 * the runtime, whereas the thing worth acting on — "this agent now drags
	 * N tokens through every single turn" — is directly measurable and is what
	 * actually drives cost. Override with CREWLY_CONTEXT_TOKEN_CEILING.
	 */
	CONTEXT_TOKEN_CEILING: 200_000,
} as const;

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
 * - OpenCode CLI: `/compact`
 */
export const RUNTIME_COMPACT_COMMANDS: Record<RuntimeType, string> = {
	'claude-code': '/compact',
	'gemini-cli': '/compress',
	'codex-cli': '/compact',
	'opencode-cli': '/compact',
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
 * Patterns that indicate a runtime is sitting on a *first-run* sign-in
 * screen (as opposed to a mid-session token expiry, which
 * `OAUTH_ERROR_PATTERN_SETS` covers). A fresh server install matches none of
 * the expiry sets, so without these the OAuth monitor stays idle while the
 * runtime waits for a human to log in.
 *
 * Each entry is a set of substrings that must ALL be present (AND logic,
 * case-insensitive) in the recent screen text. Plain string matching — no
 * regex — to stay ReDoS-free.
 */
export const LOGIN_REQUIRED_PATTERN_SETS: string[][] = [
	// Codex device-code flow (headless-friendly)
	['auth.openai.com/codex/device'],
	// Codex default sign-in screen
	['sign in with chatgpt'],
	// Claude Code sign-in screens
	['claude.ai/oauth/authorize'],
	['use the url below to sign in'],
	['paste code here if prompted'],
	['please run /login'],
	// Gemini CLI sign-in screen
	['login with google'],
	// OpenCode CLI: `/connect` provider dialog and the "no provider yet" footer
	['connect a provider'],
	['get started', '/connect'],
];

/**
 * Constants for first-run / device-code login detection and notification
 * in `OAuthReloginMonitorService`.
 */
export const LOGIN_REQUIRED_CONSTANTS = {
	/** Periodic screen sweep interval for sessions on a sign-in screen (ms) */
	SWEEP_INTERVAL_MS: 30_000,
	/** Lines of screen to inspect per sweep */
	SWEEP_CAPTURE_LINES: 60,
	/** Do not re-notify the owner for the same session/code within this window (ms) */
	RENOTIFY_COOLDOWN_MS: 15 * 60 * 1000,
	/** Length of the first device-code segment, e.g. `FBVZ` in `FBVZ-MJHKK` */
	DEVICE_CODE_HEAD_LEN: 4,
	/** Minimum length of the second device-code segment */
	DEVICE_CODE_TAIL_MIN_LEN: 4,
	/** Maximum length of the second device-code segment */
	DEVICE_CODE_TAIL_MAX_LEN: 8,
	/** Conversation id used when enqueueing the login notice to the orchestrator */
	ORCHESTRATOR_CONVERSATION_ID: 'system_login_required',
} as const;

/**
 * Per-runtime screen markers used by `isReadyForInput()` to decide whether a
 * TUI will accept typed input *right now*. `waitForRuntimeReady()` matches
 * banner text that is already on screen while the TUI is still booting (e.g.
 * Codex prints `OpenAI Codex` while `model: loading`), which is why the
 * registration instruction used to be typed into a half-booted TUI and
 * swallowed.
 */
export const RUNTIME_INPUT_READY_PATTERNS = {
	/** Number of trailing non-empty lines inspected for prompt / busy markers */
	TAIL_LINES: 12,
	CODEX: {
		/** Substrings (whitespace-collapsed, lower-case) that mean "still booting / not ready" */
		NOT_READY_MARKERS: ['model: loading', 'sign in with chatgpt', 'auth.openai.com/codex/device'],
	},
	CLAUDE_CODE: {
		NOT_READY_MARKERS: ['use the url below to sign in', 'paste code here if prompted'],
	},
	GEMINI_CLI: {
		NOT_READY_MARKERS: ['login with google', 'waiting for auth'],
	},
	OPENCODE_CLI: {
		/**
		 * OpenCode keeps its input box (and the `Ask anything…` placeholder) on
		 * screen while the model is running, so the busy signal is the
		 * `esc interrupt` hint under the box rather than a missing prompt. The
		 * remaining markers are the `/connect` provider dialog and the
		 * "no provider configured" footer.
		 */
		NOT_READY_MARKERS: [
			'esc interrupt',
			'esc again to interrupt',
			'connect a provider',
			'select auth method',
			'get started /connect',
		],
	},
} as const;

/**
 * Timing for delivering the registration instruction to a freshly booted
 * runtime and re-delivering it once when no registration arrives.
 */
export const REGISTRATION_DELIVERY_CONSTANTS = {
	/** Give the runtime this long to reach an idle input prompt before we type the instruction anyway (ms) */
	RUNTIME_INPUT_READY_TIMEOUT_MS: 90_000,
	/** Poll cadence while waiting for the idle prompt (ms) */
	RUNTIME_INPUT_READY_POLL_MS: 2_000,
	/** Poll cadence while waiting for the agent to register after delivery (ms) */
	REGISTRATION_CHECK_INTERVAL_MS: 5_000,
	/** Maximum number of re-deliveries after the first instruction */
	MAX_REDELIVERIES: 1,
} as const;

/**
 * Constants for sub-agent message queue.
 * Used by SubAgentMessageQueue to buffer messages for agents that haven't
 * completed initialization (status !== 'active') yet.
 */
export const SUB_AGENT_QUEUE_CONSTANTS = {
	/** Wait this long after an agent goes down before waking it for its queued messages (ms) */
	QUEUED_WAKE_DELAY_MS: 5_000,
	/** At most one such wake per agent in this window, so a crashing agent is not relaunched in a loop (ms) */
	QUEUED_WAKE_COOLDOWN_MS: 10 * 60 * 1000,
	/** Maximum messages per agent before dropping oldest */
	MAX_QUEUE_SIZE: 50,
	/** Delay between flushed messages on registration (ms) */
	FLUSH_INTER_MESSAGE_DELAY: 2000,
	/**
	 * Oldest a restored message may be before it is dropped on load.
	 *
	 * The queue survives a restart now, but a message from days ago is
	 * worse than no message: the person has moved on, and delivering it
	 * would have an agent answer something nobody is waiting for.
	 */
	MAX_AGE_MS: 6 * 60 * 60 * 1000,
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
 * Message prefix `@slack/web-api` puts on every Slack platform error
 * (`platformErrorFromResult`), e.g. "An API error occurred: invalid_auth".
 * Used to recognise a rejection that came out of the Slack SDK rather than
 * from Crewly's own code.
 */
export const SLACK_PLATFORM_ERROR_PREFIX = 'An API error occurred:';

/**
 * Substrings of unhandled-rejection messages that the backend logs but
 * does NOT shut down for. Each entry is a rejection a third-party
 * integration library can raise on its own promise chain (no app frame
 * to catch it) and which must never take the whole process down.
 *
 * Anything not matched here still triggers the graceful shutdown, so a
 * genuinely unknown rejection is not silently swallowed.
 */
export const NON_FATAL_UNHANDLED_REJECTION_PATTERNS = [
	/** finity state machine inside @slack/socket-mode */
	'Unhandled event',
	/** transient network errors */
	'socket hang up',
	/** connection reset by peer */
	'ECONNRESET',
	/** any Slack platform error (invalid_auth, token_revoked, …) — Slack goes degraded, not the backend */
	SLACK_PLATFORM_ERROR_PREFIX,
] as const;

/**
 * Slack Socket Mode reconnection constants.
 * Controls automatic reconnection when network drops cause the WebSocket
 * to die and Bolt's built-in reconnect fails to recover.
 */
/**
 * Outbound reachability health (#753). Posts failing because the connected
 * bot cannot see the channel usually mean the wrong Slack app is connected
 * (self-hosted vs Crewly Cloud are different bot users), which leaves the
 * socket healthy while every reply is lost.
 */
export const SLACK_DELIVERY_HEALTH_CONSTANTS = {
	/** Slack error codes meaning "this bot cannot see that channel" */
	UNREACHABLE_ERROR_CODES: ['channel_not_found', 'not_in_channel'] as readonly string[],
	/** Consecutive unreachable posts (with no success in between) before status reports degraded */
	FAILURES_BEFORE_DEGRADED: 3,
	/** Distinct failing channel ids kept for the status payload */
	MAX_TRACKED_CHANNELS: 5,
} as const;

export const SLACK_RECONNECT_CONSTANTS = {
	/** Initial delay before first reconnection attempt (ms) */
	INITIAL_DELAY_MS: 2_000,
	/** Maximum delay between reconnection attempts (ms) */
	MAX_DELAY_MS: 60_000,
	/** Backoff multiplier applied after each failed attempt */
	BACKOFF_MULTIPLIER: 2,
	/** Maximum number of consecutive reconnection attempts before giving up (0 = unlimited) */
	MAX_ATTEMPTS: 50,
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
 * Message source identifiers for the queue processor.
 * Determines delivery strategy (timeouts, retry behavior).
 */
/**
 * What makes a `sender_type='user'` chat-v2 row count as the OWNER speaking
 * (commitment-approval gate, issues #730 / 2026-06-02 incident).
 *
 * Every surface that carries the owner's words to the orchestrator records
 * them as a `user` turn (Chat UI, legacy chat, Slack DM/thread/team channel,
 * WhatsApp, Telegram, Google Chat, portal/mobile relay). A few paths also
 * store text an AGENT wrote as a `user` turn, so it reaches colleagues the way
 * a human's message does; those rows carry one of the markers below and are
 * never owner evidence.
 */
export const OWNER_EVIDENCE_METADATA = {
	/** Local agent session that authored the row (agent-session API caller, cross-machine Slack post). */
	AUTHOR_AGENT_SESSION: 'authorAgentSession',
	/** Colleague agent on another machine whose Slack post was recorded here (slack-team-channel). */
	REMOTE_AGENT_SESSION: 'remoteAgentSession',
	/** `metadata.source` values that only agent replies carry — never an owner turn. */
	AGENT_REPLY_SOURCES: ['pty-runtime', 'in-process-runtime', 'reply-tool'],
} as const;

export const MESSAGE_SOURCES = {
	SLACK: 'slack',
	WHATSAPP: 'whatsapp',
	WEB_CHAT: 'web_chat',
	SYSTEM_EVENT: 'system_event',
	GOOGLE_CHAT: 'google_chat',
	TELEGRAM: 'telegram',
	CROSS_MACHINE: 'cross-machine',
	REMOTE: 'remote',
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
	/**
	 * Connection modes. `assistant` routes every incoming message to the
	 * orchestrator and auto-replies (the original bridge). `inbox` reads the
	 * owner's personal account, stores it locally and never sends anything
	 * without the owner's explicit confirmation.
	 */
	MODES: {
		ASSISTANT: 'assistant',
		INBOX: 'inbox',
	},
	/** Mode used by `POST /api/whatsapp/connect` when the body names none (owner decision) */
	DEFAULT_CONNECT_MODE: 'inbox',
	/**
	 * Mode for the legacy `WHATSAPP_ENABLED=true` env path when neither
	 * `WHATSAPP_MODE` nor a persisted connection names one — that path has
	 * always meant the orchestrator assistant.
	 */
	LEGACY_ENV_MODE: 'assistant',
	/** Data directory under the Crewly home (`~/.crewly/whatsapp/`) */
	DATA_DIR: 'whatsapp',
	/** SQLite file holding the inbox (chats, messages, drafts) */
	INBOX_DB_FILE: 'inbox.db',
	/** Persisted connection config (mode, allowed contacts, auto-connect) */
	CONNECTION_CONFIG_FILE: 'connection.json',
	/** Group chat JID suffix */
	GROUP_JID_SUFFIX: '@g.us',
	/** Phone-number user JID suffix */
	USER_JID_SUFFIX: '@s.whatsapp.net',
	/** Linked-identity (LID) JID suffix used by newer WhatsApp addressing */
	LID_JID_SUFFIX: '@lid',
	/** Pseudo-chat carrying status/stories — never part of the inbox */
	STATUS_BROADCAST_JID: 'status@broadcast',
	/** Baileys `messages.upsert` types: live (`notify`) and own/backfilled (`append`) */
	UPSERT_TYPES: {
		NOTIFY: 'notify',
		APPEND: 'append',
	},
	/** Baileys `HistorySync.HistorySyncType.FULL` — the whole account history, skipped in inbox mode */
	HISTORY_SYNC_TYPE_FULL: 2,
	/** History-sync messages older than this are not stored (inbox seeds recent history only) */
	HISTORY_SYNC_MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000,
	/** Stored message kinds */
	MESSAGE_KINDS: {
		TEXT: 'text',
		IMAGE: 'image',
		DOCUMENT: 'document',
		AUDIO: 'audio',
		VIDEO: 'video',
		STICKER: 'sticker',
		OTHER: 'other',
	},
	/** Chat-name provenance, higher wins: pushName < chat/group subject < address-book name */
	NAME_RANKS: {
		NONE: 0,
		PUSH_NAME: 1,
		CHAT: 2,
		CONTACT: 3,
	},
	/** Row caps for the read API: default and hard maximum per endpoint */
	LIMITS: {
		INBOX_DEFAULT: 20,
		INBOX_MAX: 200,
		CHATS_DEFAULT: 50,
		CHATS_MAX: 500,
		MESSAGES_DEFAULT: 50,
		MESSAGES_MAX: 500,
		SEARCH_DEFAULT: 20,
		SEARCH_MAX: 200,
		DRAFTS_DEFAULT: 100,
		DRAFTS_MAX: 500,
	},
	/** Prefix of the short human draft code (`W12`) */
	DRAFT_CODE_PREFIX: 'W',
	/** Draft lifecycle. `sending` is the claim held while the socket call is in flight */
	DRAFT_STATUSES: {
		PENDING: 'pending',
		SENDING: 'sending',
		SENT: 'sent',
		DISCARDED: 'discarded',
	},
	/**
	 * How long after a draft is written an agent may send it on the strength of
	 * the owner's 「发 W12」 chat message. After this the owner must send it from
	 * the dashboard, or the agent drafts again.
	 */
	DRAFT_CONFIRM_WINDOW_MS: 30 * 60 * 1000,
	/**
	 * Owner confirmation message: 「发 W12」 / 「发送 12」 / "send #W12" / 「确认发送 W12」.
	 * Group 2 is the draft code (with or without the W).
	 */
	DRAFT_CONFIRM_PATTERN: /^(发|发送|send|确认发送?)\s*#?(W?\d+)\s*$/i,
	/** Owner messages scanned for a confirmation (newest first) */
	OWNER_CONFIRM_SCAN_LIMIT: 200,
	/** Error codes returned by the inbox API */
	ERROR_CODES: {
		NEEDS_OWNER_CONFIRMATION: 'needs_owner_confirmation',
		AGENT_SEND_FORBIDDEN: 'agent_send_forbidden_in_inbox_mode',
		DRAFT_NOT_FOUND: 'draft_not_found',
		DRAFT_NOT_PENDING: 'draft_not_pending',
		CHAT_NOT_FOUND: 'chat_not_found',
		NOT_CONNECTED: 'not_connected',
		SEND_FAILED: 'send_failed',
		INVALID_MODE: 'invalid_mode',
		INVALID_INPUT: 'invalid_input',
	},
} as const;

/** WhatsApp connection mode (see {@link WHATSAPP_CONSTANTS.MODES}) */
export type WhatsAppMode = (typeof WHATSAPP_CONSTANTS.MODES)[keyof typeof WHATSAPP_CONSTANTS.MODES];

/** Google OAuth endpoint URLs and default scopes. */
export const GOOGLE_OAUTH_CONSTANTS = {
	AUTH_BASE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
	TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
	USERINFO_ENDPOINT: 'https://www.googleapis.com/oauth2/v2/userinfo',
	/**
	 * Default OAuth scopes requested by the standalone /api/oauth/google flow.
	 *
	 * `gmail.modify` is a Google-side functional superset that covers
	 * `gmail.readonly`, `gmail.send`, and label/state mutations. Declaring
	 * the single most-capable Gmail scope here means new credentials issued
	 * via this flow can drive all 9 actions of the agent `gmail` skill on
	 * one OAuth grant — no re-auth required when an agent moves from
	 * read-only to send to label management.
	 */
	DEFAULT_SCOPES: [
		'openid',
		'email',
		'https://www.googleapis.com/auth/gmail.modify',
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
 * Google Workspace (Gmail + Calendar) via Crewly Cloud.
 *
 * Cloud holds the OAuth grant (`/api/cloud/google/workspace/*`); the OSS
 * instance fetches a short-lived access token from Cloud and talks to
 * Google directly so mail content never passes through Cloud.
 */
/**
 * Google products a Crewly install connects independently.
 *
 * Consent is per product so a user who wants Calendar is not asked for their
 * whole mailbox, and so an install that never touches mail or files stays out
 * of Google's *restricted* scope tier (which requires a CASA security
 * assessment to verify). `drive` covers Docs, Sheets and Slides — those APIs
 * read through `drive.readonly` and write through `drive.file`.
 */
export const GOOGLE_PRODUCTS = ['gmail', 'calendar', 'drive'] as const;

/** One of {@link GOOGLE_PRODUCTS}. */
export type GoogleProduct = (typeof GOOGLE_PRODUCTS)[number];

export const GOOGLE_WORKSPACE_CONSTANTS = {
	/** Cloud API prefix for the Workspace grant (appended to the cloud URL) */
	CLOUD_PATH: '/api/cloud/google/workspace',
	/** Cloud sub-paths under CLOUD_PATH */
	CLOUD_ENDPOINTS: {
		/** GET → { connected, connections[], email, scopes, grantedAt } */
		STATUS: '/status',
		/** GET ?email=&product= → { accessToken, expiresAt, scopes, email, products } */
		TOKEN: '/token',
		/** GET ?token=&returnUrl=&products=&loginHint= → 302 to Google consent */
		START: '/start',
		/**
		 * POST { products, slackUserId, slackChannelId, slackThreadTs } →
		 * `{ url, expiresAt }`.
		 *
		 * The URL behind a Slack card's button. Unlike {@link START} it
		 * carries a single-use ticket rather than the Cloud session token,
		 * because a message in a channel must not contain a credential.
		 */
		CONNECT_TICKET: '/connect-ticket',
		/** POST { email } → { updated }; choose the account used when none is named */
		DEFAULT: '/default',
		/** DELETE CLOUD_PATH itself, optional ?email= → { removed } */
		DISCONNECT: '',
	},
	/** Re-fetch the access token this long before Cloud's `expiresAt` (ms) */
	TOKEN_REFRESH_MARGIN_MS: 60_000,
	/** HTTP timeout for Cloud and Google calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
	/** Gmail REST base for the signed-in user */
	GMAIL_API_BASE: 'https://gmail.googleapis.com/gmail/v1/users/me',
	/** Calendar REST base */
	CALENDAR_API_BASE: 'https://www.googleapis.com/calendar/v3',
	/** Default / ceiling for Gmail search results per call */
	GMAIL_DEFAULT_MAX_RESULTS: 20,
	GMAIL_MAX_RESULTS_CEILING: 100,
	/** Default / ceiling for Calendar list results per call */
	CALENDAR_DEFAULT_MAX_RESULTS: 50,
	CALENDAR_MAX_RESULTS_CEILING: 250,
	/** Calendar used when the caller names none */
	DEFAULT_CALENDAR_ID: 'primary',
	/** Drive REST base (metadata / search / export) */
	DRIVE_API_BASE: 'https://www.googleapis.com/drive/v3',
	/** Drive upload base (multipart create) */
	DRIVE_UPLOAD_BASE: 'https://www.googleapis.com/upload/drive/v3',
	/** Docs REST base */
	DOCS_API_BASE: 'https://docs.googleapis.com/v1',
	/** Sheets REST base */
	SHEETS_API_BASE: 'https://sheets.googleapis.com/v4',
	/** Slides REST base */
	SLIDES_API_BASE: 'https://slides.googleapis.com/v1',
	/** Default / ceiling for Drive search results per call */
	DRIVE_DEFAULT_MAX_RESULTS: 20,
	DRIVE_MAX_RESULTS_CEILING: 100,
	/** Largest file body read into memory for `drive read` / `drive upload` (bytes) */
	DRIVE_MAX_CONTENT_BYTES: 10 * 1024 * 1024,
	/** Google-native MIME types and what they export to as text */
	DRIVE_EXPORT_MIME: {
		'application/vnd.google-apps.document': 'text/plain',
		'application/vnd.google-apps.spreadsheet': 'text/csv',
		'application/vnd.google-apps.presentation': 'text/plain',
	} as Record<string, string>,
	/** Sheets range used when the caller names none */
	SHEETS_DEFAULT_RANGE: 'A1:Z1000',
	/** Cap on rows accepted per Sheets write */
	SHEETS_MAX_ROWS: 5000,
	/** Cap on slides per Slides create */
	SLIDES_MAX_SLIDES: 60,
	/** Dashboard path the Cloud consent flow returns to */
	SETTINGS_RETURN_PATH: '/connections?platform=google-workspace',
	/** Metadata headers requested on Gmail search hits */
	GMAIL_SEARCH_HEADERS: ['From', 'To', 'Subject', 'Date'],
	/** RFC 2045 line width for base64 message bodies */
	MIME_LINE_WIDTH: 76,
	/** Error codes shared between the token service, controller and skills */
	ERROR_CODES: {
		/** Not signed in to Crewly Cloud at all */
		NOT_LOGGED_IN: 'not_logged_in',
		/** Cloud has no Workspace grant for this account (or it was revoked) */
		NOT_CONNECTED: 'not_connected',
		/** Cloud is not configured with a Google client */
		NOT_CONFIGURED: 'not_configured',
		/** Google answered Cloud (or us) with an error */
		GOOGLE_ERROR: 'google_error',
		/** Cloud or Google unreachable */
		NETWORK: 'network',
		/** Caller sent an invalid request */
		VALIDATION: 'validation',
	},
} as const;

/**
 * Canva Connect on the owner's account — Cloud holds the grant (see
 * services/auth canva.service), this instance talks to api.canva.com.
 * Backs the canva-* skills.
 */
export const CANVA_CONSTANTS = {
	/** Cloud API prefix for the Canva grant (appended to the cloud URL) */
	CLOUD_PATH: '/api/cloud/canva',
	CLOUD_ENDPOINTS: {
		/** GET → { connected, canvaUserId, displayName, scopes, grantedAt } */
		STATUS: '/status',
		/** GET → { accessToken, expiresAt, scopes, canvaUserId, canvaTeamId?, displayName? } */
		TOKEN: '/token',
		/** GET ?token=&returnUrl= → 302 to Canva consent */
		START: '/start',
		/** DELETE CLOUD_PATH itself → { removed } */
		DISCONNECT: '',
	},
	/** Canva Connect REST base */
	API_BASE: 'https://api.canva.com/rest/v1',
	TOKEN_REFRESH_MARGIN_MS: 60_000,
	REQUEST_TIMEOUT_MS: 20_000,
	/** Default / ceiling for design listing per call */
	DESIGNS_DEFAULT_LIMIT: 25,
	DESIGNS_LIMIT_CEILING: 100,
	/** Export / upload jobs: poll cadence and ceiling */
	JOB_POLL_INTERVAL_MS: 1500,
	JOB_POLL_TIMEOUT_MS: 120_000,
	/** Largest asset accepted for upload (bytes) */
	ASSET_MAX_BYTES: 50 * 1024 * 1024,
	/** Preset design types Canva accepts for `design_type.type = preset` */
	PRESET_DESIGN_TYPES: ['doc', 'whiteboard', 'presentation'] as readonly string[],
	/** Export formats */
	EXPORT_FORMATS: ['pdf', 'png', 'jpg', 'pptx', 'gif', 'mp4'] as readonly string[],
	/** Dashboard path the Cloud consent flow returns to */
	SETTINGS_RETURN_PATH: '/connections?platform=canva',
	/** Error codes shared between the token service, controller and skills */
	ERROR_CODES: {
		NOT_LOGGED_IN: 'not_logged_in',
		NOT_CONNECTED: 'not_connected',
		NOT_CONFIGURED: 'not_configured',
		CANVA_ERROR: 'canva_error',
		NETWORK: 'network',
		VALIDATION: 'validation',
	},
} as const;

/**
 * Microsoft To Do on the owner's account — Cloud holds the grant (see
 * services/auth microsoft.service; the grant is keyed `microsoft` so Outlook
 * mail / calendar can reuse it later), this instance talks to Microsoft
 * Graph directly. Backs the todo-* skills.
 */
export const MICROSOFT_TODO_CONSTANTS = {
	/** Connector id (role allowlist key, frontend catalog id) */
	CONNECTOR_ID: 'microsoft-todo',
	/** Cloud API prefix for the Microsoft grant (appended to the cloud URL) */
	CLOUD_PATH: '/api/cloud/microsoft',
	CLOUD_ENDPOINTS: {
		/** GET → { connected, microsoftUserId, displayName, email, scopes, grantedAt } */
		STATUS: '/status',
		/** GET → { accessToken, expiresAt, scopes, microsoftUserId, displayName?, email? } */
		TOKEN: '/token',
		/** GET ?token=&returnUrl= → 302 to Microsoft consent */
		START: '/start',
		/** DELETE CLOUD_PATH itself → { removed } */
		DISCONNECT: '',
	},
	/** Microsoft Graph v1.0 base */
	GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
	TOKEN_REFRESH_MARGIN_MS: 60_000,
	REQUEST_TIMEOUT_MS: 20_000,
	/** Default / ceiling for tasks listed per call (`$top`) */
	TASKS_DEFAULT_LIMIT: 50,
	TASKS_LIMIT_CEILING: 100,
	/** Longest `Retry-After` (s) a 429 is waited out in-process before it is returned */
	RETRY_AFTER_MAX_WAIT_S: 10,
	/** Task / list title cap (characters) */
	TITLE_MAX_LENGTH: 255,
	/** Task note cap (characters) */
	NOTE_MAX_LENGTH: 4000,
	/** Note text shown per task in list output (characters) */
	NOTE_PREVIEW_LENGTH: 200,
	/** Accepted `importance` values */
	IMPORTANCE_VALUES: ['low', 'normal', 'high'] as readonly string[],
	/**
	 * Time zone written with a due date. To Do stores due *dates*; midnight
	 * in UTC is what Microsoft's own samples send and reads back unchanged.
	 */
	DUE_TIME_ZONE: 'UTC',
	/** `wellknownListName` of the list that answers when no list is named */
	DEFAULT_LIST_WELLKNOWN: 'defaultList',
	/** Dashboard path the Cloud consent flow returns to */
	SETTINGS_RETURN_PATH: '/connections?platform=microsoft-todo',
	/** Error codes shared between the token service, controller and skills */
	ERROR_CODES: {
		NOT_LOGGED_IN: 'not_logged_in',
		NOT_CONNECTED: 'not_connected',
		NOT_CONFIGURED: 'not_configured',
		/** Graph rejected the token even after a fresh one */
		UNAUTHORIZED: 'unauthorized',
		/** Graph 403 — no access (e.g. account without an Exchange Online mailbox) */
		FORBIDDEN: 'forbidden',
		/** List or task not found */
		NOT_FOUND: 'not_found',
		/** Graph 429 with a `Retry-After` beyond what we wait out */
		RATE_LIMITED: 'rate_limited',
		MICROSOFT_ERROR: 'microsoft_error',
		NETWORK: 'network',
		VALIDATION: 'validation',
	},
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
	/** Cloud Relay API endpoints (relative to cloudUrl) */
	RELAY_ENDPOINTS: {
		/** List all devices registered to the authenticated user */
		DEVICES: '/api/v1/relay/devices',
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
	/**
	 * Idle interval between message poll requests (ms). Used as the gap when
	 * long-poll is disabled (`MESSAGE_LONGPOLL_WAIT_MS = 0`), after a poll
	 * error, or as the auto-degrade fallback when the relay returns a held
	 * long-poll near-instantly (i.e. it doesn't support `wait=`).
	 */
	MESSAGE_POLL_INTERVAL_MS: 5_000,
	/**
	 * A message-poll cycle that hasn't finished for this long is stuck; the
	 * heartbeat restarts the loop (see CloudSyncService.checkMessagePollAlive).
	 * Comfortably above MESSAGE_LONGPOLL_TIMEOUT_MS.
	 */
	MESSAGE_POLL_STALL_MS: 90_000,
	/**
	 * Long-poll hold time (ms) sent to the relay as `?wait=`. The relay holds
	 * `/queue/poll` open until a message arrives (or this deadline), so the OSS
	 * picks up Portal `chat_request`s near-instantly instead of on the old 5s
	 * tick. Set to 0 to disable and fall back to fixed-interval polling. Kept
	 * under the relay's own 25s ceiling.
	 */
	MESSAGE_LONGPOLL_WAIT_MS: 20_000,
	/**
	 * HTTP request timeout (ms) for the long-poll message fetch. MUST exceed
	 * {@link MESSAGE_LONGPOLL_WAIT_MS} so the client doesn't abort the held
	 * connection before the relay's deadline returns it.
	 */
	MESSAGE_LONGPOLL_TIMEOUT_MS: 30_000,
	/** Gap (ms) before re-opening the next long-poll after one returns. */
	MESSAGE_LONGPOLL_GAP_MS: 100,
	/** Interval between device list poll requests (ms) */
	DEVICE_POLL_INTERVAL_MS: 30_000,
	/**
	 * Interval between queue/register re-registrations (ms).
	 *
	 * The relay's auto-pair only matches devices in `pairingWait`. If a
	 * Portal that was paired with this OSS closes uncleanly (closed tab,
	 * hard crash), the relay leaves OSS wedged `state: paired` against
	 * the dead session — and every fresh Portal that registers afterward
	 * joins pairingWait alone with no peer to match. The relay's
	 * register-time stale-pair eviction frees us, but only on the next
	 * register. We re-register on this interval so recovery is bounded.
	 */
	REGISTER_INTERVAL_MS: 60_000,
	/** Device considered offline after this threshold (ms) */
	OFFLINE_THRESHOLD_MS: 60_000,
	/** HTTP request timeout for sync API calls (ms) */
	REQUEST_TIMEOUT_MS: 15_000,
	/** Maximum consecutive failures before entering error state */
	MAX_CONSECUTIVE_FAILURES: 10,
	/** Interval between error recovery attempts after entering error state (ms).
	 *  Periodically retries a heartbeat to check if Cloud is reachable again. */
	ERROR_RECOVERY_INTERVAL_MS: 60_000,
	/** Maximum error recovery attempts before entering auth_expired terminal state */
	MAX_ERROR_RECOVERY_ATTEMPTS: 5,
	/** Cloud Sync API endpoints (relative to cloudUrl) — must match web project routes at /api/v1/relay/* */
	ENDPOINTS: {
		/** Device heartbeat/handshake — POST to Cloud Relay (registers device + updates metadata) */
		HEARTBEAT: '/api/v1/relay/handshake',
		/** List all devices for account (auto-registers caller on GET) */
		DEVICES: '/api/v1/relay/devices',
		/** Send a message to another device via Cloud message queue */
		MESSAGES: '/api/v1/relay/queue/send',
		/** Poll for incoming messages (GET with ?queueId= or uses JWT deviceId) */
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

/**
 * Agent self-improvement wiring (attention / self-model / prediction
 * calibration / memory consolidation). The four services under
 * `services/ai/self-improvement/` were built and tested but never consumed;
 * these constants govern the API, the daily consolidation cadence, and the
 * bounded prompt injection that finally puts them to work.
 */
export const SELF_IMPROVEMENT_CONSTANTS = {
	/** State file (under CREWLY_HOME) recording the last consolidation sweep */
	STATE_FILE: 'self-improvement-state.json',
	/** How often the consolidation sweep runs (24 h) */
	CONSOLIDATION_INTERVAL_MS: 24 * 60 * 60 * 1000,
	/** Env override for the consolidation interval (positive integer ms) */
	CONSOLIDATION_INTERVAL_ENV: 'CREWLY_SELF_IMPROVEMENT_INTERVAL_MS',
	/** Delay before the boot-time catch-up run so startup I/O settles first */
	BOOT_RUN_DELAY_MS: 60 * 1000,
	/** Prompt injection caps — keep the self-model card small and stable */
	PROMPT: {
		/** Max focus items rendered in the prompt */
		MAX_FOCUS_ITEMS: 5,
		/** Max suppressed topics rendered in the prompt */
		MAX_SUPPRESSED_ITEMS: 5,
		/** Max consolidation insights rendered in the prompt */
		MAX_INSIGHTS: 3,
		/** Hard character ceiling for the whole self-model section */
		MAX_CHARS: 600,
		/** Calibration below this → "you are overconfident" guidance */
		LOW_CALIBRATION: 0.5,
		/** Calibration at/above this → "well calibrated" guidance */
		HIGH_CALIBRATION: 0.8,
	},
	/** Outcome keywords that resolve a prediction without an explicit `accurate` flag */
	OUTCOME_KEYWORDS: {
		ACCURATE: ['correct', 'accurate', 'true', 'yes', 'confirmed', 'right'],
		INACCURATE: ['incorrect', 'inaccurate', 'false', 'no', 'wrong', 'missed'],
	},
} as const;

/**
 * Ticket loop (specs/ticket-loop.md, Phase 1): owner messages become tickets
 * (a `Request` with a TKT number), receipts go back where the owner spoke,
 * and WorkItems link back to the ticket.
 */
export const TICKET_CONSTANTS = {
	/** Display prefix: `TKT-042` */
	NUMBER_PREFIX: 'TKT-',
	/** Minimum digits in a displayed ticket number (zero-padded) */
	NUMBER_PAD: 3,
	/** Counter file inside the requests dir (no `.json`, so listAll never reads it) */
	COUNTER_FILENAME: '.ticket-counter',
	/** Tag every ticket carries */
	TAG: 'ticket',
	/** Tag added when the owner said "don't track" */
	DISMISSED_TAG: 'dismissed',
	/**
	 * Weighted minimum length a message needs to be a ticket. CJK characters
	 * count double: "fix the build" (13) passes, and so does "把首页改成蓝色"
	 * (7 CJK = 14), while "好的收到" (8) does not.
	 */
	MIN_WEIGHTED_TEXT_LENGTH: 12,
	/** A bare "don't track" reply dismisses the ticket it answers */
	DISMISS_PATTERN: /^\s*(不用记|别记|不用记录|不要记|取消记录|don'?t track|do not track|no ticket)\s*[。.!！]*\s*$/i,
	/**
	 * A top-level "不用记" (no thread) dismisses the latest open ticket from the
	 * same conversation if it was opened this recently (ms).
	 */
	DISMISS_LOOKBACK_MS: 30 * 60 * 1000,
	/** How long a caller waits for intake before delivering without a marker (ms) */
	INTAKE_TIMEOUT_MS: 3_000,
	/** Slack Block Kit action id of the receipt's dismiss button */
	SLACK_DISMISS_ACTION_ID: 'ticket_dismiss',
	/** Receipt texts */
	RECEIPT: {
		RECORDED: (tkt: string) => `已记成 ${tkt}`,
		DISMISSED: (tkt: string) => `${tkt} 已取消记录`,
		/** chat-v2 receipt once the ticket is accepted */
		DONE: (tkt: string) => `${tkt} 已完成`,
		/** Slack receipt: this reaction on the owner's message (no reply, no notification) */
		REACTION: 'ticket',
		/** Slack: the 🎫 becomes this once the ticket is accepted */
		DONE_REACTION: 'white_check_mark',
		/**
		 * Receipts are off (owner, 2026-09-24): tickets are Crewly's own record
		 * of the work — no 🎫 / ✅ / 「已记成 TKT-…」 in the owner's conversations.
		 */
		ENABLED: false,
	},
	/** Done / cancelled tickets leave the board after this long (Phase 3) */
	ARCHIVE: {
		AFTER_MS: 30 * 24 * 60 * 60 * 1000,
		/** Subdirectory of the requests dir the files move to (never deleted) */
		DIRNAME: 'archive',
	},
	/**
	 * Review (Phase 2): an agent's answer puts a ticket in 待验收; the owner
	 * accepts (验过了) or sends it back (打回 + reason). Silence accepts.
	 */
	REVIEW: {
		/** Origins whose tickets close without the owner (cron, missions) */
		NO_REVIEW_ORIGINS: ['cron', 'mission'] as readonly string[],
		/** Tag on a ticket that closed because nobody objected in time */
		AUTO_ACCEPTED_TAG: 'auto_accepted',
		/** 待验收 this long with no word from the owner → accepted (ms) */
		AUTO_ACCEPT_MS: 72 * 60 * 60 * 1000,
		/**
		 * The agent that answered asks the owner itself (owner, 2026-09-24):
		 * with no word from the owner this long after the answer (or the last
		 * nudge), the agent is nudged to follow up once more in the thread.
		 */
		NUDGE_AFTER_MS: 24 * 60 * 60 * 1000,
		/** Nudges before silence counts as acceptance */
		MAX_NUDGES: 2,
		/**
		 * A plain acknowledgement from the owner in a ticket's thread while the
		 * agent is waiting for their OK counts as the OK (「好的」「可以」「行」).
		 */
		ACK_PATTERN: /^\s*(好的?|好滴|行|可以|可以的|ok|okay|okk|收到|嗯+|对|没问题|谢谢|thanks?|thx|👍|✅|nice|great|perfect)\s*[。.!！~～👍✅]*\s*$/iu,
		/** An agent reply must be this old, with the agent idle, before it counts as the answer (ms) */
		SUBMIT_SETTLE_MS: 60 * 1000,
		/** Sweep for settled answers and auto-accepts (ms) */
		SWEEP_INTERVAL_MS: 2 * 60 * 1000,
		/** Longest excerpt of the answer kept on the ticket */
		REPLY_EXCERPT_MAX: 600,
		/** 「验过了」 and friends — a bare accept in the ticket's thread */
		VERIFY_PATTERN: /^\s*(验过了|验收通过|验收了|通过了?|没问题了?|可以了|lgtm|looks good|accept(ed)?|approved?)\s*[。.!！~～👍✅]*\s*$/i,
		/** 「打回 <reason>」 — send it back; group 2 is the reason */
		REJECT_PATTERN: /^\s*(打回|退回|重做|不通过|reject(ed)?|redo)\s*[:：,，。.\-—]*\s*([\s\S]*)$/i,
		/** Reason recorded when 打回 came without one */
		REJECT_NO_REASON: '（未写原因）',
		/** WorkItem title for a rework sent from the board */
		REWORK_TITLE: (tkt: string) => `打回 ${tkt}`,
	},
	/** Metadata key the dispatcher reads the delivered-message marker from */
	MESSAGE_MARKER_METADATA_KEY: 'ticketMarker',
	/** Metadata key on a chat-v2 receipt row */
	RECEIPT_METADATA_KEY: 'ticketReceipt',
	/** Header a client may send to say it is the mobile app */
	CLIENT_HEADER: 'x-crewly-client',
	/** {@link CLIENT_HEADER} value sent by the mobile app / mobile relay */
	MOBILE_CLIENT: 'mobile',
} as const;

/**
 * One-time task-pool archive run by the ticket loop (specs/ticket-loop.md §4).
 */
export const POOL_ARCHIVE_CONSTANTS = {
	/** Marker file in the task-pool dir; present = migration already ran */
	MARKER_FILENAME: '.archived-2026-09-ticket-loop',
	/** Archive dir inside the task-pool dir */
	ARCHIVE_DIRNAME: 'archive',
	/** Archive file name prefix; the date (YYYY-MM-DD) and `.json` follow */
	ARCHIVE_FILE_PREFIX: 'pool-archive-',
	/** Items older than this are eligible (ms) */
	MIN_AGE_MS: 7 * 24 * 60 * 60 * 1000,
	/** Terminal statuses that are archived once old enough */
	TERMINAL_STATUSES: ['verified', 'done', 'failed', 'cancelled'],
} as const;

/**
 * Harness onboarding (specs/onboarding-harness-login.md): detect, install and
 * log in to the agent CLIs ("harnesses") Crewly drives — Claude Code, Codex
 * and Gemini CLI. Shared by the backend REST API and the `crewly` CLI.
 */
export const HARNESS_CONSTANTS = {
	/** Harness ids; equal to the matching RUNTIME_TYPES values */
	IDS: {
		CLAUDE_CODE: 'claude-code',
		CODEX_CLI: 'codex-cli',
		GEMINI_CLI: 'gemini-cli',
	},
	/** Harness the orchestrator uses when the owner does not choose */
	DEFAULT_ORC_HARNESS: 'claude-code',
	/** Short names accepted by `crewly login <name>` / `--harness <name>` */
	CLI_ALIASES: {
		claude: 'claude-code',
		codex: 'codex-cli',
		gemini: 'gemini-cli',
	},
	/** Credentials file under the Crewly home dir */
	CREDENTIALS_FILE: 'harness-credentials.json',
	/** File mode for the credentials file (owner read/write only) */
	CREDENTIALS_FILE_MODE: 0o600,
	/** User-owned npm prefix under the Crewly home dir, used when `npm install -g` hits EACCES */
	USER_NPM_PREFIX_DIR: 'npm-global',
	/** Extra bin dir where Claude Code's native installer puts `claude` (relative to $HOME) */
	NATIVE_INSTALLER_BIN_DIR: '.local/bin',
	/** How long `npm view <pkg> version` results are cached */
	LATEST_VERSION_CACHE_TTL_MS: 60 * 60 * 1000,
	/** How long a failed `npm view` is cached (so an offline machine is not re-probed per request) */
	LATEST_VERSION_FAILURE_TTL_MS: 5 * 60 * 1000,
	/** Timeout for short probe commands (which, --version, login status) */
	PROBE_TIMEOUT_MS: 15_000,
	/** Timeout for `npm view` */
	NPM_VIEW_TIMEOUT_MS: 20_000,
	/** Timeout for one `npm install -g` attempt */
	INSTALL_TIMEOUT_MS: 10 * 60 * 1000,
	/** Install log kept per job (tail) */
	INSTALL_LOG_MAX_CHARS: 64_000,
	/** Finished install jobs are forgotten after this long */
	INSTALL_JOB_RETENTION_MS: 60 * 60 * 1000,
	/** npm output that means "no permission to write the global prefix" */
	PERMISSION_ERROR_PATTERNS: ['EACCES', 'EPERM', 'permission denied'] as readonly string[],
	/** Version-like token in `--version` output */
	VERSION_PATTERN: /\d+\.\d+\.\d+[\w.+-]*/,
	/** Length bounds for a pasted API key */
	API_KEY_MIN_LENGTH: 20,
	API_KEY_MAX_LENGTH: 512,
	/** Login broker (PTY running the harness's own login command) */
	LOGIN: {
		/** A login session that has not finished by then is timed out */
		TIMEOUT_MS: 15 * 60 * 1000,
		/** Very wide PTY so login URLs are not wrapped at the terminal width */
		PTY_COLS: 1000,
		PTY_ROWS: 50,
		/** Tail of normalized screen text exposed to front ends */
		SCREEN_MAX_CHARS: 2000,
		/** Raw PTY output kept per session (tail) */
		RAW_BUFFER_MAX_CHARS: 200_000,
		/** Finished sessions stay readable for this long */
		SESSION_RETENTION_MS: 60 * 60 * 1000,
		/** Timeout for the post-login verification command */
		VERIFY_TIMEOUT_MS: 30_000,
		/** Value for BROWSER in the broker env: a no-op command, so harnesses do not open a browser */
		BROWSER_SUPPRESS_VALUE: 'true',
		/** Replaces anything that looks like a token or key in exposed screen text */
		REDACTED: '[redacted]',
		/** A line that is a piece of a captured secret is redacted when at least this long */
		REDACT_MIN_FRAGMENT: 8,
		/** A URL line at least this long that ends at end-of-line may continue on the next line */
		WRAPPED_LINE_MIN_LENGTH: 40,
		/** Keys typed after user input */
		ENTER: '\r',
	},
	/**
	 * Re-login over Slack (Phase 2): an expired harness login is noticed in
	 * agent output or by a periodic status check, a broker login is started
	 * and the owner finishes it from their phone.
	 */
	RELOGIN: {
		/** At most one owner reminder per harness in this window while the owner has not acted */
		REMIND_INTERVAL_MS: 3 * 60 * 60 * 1000,
		/** How often the orchestrator's harness login state is checked */
		STATUS_CHECK_INTERVAL_MS: 10 * 60 * 1000,
		/** A broker screen with no URL, code or prompt after this long is sent to the owner as-is */
		UNRECOGNISED_SCREEN_MS: 20_000,
		/** Expiry reports for a harness are ignored this long after its login succeeded (resumed transcripts repeat old errors) */
		POST_SUCCESS_QUIET_MS: 10 * 60 * 1000,
		/** A second expiry within this window after a silent API-key recovery falls back to the phone login */
		SILENT_KEY_RETRY_WINDOW_MS: 60 * 60 * 1000,
		/** Bounds for an owner reply that is taken as Claude's authorization code */
		CODE_MIN_LENGTH: 16,
		CODE_MAX_LENGTH: 512,
		/** Longest reply typed into an unrecognised login screen */
		SCREEN_REPLY_MAX_LENGTH: 512,
		/** Owner replies that start the login over (compared trimmed, case-insensitive) */
		RETRY_KEYWORDS: ['relogin', 're-login', '重新登录'] as readonly string[],
		/** Tail of the (redacted) login screen included in a DM */
		DM_SCREEN_MAX_CHARS: 1500,
		/** Longest broker message quoted in a DM */
		DM_MESSAGE_MAX_CHARS: 300,
		/** Waiting agents named in a DM; the rest are counted */
		DM_MAX_LISTED_AGENTS: 8,
	},
	/** Claude Code facts */
	CLAUDE: {
		OAUTH_TOKEN_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
		API_KEY_ENV: 'ANTHROPIC_API_KEY',
		CONFIG_DIR_ENV: 'CLAUDE_CONFIG_DIR',
		/** `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) */
		CONFIG_FILE: '.claude.json',
		DATA_DIR: '.claude',
		CREDENTIALS_FILE: '.credentials.json',
		/** macOS keychain item Claude Code stores its login under */
		KEYCHAIN_SERVICE: 'Claude Code-credentials',
		/** Claude Code approves a custom API key by its last N characters */
		API_KEY_APPROVAL_SUFFIX_LENGTH: 20,
		API_KEY_PREFIX: 'sk-ant-',
		/** Endpoint used to check a pasted Anthropic API key */
		API_KEY_CHECK_URL: 'https://api.anthropic.com/v1/models',
		API_VERSION: '2023-06-01',
		API_KEY_CHECK_TIMEOUT_MS: 10_000,
	},
	/** Codex CLI facts */
	CODEX: {
		HOME_ENV: 'CODEX_HOME',
		HOME_DIR: '.codex',
		AUTH_FILE: 'auth.json',
	},
	/** Gemini CLI facts (detect only) */
	GEMINI: {
		OAUTH_CREDS_FILE: '.gemini/oauth_creds.json',
		KEY_ENV: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] as readonly string[],
	},
	/** System tools Crewly needs (tmux is not one: sessions use node-pty) */
	SYSTEM_TOOLS: {
		JQ: {
			ID: 'jq',
			INSTALL_HINT_MACOS: 'brew install jq',
			INSTALL_HINT_LINUX: 'sudo apt-get install -y jq   (Fedora: sudo dnf install -y jq)',
		},
	},
	/** Orchestrator config under the Crewly home dir (same file StorageService uses) */
	ORCHESTRATOR_CONFIG_SEGMENTS: ['teams', 'orchestrator', 'config.json'] as readonly string[],
	/** Web setup page opened by `crewly onboard --web` */
	WEB_SETUP_PATH: '/setup',
} as const;

/**
 * First-run checklist and starter teams (specs/onboarding-harness-login.md,
 * Phase 3): harness → first team → first task → Cloud → Slack.
 */
export const ONBOARDING_CONSTANTS = {
	/** Checklist state (dismissed flag, blank choice, first-task record) under the Crewly home dir */
	STATE_FILE: 'onboarding.json',
	/** Checklist step ids, in display order */
	STEP_IDS: {
		HARNESS: 'harness',
		TEAM: 'team',
		FIRST_TASK: 'first_task',
		CLOUD: 'cloud',
		SLACK: 'slack',
	},
	STEP_ORDER: ['harness', 'team', 'first_task', 'cloud', 'slack'] as readonly string[],
	/** Starter id of "Blank": the orchestrator only, no team */
	BLANK_STARTER_ID: 'blank',
	/** Display copy for the Blank starter (templates carry their own) */
	BLANK_STARTER: {
		NAME: 'Blank',
		LABEL: '空白',
		TAGLINE: '只有 Orc（总调度），先不建团队。需要时让 Orc 帮你组队。',
		SUGGESTIONS: [
			'帮我想想：我每周重复做的事里，哪些可以交给 AI 团队？',
			'我想做一个小项目，先问我几个问题，再建议我需要什么样的团队。',
			'介绍一下你能做什么，给我 3 个今天就能开始的例子。',
		] as readonly string[],
	},
	/** Longest first task accepted */
	FIRST_TASK_MAX_LENGTH: 4000,
	/** First line of the message the orchestrator receives for a first task */
	FIRST_TASK_HEADER: '[初始设置 · 第一件事]',
	/** Chat metadata `source` of a first task sent from setup */
	FIRST_TASK_SOURCE: 'onboarding_first_task',
	/** Query parameter that opens `/setup` at a step (e.g. `/setup?step=cloud`) */
	WEB_STEP_QUERY: 'step',
	/** Crewly Cloud sign-in that works from a phone */
	CLOUD: {
		/** Cloud auth route that starts Google sign-in and redirects back with ?token=&refreshToken= */
		GOOGLE_START_PATH: '/api/cloud/google/start',
		/** Portal page that shows the token + refresh token for copy-paste */
		CLI_TOKEN_PATH: '/cloud/cli-token',
		/** The web app's callback page that hands the token to this backend */
		WEB_CALLBACK_PATH: '/auth/callback',
		/** Portal base URL (env: CLOUD_CONSOLE_URL) */
		get CONSOLE_URL(): string {
			return process.env['CLOUD_CONSOLE_URL'] || 'https://crewlyai.com';
		},
	},
} as const;

/**
 * Solution bundles: sellable team templates that deploy a whole working
 * setup in one step (specs/solution-bundles.md).
 */
export const BUNDLE_CONSTANTS = {
	/** The only manifest schema version this engine understands */
	SCHEMA_VERSION: 1,
	/** Deployment state per template, under the Crewly home dir */
	STATE_DIR: 'bundles',
	/** Key of the team built from the template's own `roles` */
	MAIN_TEAM_KEY: 'main',
	/** Joins template id and team key into the id of an extra team */
	TEAM_ID_SEPARATOR: '--',
	/** Extra template directories (path-delimited), e.g. Crewly Pro's config/templates */
	TEMPLATE_DIRS_ENV: 'CREWLY_TEMPLATE_DIRS',
	/** Bundle status that may be deployed without `allowDraft` */
	STATUS: { READY: 'ready', DRAFT: 'draft' },
	/** Apply steps, in the order they run */
	STEP_IDS: {
		TEAM: 'team',
		NORMS: 'norms',
		SKILLS: 'skills',
		CONNECTORS: 'connectors',
		SLACK: 'slack',
		SCHEDULES: 'schedules',
		FIRST_WEEK: 'first_week',
	},
	STEP_ORDER: ['team', 'norms', 'skills', 'connectors', 'slack', 'schedules', 'first_week'] as readonly string[],
	/** Owner-facing step labels */
	STEP_LABELS: {
		team: '建团队',
		norms: '写团队规范和 SOP',
		skills: '装技能',
		connectors: '检查要接的服务',
		slack: '建 Slack 频道',
		schedules: '排定时任务',
		first_week: '安排第一周的工作',
	} as Readonly<Record<string, string>>,
	/** Why a step is waiting (status `pending`) */
	PENDING_REASONS: {
		SLACK_NOT_CONNECTED: 'slack_not_connected',
		BACKEND_NOT_RUNNING: 'backend_not_running',
		CONNECTORS_MISSING: 'connectors_missing',
	},
	/** Why a step did not run (status `skipped`) */
	SKIP_REASONS: {
		TEAM_FAILED: 'team_failed',
		NOTHING_TO_DO: 'nothing_to_do',
	},
	/** Timezone of schedules and first-week tasks when the bundle names none */
	DEFAULT_TIMEZONE: 'Asia/Shanghai',
	/** Time of day a later first-week task is handed over when it names none */
	DEFAULT_FIRST_WEEK_TIME: '09:00',
	/** Last day (0-based) a first-week task may be scheduled on */
	MAX_FIRST_WEEK_DAY: 6,
	/** Chat metadata `source` of a first-week task */
	FIRST_WEEK_SOURCE: 'bundle_first_week',
	/** First line of a first-week task the orchestrator receives */
	FIRST_WEEK_HEADER: '[成套方案 · 第一周]',
	/** How often the backend delivers due first-week tasks and resumes waiting deployments */
	TICK_INTERVAL_MS: 5 * 60 * 1000,
	/** How often `crewly deploy-bundle` polls a running backend's job */
	CLI_POLL_INTERVAL_MS: 1500,
	/** How long `crewly deploy-bundle` waits for a running backend's job */
	CLI_JOB_TIMEOUT_MS: 10 * 60 * 1000,
	/** Owner-facing connections page; `?platform=<id>` opens a connector */
	CONNECTIONS_PATH: '/connections',
	/** Connector ids a bundle may require (the /connections cards) */
	CONNECTOR_IDS: ['google-workspace', 'canva', 'whatsapp', 'slack', 'microsoft-todo', 'telegram', 'discord', 'google-chat'] as readonly string[],
	/** Google products a bundle may name on `google-workspace` */
	GOOGLE_PRODUCTS: ['gmail', 'calendar', 'drive'] as readonly string[],
	/** Hosted server tiers (ops/marketing/2026-09-template-deploy/00-plan.md §3) */
	SERVER_TIERS: ['entry', 'standard', 'advanced'] as readonly string[],
	/** Placeholders the engine fills without a question */
	BUILTIN_PLACEHOLDERS: ['team_name', 'lead_name'] as readonly string[],
	/** Longest accepted answer */
	MAX_ANSWER_LENGTH: 2000,
	/** Joins a multi-select answer when it fills a placeholder */
	MULTISELECT_JOINER: '、',
	/** Norm written from the bundle's review points */
	REVIEW_POINTS_NORM_ID: 'owner-review-points',
	/** Norms / SOP folders inside a team directory (see get-team-norms, get-sops) */
	NORMS_DIR: 'norms',
	SOPS_DIR: 'sops',
	/** Default SOP category folder */
	DEFAULT_SOP_CATEGORY: 'team',
} as const;

/** License status type */
export type CloudLicenseStatus = (typeof CLOUD_AUTH_CONSTANTS.LICENSE_STATUS)[keyof typeof CLOUD_AUTH_CONSTANTS.LICENSE_STATUS];

/**
 * On-demand skill setup (specs/skill-auto-install.md).
 *
 * A skill's `skill.json` may declare a `setup` block (system commands, files
 * such as models, Python packages). The setup runner performs it idempotently;
 * `find-skill` / `install-skill` let an agent find and install an official
 * skill, with its dependencies, as a background job.
 */
export const SKILL_SETUP_CONSTANTS = {
	/** Directory under the Crewly home for setup state (locks) */
	STATE_DIR: 'skill-setup',
	/** Subdirectory of STATE_DIR holding one lock file per skill */
	LOCKS_SUBDIR: 'locks',
	/** Directory under the Crewly home for per-skill setup logs */
	LOG_DIR: 'logs/skill-setup',
	/** Directory under the Crewly home for Crewly-managed binaries (e.g. whisper-cli on Linux) */
	BIN_DIR: 'bin',
	/** Directory under the Crewly home for per-skill Python virtualenvs (`venv/<name>`) */
	VENV_DIR: 'venv',
	/** Directories always searched for commands, after the process PATH */
	EXTRA_COMMAND_DIRS: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
	/** Where Homebrew lives when it is not on PATH */
	BREW_CANDIDATES: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'],
	/** File whose presence marks a Debian-family Linux (apt-get available) */
	DEBIAN_MARKER_FILE: '/etc/debian_version',
	/** Timeout for a check command (`bash -c`, venv import probe) */
	CHECK_TIMEOUT_MS: 30_000,
	/** Timeout for one package-manager install (brew / apt-get / pip) */
	PACKAGE_INSTALL_TIMEOUT_MS: 30 * 60 * 1000,
	/** Timeout for a skill-provided install script (may build from source) */
	SCRIPT_INSTALL_TIMEOUT_MS: 45 * 60 * 1000,
	/** Abort a download that receives no bytes for this long */
	DOWNLOAD_STALL_TIMEOUT_MS: 2 * 60 * 1000,
	/** Log download progress every this many percent */
	DOWNLOAD_PROGRESS_STEP_PERCENT: 10,
	/** Extra free space required beyond a file's size before downloading it (fraction) */
	DOWNLOAD_FREE_SPACE_MARGIN: 0.1,
	/** How often a waiting setup re-checks another process's lock */
	LOCK_POLL_MS: 2_000,
	/** How long a setup waits for another process's lock before giving up */
	LOCK_WAIT_MS: 60 * 60 * 1000,
	/** A lock older than this is treated as abandoned even if its pid is alive (pid reuse) */
	LOCK_STALE_MS: 2 * 60 * 60 * 1000,
	/** Keep this many characters of output per install job (tail) */
	JOB_LOG_MAX_CHARS: 20_000,
	/** Forget finished install jobs after this long */
	JOB_RETENTION_MS: 24 * 60 * 60 * 1000,
	/** Minutes quoted to the user when a skill declares setup but no estimate */
	DEFAULT_ESTIMATED_MINUTES: 3,
	/** Maximum candidates `find-skill` returns */
	FIND_MAX_RESULTS: 8,
	/** Candidates whose setup state is probed (checks only) per `find-skill` call */
	FIND_PROBE_LIMIT: 3,
	/** Registry authors whose entries in an official registry count as official */
	OFFICIAL_AUTHORS: ['Crewly Team', 'crewly', 'Crewly'],
	/** How far back an owner "yes" counts for `--approved-by-owner` (ms) */
	OWNER_APPROVAL_LOOKBACK_MS: 2 * 60 * 60 * 1000,
	/** Chat conversation id used for install-completion system events */
	COMPLETION_CONVERSATION_ID: 'system',
	/** Header lines that open the completion message the requesting agent receives */
	COMPLETION_HEADERS: {
		SUCCEEDED: '[SKILL INSTALLED]',
		FAILED: '[SKILL INSTALL FAILED]',
	},
	/**
	 * Words that map a user's phrasing onto the vocabulary skills are tagged
	 * with, for `find-skill` ranking ("voice message" should find a
	 * transcription skill even though no skill is tagged "voice").
	 */
	QUERY_SYNONYMS: {
		voice: ['audio', 'speech', 'transcribe'],
		recording: ['audio', 'transcribe'],
		speech: ['audio', 'transcribe'],
		m4a: ['audio', 'transcribe'],
		mp3: ['audio', 'transcribe'],
		wav: ['audio', 'transcribe'],
		ogg: ['audio', 'transcribe'],
		aac: ['audio', 'transcribe'],
		opus: ['audio', 'transcribe'],
		mp4: ['video', 'audio', 'transcribe'],
		mov: ['video', 'audio', 'transcribe'],
		video: ['audio', 'transcribe'],
		transcript: ['transcribe'],
		transcription: ['transcribe'],
		dictation: ['audio', 'transcribe'],
		'语音': ['audio', 'transcribe'],
		'录音': ['audio', 'transcribe'],
		'转写': ['transcribe'],
		'转文字': ['transcribe'],
		'音频': ['audio'],
		'视频': ['video'],
		document: ['pdf'],
		'文档': ['pdf', 'document'],
		report: ['pdf'],
	} as Readonly<Record<string, readonly string[]>>,
} as const;

// Type helpers
export type AgentStatus =
	(typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES];
export type WorkingStatus =
	(typeof CREWLY_CONSTANTS.WORKING_STATUSES)[keyof typeof CREWLY_CONSTANTS.WORKING_STATUSES];
export type RuntimeType = (typeof RUNTIME_TYPES)[keyof typeof RUNTIME_TYPES];
export type AgentId = string; // Agent identifier type for heartbeat service
