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
  AUTO_UPDATE_CONSTANTS as CONFIG_AUTO_UPDATE_CONSTANTS,
  CLOUD_DISCONNECT_NOTICE_CONSTANTS as CONFIG_CLOUD_DISCONNECT_NOTICE_CONSTANTS,
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
  PROJECT_TICKET_CONSTANTS as CONFIG_PROJECT_TICKET_CONSTANTS,
} from '../../config/constants.js';

// Re-export the cross-domain constants for backend use
export const PROCESS_EXIT_CODES = CONFIG_PROCESS_EXIT_CODES;

/** Project tickets (specs/2026-09-28-project-tickets.md) — see config/constants.ts. */
export const PROJECT_TICKET_CONSTANTS = CONFIG_PROJECT_TICKET_CONSTANTS;

/**
 * Ticket autopilot (specs/2026-09-30-ticket-autopilot.md): a per-project switch
 * that wakes the project's driver (its team lead) to triage the backlog, with
 * brakes (one live triage, re-trigger cadence, daily budget) and phone-first
 * owner notifications (batched questions, one evening digest).
 */
export const TICKET_AUTOPILOT_CONSTANTS = {
	/** WorkItem type of the triage item the driver receives */
	TRIAGE_WORK_ITEM_TYPE: 'ticket_triage',
	/** `metadata.kind` of the triage item (also how a live one is found) */
	TRIAGE_METADATA_KIND: 'ticket_triage',
	/** Label a ticket carries while it waits on an answer from the owner */
	NEEDS_OWNER_LABEL: 'needs-owner',
	/** Log-line prefix holding the one-line question for the owner */
	OWNER_QUESTION_LOG_PREFIX: 'owner question: ',
	/** Max characters of an owner question */
	OWNER_QUESTION_MAX_CHARS: 280,
	/** How often the autopilot re-evaluates every enabled project (ms) */
	TICK_INTERVAL_MS: 5 * 60 * 1000,
	/** Re-trigger a triage for a project at most this often on the periodic tick (ms) */
	TRIAGE_MIN_INTERVAL_MS: 30 * 60 * 1000,
	/**
	 * A member going idle with nothing ready triggers a triage "immediately",
	 * but never sooner than this after the previous one (ms) — idle events
	 * repeat every few seconds and must not become a wake loop.
	 */
	IDLE_TRIGGER_MIN_INTERVAL_MS: 5 * 60 * 1000,
	/** A ticket already listed in a triage (and unchanged since) is listed again only after this long (ms) */
	TRIAGE_RELIST_AFTER_MS: 4 * 60 * 60 * 1000,
	/** A `ready` ticket untouched this long while someone is idle counts as "nobody takes it" (ms) */
	READY_STALE_MS: 24 * 60 * 60 * 1000,
	/** A triage item still queued (never picked up) after this long is cancelled and may be replaced (ms) */
	TRIAGE_STALE_QUEUED_MS: 6 * 60 * 60 * 1000,
	/** Max tickets listed in one triage brief (highest priority, then oldest first) */
	TRIAGE_MAX_TICKETS: 20,
	/** Max characters of a ticket description quoted in the triage brief */
	TRIAGE_DESCRIPTION_EXCERPT_CHARS: 300,
	/** Max characters of a member's role responsibility line in the triage brief */
	ROLE_RESPONSIBILITY_MAX_CHARS: 160,
	/**
	 * One-line responsibility of roles that ship without a `role.json`
	 * description (the brief falls back to these; a member's own
	 * `jobDescription` and a role's description win).
	 */
	ROLE_RESPONSIBILITY_FALLBACKS: {
		'tech-lead': 'Leads the team: technical decisions, review, delegation and owner communication',
		'team-leader': 'Leads the team: breaks goals down, delegates, reviews results and reports up',
		'content-strategist': 'Plans and writes content: articles, posts, copy and the images or visuals that go with them',
		researcher: 'Researches questions and sources, and writes up findings',
		'ux-designer': 'Designs user flows, wireframes and visual UI',
		'customer-support': 'Answers customer questions and troubleshoots their problems',
	} as Readonly<Record<string, string>>,
	/** Local hour (0-23) at or after which the daily digest is sent */
	DIGEST_HOUR_LOCAL: 21,
	/** Max tickets named per digest section (the rest are counted) */
	DIGEST_MAX_ITEMS_PER_SECTION: 8,
	/** Default daily budget (tokens) of the project's team agents when the owner sets none */
	DEFAULT_DAILY_BUDGET_TOKENS: 20_000_000,
	/** Default and bounds of in-progress tickets per member */
	DEFAULT_MAX_IN_FLIGHT_PER_MEMBER: 1,
	MAX_IN_FLIGHT_PER_MEMBER_LIMIT: 5,
	/** State file under CREWLY_HOME (debounce / notification bookkeeping, survives restarts) */
	STATE_FILENAME: 'ticket-autopilot-state.json',
	/** Env kill switch: `0` keeps the autopilot service from starting */
	ENV_SWITCH: 'CREWLY_TICKET_AUTOPILOT',
} as const;

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
export const AUTO_UPDATE_CONSTANTS = CONFIG_AUTO_UPDATE_CONSTANTS;
export const CLOUD_DISCONNECT_NOTICE_CONSTANTS = CONFIG_CLOUD_DISCONNECT_NOTICE_CONSTANTS;
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

/**
 * Checking a skill request's claimed agent identity against the process it
 * came from. Skills send `X-Agent-Session` (from CREWLY_SESSION_NAME) and
 * `X-Agent-Pid` (the skill shell's pid); on loopback the backend walks that
 * pid's parents to the agent PTY it belongs to.
 */
export const AGENT_ORIGIN_CONSTANTS = {
	SESSION_HEADER: 'x-agent-session',
	PID_HEADER: 'x-agent-pid',
	/** Set on a corrected request: the session the shell claimed */
	CLAIMED_SESSION_HEADER: 'x-agent-session-claimed',
	/** Longest parent chain walked from the skill shell */
	MAX_ANCESTRY_DEPTH: 64,
	/** Give up on the process lookup after this long and keep the claimed identity */
	LOOKUP_TIMEOUT_MS: 1500,
	/** One skill run makes several calls from the same shell pid */
	RESULT_CACHE_TTL_MS: 30_000,
	RESULT_CACHE_MAX_ENTRIES: 500,
	/** The same mismatch is logged at most this often */
	WARN_THROTTLE_MS: 10 * 60 * 1000,
	/** Command line of Codex's shared background app server (`codex app-server --listen unix:// --managed-daemon`) */
	SHARED_DAEMON_ARGS_RE: /\bapp-server\b.*--(?:managed-daemon|listen)\b/,
	PS_MAX_BUFFER_BYTES: 16 * 1024 * 1024,
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
	/**
	 * Google Antigravity CLI (`agy`), the successor to Gemini CLI for
	 * individual users. Driven only with a Gemini API key — see
	 * specs/antigravity-runtime.md for why account (OAuth) login is refused.
	 */
	ANTIGRAVITY_CLI: 'antigravity-cli',
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
 * Control-plane guard for Claude Code agent sessions (Request 72c9427a,
 * specs/2026-09-24-control-plane-isolation.md Part 3).
 *
 * The backend writes a per-session settings file (permissions.deny + a
 * PreToolUse Bash hook) and passes it with `--settings`, so an agent cannot
 * edit the files that stop, start and configure agents. All paths are
 * relative to the root named by the group: CREWLY_HOME (`~/.crewly`), the
 * install root (the Crewly package / checkout), or the agent's project path.
 */
export const CONTROL_PLANE_GUARD_CONSTANTS = {
	/** Backend env var; `0` turns the guard off for every session launched by this backend. */
	KILL_SWITCH_ENV: 'CREWLY_CONTROL_PLANE_GUARD',
	/** Value of KILL_SWITCH_ENV that disables the guard. Any other value (or unset) keeps it on. */
	KILL_SWITCH_OFF_VALUE: '0',
	/** Directory under CREWLY_HOME that holds the generated per-session files. */
	RUNTIME_DIR: 'runtime/control-plane',
	/** Suffix of the generated Claude Code settings file (`<session><suffix>`). */
	SETTINGS_FILE_SUFFIX: '.settings.json',
	/** Suffix of the protected-paths list the Bash hook reads (`<session><suffix>`). */
	PATHS_FILE_SUFFIX: '.paths',
	/** The PreToolUse Bash hook, relative to the install root. */
	HOOK_SCRIPT: 'config/hooks/control-plane-guard/pretooluse-bash.sh',
	/** CLI flag the settings file is passed with. */
	SETTINGS_FLAG: '--settings',
	/** Claude Code tool the PreToolUse hook is attached to. */
	HOOK_TOOL_MATCHER: 'Bash',
	/**
	 * Write-protected directories under CREWLY_HOME (whole subtree).
	 *
	 * `teams` is deliberately NOT here (WorkItem 70e54fbc / #798 review):
	 * specs/2026-09-24-control-plane-isolation.md Part 2 protects only
	 * `teams/*\/config.json`, not the whole subtree. A team directory also
	 * holds `norms/`, `wiki/`, `prompts/`, `sops/` and `cron-tasks.json` —
	 * files agents write routinely (`remember`, `record-learning`,
	 * norm/SOP authoring, follow-up scheduling). Blanket-protecting `teams`
	 * would block all of that. See TEAM_CONFIG_FILE_NAME below for how the
	 * narrower rule is built (one entry per existing team, resolved at
	 * guard-prep time since the hook needs literal paths, not globs).
	 */
	CREWLY_HOME_DIRS: ['triggers', 'runtime/control-plane'],
	/**
	 * Directory under CREWLY_HOME holding one subdirectory per team, each
	 * expected to contain a `config.json` (see TEAM_CONFIG_FILE_NAME).
	 */
	TEAMS_DIR_NAME: 'teams',
	/** File name, within each team's directory, that the guard protects. */
	TEAM_CONFIG_FILE_NAME: 'config.json',
	/** Write-protected files under CREWLY_HOME. */
	CREWLY_HOME_FILES: [
		'recurring-checks.json',
		'one-time-checks.json',
		'scheduled-messages.json',
		'settings.json',
		'runtime-pids.json',
		'session-state.json',
		'api-token',
	],
	/** Files under CREWLY_HOME that agents must not read with the built-in tools either. */
	CREWLY_HOME_READ_DENIED_FILES: ['api-token'],
	/** Write-protected directories under the install root (whole subtree). */
	INSTALL_DIRS: [
		'config/skills/orchestrator/stop-agent',
		'config/skills/orchestrator/start-agent',
		'config/skills/orchestrator/terminate-agent',
		'config/skills/orchestrator/stop-team',
		'config/skills/orchestrator/start-team',
		'config/skills/orchestrator/restart-crewly',
		'config/hooks/control-plane-guard',
		// #815: the agent-status hook runs on every tool call; an agent must not
		// be able to silence or rewrite it.
		'config/hooks/agent-status',
		// #852: the subagent guard; an agent must not be able to switch it off.
		'config/hooks/subagent-guard',
		'dist',
	],
	/** Write-protected files under the install root. */
	INSTALL_FILES: ['config/skills/_common/lib.sh'],
	/** Write-protected directories under the agent's project path (whole subtree). */
	PROJECT_DIRS: ['.claude/agents', '.crewly/triggers'],
} as const;

/**
 * Agent-status hook (#815, specs/2026-09-26-agent-waiting-on-human.md): Claude
 * Code hook events that tell the backend when an agent waits on the user.
 * Registered in the control-plane guard's per-session settings file, never as
 * a second settings file, and never on PreToolUse (that event is the guard's).
 */
export const AGENT_STATUS_HOOK_CONSTANTS = {
	/** Hook script, relative to the install root. */
	HOOK_SCRIPT: 'config/hooks/agent-status/report.sh',
	/** Hook events the script is registered for. */
	EVENTS: ['Notification', 'PermissionRequest', 'Stop', 'UserPromptSubmit', 'PostToolUse'],
	/** Events that carry a tool matcher; they match every tool. */
	TOOL_EVENTS: ['PermissionRequest', 'PostToolUse'],
	/** Matcher that selects every tool. */
	ALL_TOOLS_MATCHER: '*',
	/** Notification types that mean "waiting on the user". */
	WAITING_NOTIFICATION_TYPES: ['permission_prompt', 'elicitation_dialog'],
	/** Every notification type the endpoint accepts (others are rejected). */
	KNOWN_NOTIFICATION_TYPES: ['permission_prompt', 'elicitation_dialog', 'idle_prompt', 'auth_success'],
	/** Max length of an accepted event or notification-type identifier. */
	MAX_IDENTIFIER_LENGTH: 64,
	/** Sessions whose latest hook signal is kept in memory (oldest dropped past this). */
	MAX_TRACKED_SESSIONS: 500,
	/** Accepted X-Agent-Session header value. */
	SESSION_NAME_PATTERN: /^[A-Za-z0-9._-]{1,128}$/,
} as const;

/**
 * Subagent guard (#852, specs/2026-10-03-subagent-guard.md): a Claude Code
 * SubagentStart / SubagentStop hook. It injects Crewly's subagent rules when a
 * subagent starts, and sends back, once, a subagent that stops without having
 * made any tool call. Registered in the control-plane guard's per-session
 * settings file, like the agent-status hook.
 */
export const SUBAGENT_GUARD_CONSTANTS = {
	/** Hook script, relative to the install root. */
	HOOK_SCRIPT: 'config/hooks/subagent-guard/subagent.sh',
	/** Hook events the script is registered for. */
	EVENTS: ['SubagentStart', 'SubagentStop'],
	/** Environment variable that turns the subagent guard off when set to KILL_SWITCH_OFF_VALUE. */
	KILL_SWITCH_ENV: 'CREWLY_SUBAGENT_GUARD',
	/** Value of KILL_SWITCH_ENV that disables the subagent guard. */
	KILL_SWITCH_OFF_VALUE: '0',
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

/**
 * Orchestrator reply routing (2026-09-26 incident: the owner asked the orc a
 * question in a Slack DM, and its answer landed in #pro-think-tank).
 * See `services/orc/orc-reply-route.service.ts`.
 */
export const ORC_REPLY_ROUTE_CONSTANTS = {
	/** Characters of the last delivered message kept to tell whether a harness prompt was the last thing an agent got */
	LAST_DELIVERED_HEAD_CHARS: 400,
	/**
	 * How long after the last user message the orchestrator received its
	 * conversation stays "the one its turn came from". Covers a long turn and
	 * the system-triggered turns (WorkItem dispatch, reminders) that follow it.
	 */
	ORIGIN_TTL_MS: 15 * 60 * 1000,
	/**
	 * A conversation the orchestrator received a user message from within this
	 * window is one it is actively in; replies there are never re-routed.
	 */
	RECENT_INBOUND_MS: 30 * 60 * 1000,
	/** Cap on remembered inbound conversations per session (oldest dropped). */
	MAX_TRACKED_CONVERSATIONS: 50,
	/** Slack channel-id prefix of a direct-message conversation. */
	SLACK_DM_PREFIX: 'D',
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
 * Give-up recovery (#841, specs/2026-09-27-give-up-recovery.md): when a worker
 * stops on a feasibility give-up, queue a retry with a different approach,
 * bounded per root WorkItem, then one escalation to the team lead.
 */
export const GIVE_UP_RECOVERY_CONSTANTS = {
	/** Retries per root WorkItem when the team sets no recoveryPolicy. */
	DEFAULT_MAX_RETRIES: 2,
	/** Retry WorkItem id: `${rootId}${RETRY_ID_INFIX}${attempt}`. */
	RETRY_ID_INFIX: ':giveup:',
	/** Escalation review WorkItem id: `${rootId}${REVIEW_ID_SUFFIX}`. */
	REVIEW_ID_SUFFIX: ':review:gave_up',
	/** WorkItem.metadata key for the recorded stop classification. */
	STOP_METADATA_KEY: 'stop',
	/** WorkItem.metadata key for the attempt log carried by retries. */
	GIVE_UP_METADATA_KEY: 'giveUp',
	/** Characters of stop text kept per attempt. */
	MAX_REASON_CHARS: 2000,
	/** Audit label for transitions this feature makes. */
	ACTOR_VIA: 'give-up-recovery',
} as const;

/**
 * Completion evidence contract (#873, specs/2026-10-03-completion-evidence.md):
 * a WorkItem is marked done only with evidence — artifacts that exist,
 * commands with their exit codes — and a worker that could not finish reports
 * `blocked` evidence instead.
 */
export const COMPLETION_EVIDENCE_CONSTANTS = {
	/** The two rollout modes for a completion that carries no evidence. */
	MODES: ['warn', 'enforce'] as readonly string[],
	/**
	 * Default mode for a completion with no evidence. `warn` (this release):
	 * accepted, logged, and the response carries a `warning`. `enforce` (next
	 * release): 400. Malformed evidence, missing artifacts, failing commands and
	 * `blocked` entries are handled the same in both modes.
	 */
	EVIDENCE_ENFORCEMENT_MODE: 'warn' as 'warn' | 'enforce',
	/** Env var that overrides {@link EVIDENCE_ENFORCEMENT_MODE} (`warn` | `enforce`). */
	ENV_MODE: 'CREWLY_EVIDENCE_MODE',
	/** Most evidence entries accepted on one completion. */
	MAX_ENTRIES: 50,
	/** Longest string accepted in any evidence field. */
	MAX_FIELD_CHARS: 8000,
	/** URL schemes accepted for an artifact without checking it exists. */
	URL_SCHEMES: ['http:', 'https:'] as readonly string[],
	/** Response codes for each rejection. */
	CODES: {
		MALFORMED: 'evidence_malformed',
		MISPLACED: 'evidence_misplaced',
		MISSING: 'evidence_required',
		ARTIFACT_NOT_FOUND: 'evidence_artifact_not_found',
		ARTIFACT_UNRESOLVABLE: 'evidence_artifact_relative_path',
		COMMAND_FAILED: 'evidence_command_failed',
	},
	/** The shape a worker must send, quoted in every rejection and warning. */
	SHAPE_HINT:
		'Send body.result.evidence: an array of {"type":"artifact","path":"<existing file or https URL>"}, ' +
		'{"type":"command","command":"<cmd>","exitCode":0,"outputTail":"<last lines>"}, ' +
		'or — if you could not finish — {"type":"blocked","step":"<step that failed>","reason":"<why>"}.',
} as const;

/**
 * Constants for the waiting_on_human attention verdict (#815).
 * See specs/2026-09-26-agent-waiting-on-human.md.
 */
export const AGENT_ATTENTION_CONSTANTS = {
	/** Non-empty lines at the bottom of the screen the dialog rules examine.
	 *  Dialogs render at the bottom; older answered dialogs sit above it. */
	BOTTOM_LINES: 20,
	/** Lines captured from the terminal buffer for the verdict (more than the
	 *  5 lines the activity diff uses, because a dialog spans ~15 lines). */
	CAPTURE_LINES: 60,
	/** How long an agent must stay waiting_on_human before the reconciler moves
	 *  its running WorkItems to blocked (5 minutes). */
	BLOCK_WORK_ITEM_AFTER_MS: 300_000,
	/** WorkItem blockedReason / escalation reason used for this state. */
	BLOCKED_REASON: 'waiting_on_human',
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
	/** How long a delivered event id is remembered per subscription, so a
	 *  replayed publish of the same event is not delivered twice (#926) */
	DELIVERED_EVENT_TTL_MS: 30 * 60 * 1000,
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
	/**
	 * Slack threads in one DM still waiting for the agent's answer, oldest
	 * first. An answer the agent does not attribute goes to the oldest of
	 * them — never silently to the newest (2026-09-28, Ella: an EFT answer
	 * owed in thread A landed in thread B). Capped so a DM the agent never
	 * answers cannot grow the link store without bound.
	 */
	MAX_OPEN_THREADS: 20,
	/**
	 * A file an agent attaches without naming a thread, this soon after it
	 * posted an answer, goes into that answer's thread (the file and the
	 * sentence about it stay together).
	 */
	ATTACH_FOLLOWS_REPLY_MS: 2 * 60 * 1000,
} as const;

/**
 * Stable per-thread keys for Slack conversations (2026-09-28).
 *
 * Every Slack message delivered to an agent carries `[SLACK-THREAD:<key>]`,
 * `<key>` = `<slack channel id>:<thread root ts>` (a top-level message is its
 * own thread root). The reply tools (`reply-chat --thread`, `reply-channel
 * --thread`, `attach-file --thread`, `slack-post --thread`) take the key and
 * post in exactly that thread, so an answer to an earlier thread is never
 * posted under the newest one.
 */
export const SLACK_THREAD_KEY_CONSTANTS = {
	/** Tag name as the agent sees it: `[SLACK-THREAD:<key>]` */
	TAG: 'SLACK-THREAD',
	/** chat-v2 message metadata field an agent reply's thread key is recorded under */
	METADATA_KEY: 'slackThreadKey',
	/**
	 * One-line rule for every agent's prompt. Kept short: it rides in the
	 * communication module of every role.
	 */
	PROMPT_RULE:
		'Slack threads: every Slack message you get carries `[SLACK-THREAD:<key>]`. Answer each thread in its own thread — pass that key as `--thread <key>` to reply-chat / reply-channel / attach-file. ' +
		'When you finish work that was asked for in an earlier thread, post it (and its files) in THAT thread, not the one you were asked in last. ' +
		'Never bundle answers for different threads into one message: two threads → two replies.',
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

/** One day in ms — base unit for the wiki queue ages below. */
const WIKI_QUEUE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Wiki ingest queue (`~/.crewly/wiki-queue/`) hygiene (#914). The bridge
 * sweeps the queue once per tick: claims an agent abandoned go back to
 * pending, items nobody processed within the max age move to the
 * dead-letter folder, and a vault whose oldest pending item is older than
 * the alert age is reported to the owner.
 */
export const WIKI_QUEUE_CONSTANTS = {
	/** Pending/claimed items older than this (by `queuedAt`) are moved to the dead-letter folder. */
	MAX_ITEM_AGE_MS: 30 * WIKI_QUEUE_DAY_MS,
	/** Warn the owner when a vault's oldest pending item is older than this. */
	STALE_ALERT_AGE_MS: 7 * WIKI_QUEUE_DAY_MS,
	/** Minimum gap between two stale-queue alerts for the same vault. */
	STALE_ALERT_COOLDOWN_MS: WIKI_QUEUE_DAY_MS,
	/** A claim older than this with no process/skip is released back to pending. */
	CLAIM_TIMEOUT_MS: WIKI_QUEUE_DAY_MS,
	/** Sub-folder of the queue root that holds expired items (kept, never deleted). */
	DEAD_LETTER_DIR: 'dead-letter',
} as const;

/**
 * Standing-answer pages (#816): a few question-anchored pages per scope,
 * read at boot as a plain file read (no retrieval, no LLM) and refreshed by
 * an agent only when the memory behind them has moved.
 */
export const STANDING_ANSWERS_CONSTANTS = {
	/** Project pages live here, under the project's `.crewly` data dir. */
	PROJECT_DIR: 'wiki/llm-curated/standing',
	/** The agent page, under `<CREWLY_HOME>/agents/<session>/`. */
	AGENT_FILE: 'standing.md',
	/** Page id of the agent page. */
	AGENT_PAGE_ID: 'unfinished-work',
	/** Hard cap on the whole Standing Answers prompt section (~2 000 tokens). */
	PROMPT_MAX_CHARS: 8000,
	/** Cap on one page's body inside the prompt. */
	PROMPT_PAGE_MAX_CHARS: 3000,
	/** Cap on one section body written through the API. */
	SECTION_MAX_CHARS: 1500,
	/** Cap on a section heading. */
	HEADING_MAX_CHARS: 80,
	/** Cap on citations per section. */
	MAX_CITES_PER_SECTION: 20,
	/** Entries listed in a refresh WorkItem brief. */
	BRIEF_MAX_ENTRIES: 30,
	/** Characters of each entry shown in a refresh brief. */
	BRIEF_ENTRY_MAX_CHARS: 240,
	/** Shared topic words that flag two same-day entries as a possible supersede pair (#884). */
	SUPERSEDE_MIN_SHARED_WORDS: 2,
	/** Refresh tick interval when CREWLY_WIKI_REFLECT_INTERVAL_MS is unset (the reflect default). */
	REFRESH_INTERVAL_MS: 60 * 60 * 1000,
	/** Minimum time between two refresh WorkItems for the same page. */
	REFRESH_COOLDOWN_MS: 6 * 60 * 60 * 1000,
	/** At most this many refresh WorkItems per tick (PTY paste-flood guard). */
	REFRESH_MAX_CREATES_PER_TICK: 2,
	/**
	 * A refresh WorkItem that failed or was cancelled without writing the page
	 * is retried even though the source watermark has not moved again (it
	 * otherwise would not be re-raised until new memory arrives). Bounded so a
	 * page that keeps failing does not retry forever.
	 */
	REFRESH_MAX_RETRIES: 2,
	/** Refresh bookkeeping (last raised watermark per page), under CREWLY_HOME. */
	REFRESH_STATE_FILE: 'standing-refresh-state.json',
	/** `metadata.kind` of refresh WorkItems. */
	WORKITEM_KIND: 'standing-refresh',
	/**
	 * Decisions whose title starts with this are task-completion records that
	 * report-status files automatically, not decisions; they are out of scope
	 * for "decisions in force" (in this repo: 229 of 327 decision entries).
	 */
	COMPLETED_DECISION_PREFIX: '[COMPLETED]',
	/**
	 * Agent-memory entries starting with this are report-status completion
	 * learnings ("Task completed: <summary>"). Done work is neither
	 * unfinished nor blocking, so they are out of scope for the agent page
	 * and do not move its watermark; "Task failed:"/"Task blocked:" stay in.
	 */
	COMPLETED_LEARNING_PREFIX: 'Task completed:',
} as const;

/**
 * Per-WorkItem git worktrees (#814). Opt-in per project in v1
 * (`Project.worktrees = 'on'`); a team can opt out (`Team.worktrees =
 * 'off'`); `CREWLY_WORKTREES=off` disables them everywhere.
 */
export const WORKTREE_CONSTANTS = {
	/** Worktrees live here, relative to the repo root (gitignored via .crewly). */
	DIR: '.crewly/worktrees',
	/** Per-worktree manifests (symlinks, copies, base) live here, inside DIR. */
	META_DIR: '.meta',
	/** Branch name prefix: `wi/<workItemId>`. */
	BRANCH_PREFIX: 'wi/',
	/** Repo-root file listing gitignored-but-needed files to copy in. */
	INCLUDE_FILE: '.worktreeinclude',
	/** Cap on `.worktreeinclude` entries honoured. */
	INCLUDE_MAX_ENTRIES: 50,
	/** Heavy directories symlinked (not copied) from the repo root when present and untracked. */
	DEFAULT_SHARED_DIRS: ['node_modules'] as readonly string[],
	/** Marker line for the entries this feature adds to `.git/info/exclude`. */
	EXCLUDE_MARKER: '# crewly worktree shared paths (#814) — never commit these',
	/** Timeout for local git commands (checkout of a large repo can take minutes under load). */
	GIT_TIMEOUT_MS: 10 * 60 * 1000,
	/** Timeout for `git ls-remote` (offline must not hang the sweep). */
	REMOTE_TIMEOUT_MS: 15_000,
	/** Orphan sweep interval. */
	SWEEP_INTERVAL_MS: 30 * 60 * 1000,
	/** Kill switch env var; the value `off` disables worktrees everywhere. */
	ENV_KILL_SWITCH: 'CREWLY_WORKTREES',
	/** WorkItem metadata key holding the worktree record. */
	METADATA_KEY: 'worktree',
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
	/**
	 * A `slack-post` that names no thread answers an owed placeholder only if
	 * that placeholder went up this recently. Older ones belong to questions
	 * from another turn; a scheduled post was captured into those threads (#808).
	 */
	UNTHREADED_ANSWER_MAX_AGE_MS: 30 * 60 * 1000,
	/** A placeholder younger than this is not taken down when the turn ends (race with delivery) */
	SETTLE_MIN_AGE_MS: 30 * 1000,
	/** Answers posted in a thread are remembered this long for settling placeholders at turn end (ms) */
	ANSWERED_KEEP_MS: 24 * 60 * 60 * 1000,
	/**
	 * A placeholder skipped at turn end for being too young is looked at
	 * again once it is SETTLE_MIN_AGE_MS old, plus this margin — and taken
	 * down then unless the agent is mid-turn. Without the second look it
	 * stayed until the agent's NEXT turn ended, which can be hours
	 * (2026-09-28: "Ella is working on it…" left under an answered thread).
	 */
	SETTLE_RECHECK_MARGIN_MS: 2 * 1000,
	/**
	 * How an answer replaces its thread's placeholder. `true` = the oldest
	 * placeholder is edited into the answer (chat.update) and any others in
	 * the thread are deleted, so nothing is left behind (2026-09-28).
	 * `false` = the 2026-09-23 behaviour: the answer is posted as a new
	 * message (Slack notifies on new messages, not on edits) and the
	 * placeholders are deleted after it.
	 * Owner-facing default is `false`: a reply must notify (edits don't), and
	 * the placeholder races that left "working on it…" behind are fixed.
	 */
	REPLACE_BY_EDIT: false,
	/** Fallback text when a settled placeholder cannot be deleted */
	SETTLED_TEXT: '✓ {name} read this — no reply needed.',
	/** Reaction put on the person's message when the agent settled it without replying */
	SETTLED_REACTION: 'white_check_mark',
	/** Placeholders restored after a restart that nobody claims within this long are taken down */
	BOOT_ORPHAN_MS: 15 * 60 * 1000,
	/** File (under CREWLY_HOME) where outstanding placeholders survive a restart */
	STORE_FILENAME: 'slack-typing-placeholders.json',
	/**
	 * Metadata flag on an agent message that is an interim note ("got it —
	 * here is my plan") rather than the answer: the Slack mirror posts it and
	 * puts the working-on-it placeholder back under it, and the ticket loop
	 * does not count it as the answer (owner, 2026-09-24).
	 */
	INTERIM_METADATA_KEY: 'interim',
	/**
	 * How long after an owner's Slack message was delivered the harness
	 * watches its recipients for a turn to start. The first recipient seen
	 * going busy in that window gets the "working on it" placeholder posted
	 * for it — no longer left to the agent calling `reply-channel --working`
	 * (2026-09-30: Owen worked 3.5 min on a #pro-ce message with nothing
	 * showing). 60 s, not 30: busy is observed by the 30 s ActivityMonitor
	 * poll, so a turn that starts right after delivery can be seen up to one
	 * poll later, and the PTY write itself takes a few seconds.
	 */
	AUTO_WORKING_WINDOW_MS: 60 * 1000,
	/** A watched delivery that never reports its outcome is dropped after this (cold starts take 1–2 min) */
	AUTO_WORKING_DELIVERY_MAX_MS: 10 * 60 * 1000,
	/** Deliveries still watched at once; the oldest is dropped past this */
	AUTO_WORKING_MAX_WATCHES: 200,
} as const;

/**
 * Slack thread context read at delivery time.
 *
 * Cloud drops Slack events written by the account's own bots (loop guard),
 * so a post by an agent on another machine never reaches this one. When a
 * message in that thread is then delivered here, the agent is shown what the
 * thread actually says — fetched read-only from Slack, never recorded
 * locally (2026-09-28, #daily-info: "@Atlas 看看上面的这些").
 */
export const SLACK_THREAD_CONTEXT_CONSTANTS = {
	/** Whether the Slack context block is fetched at all */
	ENABLED: true,
	/** Most messages shown (newest kept) */
	MAX_MESSAGES: 30,
	/** Character budget of the whole block's message lines (newest kept) */
	MAX_CHARS: 12_000,
	/** Characters kept per message before clipping */
	PER_MESSAGE_CHARS: 4_000,
	/** Recent channel messages read before a top-level @-mention */
	CHANNEL_HISTORY_LIMIT: 15,
	/** Page size for `conversations.replies` */
	REPLIES_PAGE_SIZE: 200,
	/** Most `conversations.replies` pages read for one thread */
	REPLIES_MAX_PAGES: 5,
	/** How long one (channel, thread) fetch is reused */
	CACHE_TTL_MS: 60_000,
	/** Most cached threads kept */
	CACHE_MAX_ENTRIES: 200,
	/** How long a resolved user / bot name is reused */
	NAME_CACHE_TTL_MS: 60 * 60 * 1000,
	/** Most distinct users resolved via `users.info` for one block */
	MAX_NAME_LOOKUPS: 25,
	/** Per-request timeout; delivery never waits longer than a few of these */
	FETCH_TIMEOUT_MS: 5_000,
	/** Back-off after a 429 without a usable Retry-After (ms) */
	DEFAULT_RETRY_AFTER_MS: 30_000,
	/** Slack Web API base URL */
	API_BASE_URL: 'https://slack.com/api',
	/**
	 * Slack error codes after which the next candidate token is tried: this
	 * token's app is not in the conversation or cannot read it.
	 */
	TRY_NEXT_TOKEN_ERRORS: [
		'not_in_channel',
		'channel_not_found',
		'missing_scope',
		'not_authed',
		'invalid_auth',
		'token_revoked',
		'account_inactive',
		'no_permission',
	] as readonly string[],
	/** Message subtypes that are conversation, not channel housekeeping */
	CONTENT_SUBTYPES: ['bot_message', 'thread_broadcast', 'file_share', 'me_message'] as readonly string[],
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
	/**
	 * Huddle-message metadata key: Slack users the message @'d who are
	 * people, not Crewly agents (nor any bot we can identify). When set, the message
	 * names its addressees, so no agent is drawn in by thread engagement or
	 * the "nobody addressed" fallback (specs/slack-room-presence.md).
	 */
	PEOPLE_MENTIONS_METADATA_KEY: 'slackMentionedPeople',
	/**
	 * Huddle-message metadata key: why a message with no @ of its own was
	 * treated as addressed to people — `same-sender-followup` or
	 * `person-exchange` (specs/slack-room-presence.md "Follow-ups of a
	 * person-to-person exchange").
	 */
	ADDRESSEE_INHERITED_METADATA_KEY: 'slackAddresseeInherited',
	/**
	 * Huddle-message metadata key: agents Cloud says the message @'d
	 * (`mentionedAgentSessions`), wherever they run. A thread whose latest
	 * addressed human message names an agent is not a person-to-person exchange.
	 */
	AGENT_MENTIONS_METADATA_KEY: 'slackMentionedAgents',
	/**
	 * A message with no @ that its sender posts this soon after their own
	 * message to people only, in the same conversation, is addressed to the
	 * same people (2026-10-02, #personal-assistant-team: the owner answered a
	 * colleague in two messages 35 s apart, and the second, un-@'d, woke Aria).
	 * Overridden by the env var named in PEOPLE_FOLLOWUP_WINDOW_ENV.
	 */
	PEOPLE_FOLLOWUP_WINDOW_MS: 5 * 60 * 1000,
	/** Env var that overrides PEOPLE_FOLLOWUP_WINDOW_MS (milliseconds). */
	PEOPLE_FOLLOWUP_WINDOW_ENV: 'CREWLY_SLACK_PEOPLE_FOLLOWUP_WINDOW_MS',
	/**
	 * How long a thread counts as a person-to-person exchange after its last
	 * human-to-human @: an un-@'d message within this time of it is context
	 * only; after it, the normal rules apply again (owner, 2026-10-02).
	 * Overridden by the env var named in PERSON_EXCHANGE_WINDOW_ENV.
	 */
	PERSON_EXCHANGE_WINDOW_MS: 30 * 60 * 1000,
	/** Env var that overrides PERSON_EXCHANGE_WINDOW_MS (milliseconds). */
	PERSON_EXCHANGE_WINDOW_ENV: 'CREWLY_SLACK_PERSON_EXCHANGE_WINDOW_MS',
	/** Reaction added to a routed inbound message while the team works on it */
	INBOUND_REACTION: 'eyes',
	/** How many routed Slack messages to remember for duplicate-copy suppression */
	SEEN_INBOUND_MAX: 500,
	/** Synthetic team-id prefix for channels linked on the fly (no Crewly team behind them) */
	ADHOC_TEAM_PREFIX: 'adhoc:',
	/**
	 * How long an owner's room message that reached nobody on this machine
	 * waits for any agent (here or on another machine) to take it before this
	 * machine wakes the room's lead itself — or, with no lead here, says so in
	 * the thread. Cloud's presence can say "someone elsewhere is awake" while
	 * that agent, told only optionally, stays quiet (2026-09-30, Think Tank room).
	 */
	ROOM_UNANSWERED_FALLBACK_MS: 90 * 1000,
	/** The in-thread line when nobody could take an owner's room message. */
	ROOM_UNANSWERED_NOTE: 'No agent picked up this message (nobody in the room was awake to take it). Please @ an agent and send it again.',
	/** How many recent huddle turns to scan for the room's last local speaker. */
	ROOM_LAST_SPEAKER_SCAN: 50,
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
	/**
	 * A report-status line: the agent is talking to the orchestrator, not
	 * answering a person. Anything else posted to `agent-response` is content
	 * someone is waiting for — routing it to the orchestrator as "status"
	 * swallows it (2026-09-30, #steamfun运维组: Avery's whole answer to the
	 * owner went to the orc and never reached Slack).
	 */
	STATUS_MARKERS:
		// A structured body (report-status --structured, complete-task) opens with a
		// `---` rule — followed by a real newline, or a literal `\n` from an older skill.
		/^\s*(?:-{3,}(?:\s|\\n)*)?\[(DONE|COMPLETED|COMPLETE|DELIVERED|IDLE|BLOCKED|FAILED|ERROR|STATUS REPORT|STATUS|PROGRESS|IN_PROGRESS|WORKING|ACTIVE|STARTED|STARTING|HEARTBEAT|READY|ONLINE|MILESTONE|HANDOFF|VERIFICATION REQUEST)\]/i,
	/**
	 * How long after the owner @'d an agent in a Slack room that agent's
	 * reply (with no thread named) is taken as the answer to that message.
	 */
	RECENT_ROOM_REQUEST_WINDOW_MS: 6 * 60 * 60 * 1000,
} as const;

/**
 * Who an agent status report wakes (specs/2026-10-01-orc-status-wakes.md).
 *
 * On 2026-09-29 the orchestrator ran 194 turns for system events against 3
 * for the owner; 134 of them were team members' [DONE]/[BLOCKED] lines
 * about work their own team lead owns. Each turn re-reads ~70k tokens.
 * Status reports now go to whoever is responsible, and the orchestrator is
 * woken only when it has to act.
 */
export const ORC_WAKE_CONSTANTS = {
	/** Recorded only (status store, UI, ticket log) — never wake anyone */
	RECORD_ONLY_MARKERS: /^\s*\[(IN_PROGRESS|WORKING|ACTIVE|STARTED|STARTING|HEARTBEAT|READY|ONLINE|IDLE|PROGRESS)\]/i,
	/** "This piece of work is finished" */
	DONE_MARKERS: /^\s*\[(DONE|COMPLETED|COMPLETE|DELIVERED)\]/i,
	/** Always the orchestrator's: a shipped milestone it forwards to the owner (issue #435) */
	ALWAYS_ORC_MARKERS: /^\s*\[(MILESTONE)\]/i,
	/** "I am stuck" — the team lead hears first */
	ATTENTION_MARKERS: /^\s*\[(BLOCKED|FAILED|ERROR)\]/i,
	/** Non-urgent reports are batched into one orchestrator digest at most this often */
	DIGEST_INTERVAL_MS: 30 * 60 * 1000,
	/** Lines listed in one digest (the rest are counted) */
	DIGEST_MAX_LINES: 20,
	/** Characters of each report shown in a digest line */
	DIGEST_LINE_CHARS: 160,
	/** Conversation id of the digest turn */
	DIGEST_CONVERSATION_ID: 'system:status-digest',
	/** Conversation id of status reports forwarded to a team lead */
	TEAM_LEAD_CONVERSATION_ID: 'system:team-status',
	/** A work item finished this recently still counts as the one a [DONE] is about */
	RECENT_COMPLETION_MS: 30 * 60 * 1000,
	/** How often the "orc wakes: N (…)" line is logged */
	COUNTER_LOG_INTERVAL_MS: 60 * 60 * 1000,
	/** `sourceMetadata` key naming why a queued message wakes the orchestrator */
	WAKE_CATEGORY_KEY: 'orcWakeCategory',
} as const;

/**
 * Unanswered-owner-message watchdog (specs/2026-09-30-owner-message-guarantee.md).
 *
 * Every owner message delivered to an agent here ends in an answer or in one
 * plain-words note saying who it is waiting on and why.
 */
export const OWNER_MESSAGE_WATCHDOG_CONSTANTS = {
	/** T1: no answer and no working placeholder → re-deliver to the responsible agent */
	NUDGE_AFTER_MS: 10 * 60 * 1000,
	/** T2: still nothing → one note in the thread */
	NOTE_AFTER_MS: 20 * 60 * 1000,
	/** A nudge always gets at least this long before the note follows it */
	MIN_NOTE_GAP_AFTER_NUDGE_MS: 5 * 60 * 1000,
	/** A visibly-working agent (placeholder showing + mid-turn) is left alone at most this long */
	BUSY_EXTEND_CAP_MS: 60 * 60 * 1000,
	/** Evaluation cadence */
	TICK_MS: 30 * 1000,
	/** How often agent display names (used only in notes) are re-read */
	NAME_REFRESH_MS: 5 * 60 * 1000,
	/** Entries older than this when restored after downtime are dropped, not noted */
	STALE_DROP_MS: 6 * 60 * 60 * 1000,
	/** A message parked on a sign-in (`login_wait`) is kept this long for re-delivery after the login */
	LOGIN_WAIT_DROP_MS: 24 * 60 * 60 * 1000,
	/** Cap on open entries (oldest dropped with a warning) */
	MAX_ENTRIES: 500,
	/**
	 * Answers seen in a thread are remembered this long: an agent can answer
	 * before the dispatch that delivered the message returns (a fast agent
	 * while a colleague in the same room is still cold-starting).
	 */
	RECENT_ANSWER_KEEP_MS: 15 * 60 * 1000,
	/** Recently resolved keys remembered for dedupe (a hand-off re-dispatch must not re-track) */
	MAX_RESOLVED_KEYS: 2000,
	/** Characters of the owner's message quoted in logs, the debug list and the nudge */
	PREVIEW_CHARS: 200,
	/** Persisted state under CREWLY_HOME */
	STORE_FILENAME: 'owner-message-watchdog.json',
	/**
	 * Whole-message acknowledgements that need no answer (compared after
	 * lower-casing and stripping whitespace/punctuation). Approval words such
	 * as 可以 / 行 are deliberately absent: they usually ask for action.
	 */
	ACK_WORDS: [
		'好', '好的', '好滴', '好嘞', '好哒', '嗯', '嗯嗯', '收到', '知道了', '了解',
		'谢谢', '谢了', '多谢', '谢谢你', '感谢', '好的谢谢', '好谢谢', '辛苦了',
		'ok', 'okay', 'k', 'kk', 'okok', 'ok谢谢', 'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'got it', 'cool', 'nice',
		'👍', '🙏', '👌', '✅', '❤️', '🙂', '😊', '👍👍',
	] as readonly string[],
	/** Nudge delivered to the responsible agent ({waited} = minutes) */
	NUDGE_TEXT:
		'[REMINDER] 这条来自 owner 的消息已经 {waited} 分钟没有回复了。现在回复它：`{replyCmd}`——会自动发回这条消息来的地方。' +
		'如果已经在别处回答过，或者确实不需要回复，运行 `{noneCmd}`。',
	/**
	 * Note texts (from Crewly's own bot), English like the rest of the
	 * owner-facing UI. {name} = agent display name. The login note names the
	 * English command; 「重新登录 claude」 is still accepted as input.
	 */
	NOTE_LOGIN_TEXT: "⏳ Still waiting on {name} — {runtime} on this machine is signed out. Reply `login` here to sign in from your phone (or `relogin {runtimeCmd}`); your message is kept and re-delivered once it's signed in.",
	NOTE_ASLEEP_TEXT: "⏳ Still waiting on {name} — {name} isn't running and couldn't be woken ({detail}).",
	NOTE_ERROR_TEXT: "⏳ Still waiting on {name} — your message couldn't be delivered ({detail}).",
	NOTE_BUSY_CAP_TEXT: '⏳ {name} is still working on your message ({waited} min so far).',
	NOTE_SILENT_TEXT: "⏳ {name} got your message but hasn't replied in {waited} min; I've sent a reminder.",
	/** Shown in a note when a failed delivery left no error detail */
	NOTE_UNKNOWN_DETAIL: 'reason unknown',
	/** The agent hit a daily token cap (specs/2026-10-02-spend-cap.md) */
	NOTE_SPEND_CAP_TEXT: "⏳ Still waiting on {name} — {name} hit its daily token cap ({cap}). Your message is kept and delivered when the cap resets at midnight or you boost it (reply `boost {who} by 10M today` or `unlimited today for {who}`).",
} as const;

/**
 * The single `reply` entry point (specs/2026-09-30-owner-message-guarantee.md §B).
 */
export const AGENT_REPLY_CONSTANTS = {
	/** The skill every delivered message names */
	SKILL_PATH: 'config/skills/agent/core/reply/execute.sh',
	/**
	 * First line of every delivered reply hint. {identity} = the
	 * `CREWLY_SESSION_NAME=<session> ` prefix (or empty).
	 */
	HINT_LINE:
		'Reply: `{identity}bash config/skills/agent/core/reply/execute.sh "<your reply>"` (goes back where this message came from). ' +
		'Answer where you were asked; a new topic goes in a new thread (`--new-thread "<title>"`). ' +
		'No answer needed: `{identity}bash config/skills/agent/core/reply/execute.sh --none`.',
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
 * Constants for outgoing Slack message payloads.
 */
export const SLACK_OUTGOING_MESSAGE_CONSTANTS = {
	/**
	 * Top-level `text` sent when a message has no text of its own and no
	 * block text to derive one from. Slack rejects an empty `text` without
	 * blocks (`no_text`) and uses `text` as the notification/accessibility
	 * fallback when blocks are present, so it must never be empty.
	 */
	EMPTY_TEXT_FALLBACK: 'New message',
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
 * Constants for the worktree janitor (`WorktreeJanitorService`).
 *
 * Agents create a git worktree per code task and never delete it. The janitor
 * removes a worktree once its work has landed (merged into origin's default
 * branch, or its PR is MERGED) and nothing is using it. See the service JSDoc
 * for the full list of removal rules.
 */
export const WORKTREE_JANITOR_CONSTANTS = {
	/** Env kill switch: `CREWLY_WORKTREE_JANITOR=0` (or `off`/`false`) disables the janitor. */
	ENV_VAR: 'CREWLY_WORKTREE_JANITOR',
	/** Values of {@link WORKTREE_JANITOR_CONSTANTS.ENV_VAR} that disable it (lower-cased). */
	DISABLED_VALUES: ['0', 'off', 'false', 'no'] as readonly string[],
	/** Interval between automatic runs (30 minutes). */
	INTERVAL_MS: 30 * 60 * 1000,
	/** Delay before the first automatic run after startup (10 minutes). */
	FIRST_RUN_DELAY_MS: 10 * 60 * 1000,
	/**
	 * A worktree in a known agent location (`<repo>/.claude/worktrees/`,
	 * `<tmp>/crewly-worktrees/`, or a `worktree-agent-*` branch) touched more
	 * recently than this is kept (2 hours).
	 */
	MIN_IDLE_MS: 2 * 60 * 60 * 1000,
	/** Any other linked worktree touched more recently than this is kept (24 hours). */
	MIN_IDLE_OTHER_MS: 24 * 60 * 60 * 1000,
	/**
	 * A Claude Code session scratch dir (`<tmp>/claude-<uid>/<slug>/<uuid>/`)
	 * touched more recently than this is kept (3 days).
	 */
	SCRATCH_MIN_IDLE_MS: 3 * 24 * 60 * 60 * 1000,
	/** In low-disk mode every idle threshold is divided by this factor… */
	LOW_DISK_IDLE_DIVISOR: 2,
	/** …but never drops below this (2 hours). */
	LOW_DISK_MIN_IDLE_FLOOR_MS: 2 * 60 * 60 * 1000,
	/** Prefix of Claude Code's per-user temp root under the temp dir (`claude-<uid>`). */
	SCRATCH_ROOT_PREFIX: 'claude-',
	/** Extra temp dirs where the per-user Claude root may live besides os.tmpdir(). */
	SCRATCH_TMP_DIRS: ['/private/tmp', '/tmp'] as readonly string[],
	/** Session dir name pattern under `<root>/<project-slug>/` (a UUID). */
	SCRATCH_SESSION_DIR_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	/** How deep under a session dir git repos are searched for. */
	SCRATCH_REPO_SEARCH_DEPTH: 3,
	/** How many levels of a session dir count for its "last touched" time. */
	SCRATCH_MTIME_DEPTH: 2,
	/** Directory names never descended into while searching for repos. */
	SEARCH_SKIP_DIRS: ['node_modules', '.git'] as readonly string[],
	/** How deep under each temp root linked worktrees are searched for (repo discovery). */
	DISCOVERY_DEPTH: 4,
	/** Cap on directories visited per temp root during repo discovery. */
	DISCOVERY_MAX_DIRS: 20_000,
	/** Filesystem walks yield to the event loop (one setImmediate) after this many entries. */
	YIELD_EVERY_ENTRIES: 50,
	/** Interval of the low-disk check (10 minutes). */
	LOW_DISK_CHECK_INTERVAL_MS: 10 * 60 * 1000,
	/** Free space below this on the CREWLY_HOME volume triggers a low-disk pass (15 GB). */
	LOW_DISK_BYTES: 15 * 1024 ** 3,
	/** Free space below this is urgent (5 GB). */
	CRITICAL_DISK_BYTES: 5 * 1024 ** 3,
	/** A low-disk check does not start another pass within this time of the last one (30 minutes). */
	LOW_DISK_PASS_GAP_MS: 30 * 60 * 1000,
	/** Owner notice about low disk at most this often (24 hours). */
	LOW_DISK_NOTIFY_INTERVAL_MS: 24 * 60 * 60 * 1000,
	/** Urgent owner notice (below CRITICAL_DISK_BYTES) at most this often (6 hours). */
	CRITICAL_DISK_NOTIFY_INTERVAL_MS: 6 * 60 * 60 * 1000,
	/** How many of the biggest kept items the owner notice lists. */
	LOW_DISK_REPORT_ITEMS: 5,
	/** Timeout of one `du -sk` size probe (ms). */
	DU_TIMEOUT_MS: 60_000,
	/** State file under CREWLY_HOME remembering when the owner was last told about low disk. */
	STATE_FILENAME: 'disk-janitor-state.json',
	/**
	 * Directory, relative to the repo's main worktree, where agent tools
	 * (Claude Code subagents, Crewly agents) create per-task worktrees.
	 */
	AGENT_WORKTREE_DIR: '.claude/worktrees',
	/**
	 * Directory name under the system temp dir (`/tmp`, `os.tmpdir()`) that
	 * the developer role prompt tells agents to put worktrees in.
	 */
	TMP_WORKTREE_DIR: 'crewly-worktrees',
	/**
	 * Directory owned by the per-WorkItem worktree feature (#814), which does
	 * its own WorkItem-aware cleanup. The janitor never touches it.
	 */
	MANAGED_WORKTREE_DIR: '.crewly/worktrees',
	/**
	 * Branch-name prefixes that only agents create. A worktree elsewhere on
	 * disk with such a branch counts as an agent location (2 h idle threshold
	 * instead of 24 h). `worktree-agent-` is Claude Code's automatic subagent branch.
	 */
	AGENT_BRANCH_PREFIXES: ['worktree-agent-'] as readonly string[],
	/** Branches that are never deleted, whatever the verdict. */
	PROTECTED_BRANCHES: ['main', 'master', 'develop', 'HEAD'] as readonly string[],
	/** Timeout of one local git command (ms). */
	GIT_TIMEOUT_MS: 30_000,
	/** Timeout of `git fetch` (ms). */
	FETCH_TIMEOUT_MS: 60_000,
	/** Timeout of one `gh` call (ms). */
	GH_TIMEOUT_MS: 20_000,
	/** Timeout of the process-cwd probe (`lsof`) (ms). */
	CWD_PROBE_TIMEOUT_MS: 20_000,
	/** Max PRs `gh pr list --head <branch>` returns per branch. */
	GH_PR_LIMIT: 20,
	/** Max bytes of command output kept (stdout/stderr each). */
	MAX_OUTPUT_BYTES: 16 * 1024 * 1024,
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
	/**
	 * A recurring trigger with `maxFires` that has this many fires or fewer
	 * left gets one heads-up work item to its team lead (renew or ask the
	 * owner). It is never renewed automatically.
	 */
	EXPIRY_NOTICE_REMAINING_FIRES: 3,
	/** Most cron steps walked when projecting a trigger's final fire time. */
	PROJECTION_MAX_STEPS: 400,
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
 * Start-up states shared by every CLI runtime that cannot resolve without the
 * user, so the agent start must fail fast (see {@link CLAUDE_STARTUP_CONSTANTS}
 * for the Claude-specific ones and the shared error code).
 */
export const RUNTIME_STARTUP_CONSTANTS = {
	/**
	 * The command each CLI runtime launches. When the shell reports it as
	 * missing, no retry can help until the user installs it.
	 */
	CLI_BINARIES: {
		'claude-code': 'claude',
		'gemini-cli': 'gemini',
		'codex-cli': 'codex',
		'opencode-cli': 'opencode',
	} as Readonly<Partial<Record<string, string>>>,
	/**
	 * HTTP status of POST /api/teams/:id/start when no member could start
	 * (424 Failed Dependency: the runtime needs the user first). The dashboard
	 * shows `error` for any non-2xx answer.
	 */
	NONE_STARTED_HTTP_STATUS: 424,
	/** Human names used in start-up errors. */
	CLI_LABELS: {
		'claude-code': 'Claude Code',
		'gemini-cli': 'Gemini CLI',
		'codex-cli': 'Codex CLI',
		'opencode-cli': 'OpenCode',
	} as Readonly<Partial<Record<string, string>>>,
	MESSAGES: {
		/** Gemini started without a key or a Google login and asks how to sign in. */
		GEMINI_AUTH_REQUIRED:
			'Gemini CLI is not signed in: it is asking how to authenticate. Add a Gemini API key in Crewly Settings (or set GEMINI_API_KEY), or run `gemini` once in a terminal and choose "Sign in with Google", then start the team again.',
		/**
		 * Gemini sees GEMINI_API_KEY in the agent's shell, but no sign-in method is
		 * saved and Crewly's own environment/settings has no key to pre-select it.
		 */
		GEMINI_AUTH_KEY_NOT_SELECTED:
			'Gemini CLI found a GEMINI_API_KEY in the agent shell, but no sign-in method is selected, so it is waiting for an answer. Add the key in Crewly Settings (Crewly then selects "Use Gemini API Key" for you), or run `gemini` once in a terminal and choose "Use Gemini API Key", then start the team again.',
		/** Appended after "<Runtime> (`<binary>`) is not installed" for a missing CLI. */
		RUNTIME_NOT_INSTALLED_HINT:
			'Install it (see `crewly doctor`), or pick an installed runtime in Crewly Settings, then start again.',
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
	/**
	 * An exit with no recognised cause this soon after monitoring started is
	 * recorded as `startup_exit`, not `idle_exit` (#791): no runtime idles
	 * out in its first minute, so calling it idle hides the real cause.
	 */
	EARLY_EXIT_WINDOW_MS: 60_000,
	/** Characters of cleaned terminal output logged with an unexplained exit (#791) */
	EXIT_DIAGNOSTIC_TAIL_CHARS: 1500,
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

/**
 * Fresh conversation per new task for Claude Code team members (never the
 * orchestrator): before a work item with a different root than the last one
 * is delivered, the old conversation is saved (handover file + memory) and
 * `/clear`ed, so a small new task does not re-read hundreds of thousands of
 * tokens of unrelated history on every turn.
 */
export const FRESH_TASK_CONVERSATION_CONSTANTS = {
	/** Kill-switch env var; `0` / `false` / `off` disables the feature */
	ENV_TOGGLE: 'CREWLY_FRESH_TASK_CONVERSATION',
	/** Under CREWLY_HOME: `{ [session]: lastDeliveredRootId }` */
	STATE_FILE: 'fresh-task-conversation.json',
	/**
	 * Id suffixes that mark follow-ups of the same task (retries, verifies,
	 * reviews). Deliberately excludes give-up recovery's `:giveup:N` (#841,
	 * #843): a give-up retry is meant to be a materially DIFFERENT approach,
	 * and its WorkItem description already carries the full attempt log, so
	 * nothing is lost by treating it as a new root — the agent starts that
	 * retry with a fresh conversation instead of one anchored on the
	 * reasoning that just failed. See give-up-recovery.service.ts buildRetry.
	 */
	ROOT_SUFFIX_MARKERS: [':retry:', ':verify:', ':review:'],
	/** The Claude Code command that starts a new conversation */
	CLEAR_COMMAND: '/clear',
	/** Pause between Escape and the command (same as context compaction) */
	ESCAPE_DELAY_MS: 200,
	/** Wait after `/clear` for the prompt to come back before the task is written */
	POST_CLEAR_READY_MS: 2_000,
	/** PTY must have been quiet at least this long for the agent to count as idle */
	MIN_QUIET_MS: 8_000,
	/** Skip clearing when someone else delivered a message to the session this recently */
	RECENT_DELIVERY_MS: 30_000,
	/**
	 * A task started longer ago than this is work in progress: a re-delivery
	 * of it (auto-claim after the lead's direct hand-over) must not clear.
	 * Auto-claim itself starts the item moments before delivering.
	 */
	ALREADY_STARTED_MS: 60_000,
	/** How long a terminal write/deliver waits for an in-progress clear */
	WAIT_IF_CLEARING_MAX_MS: 5_000,
	/** How long to look for the new transcript Claude Code starts after `/clear` */
	NEW_SESSION_DETECT_MS: 30_000,
	/** Poll interval while looking for the new transcript */
	NEW_SESSION_POLL_MS: 1_000,
	/** Cap on the handover text stored through memory (mirrored into the wiki) */
	MEMORY_MAX_CHARS: 4_000,
	/** Members start fresh at launch when their last turn carried this many tokens. Env: CREWLY_MEMBER_FRESH_CONTEXT_TOKENS */
	MEMBER_FRESH_CONTEXT_TOKENS: 150_000,
	/**
	 * Idle-boundary context cap: a Claude Code member (never the orchestrator)
	 * whose last turn carried more than this many tokens is saved (handover +
	 * wiki) and cleared between turns, then re-oriented on its WorkItem. One
	 * long task can otherwise run 1000+ turns at 650k–965k context.
	 */
	MEMBER_CONTEXT_CAP_TOKENS: 300_000,
	/** Env override for {@link MEMBER_CONTEXT_CAP_TOKENS}; `0` disables the cap */
	MEMBER_CONTEXT_CAP_ENV: 'CREWLY_MEMBER_CONTEXT_CAP_TOKENS',
	/** At most one context-cap clear per session in this window */
	CONTEXT_CAP_MIN_INTERVAL_MS: 20 * 60_000,
	/**
	 * The PTY must have been quiet this long before a context-cap clear —
	 * longer than {@link MIN_QUIET_MS} because nothing is waiting on it and a
	 * turn that merely paused must not be cut.
	 */
	CONTEXT_CAP_MIN_QUIET_MS: 30_000,
	/** How often the context-cap sweep checks members */
	CONTEXT_CAP_SWEEP_MS: 60_000,
	/** Tag on the re-orientation line written after a context-cap clear */
	CONTEXT_CAP_TAG: '[CREWLY-CONTEXT-CAP]',
} as const;

/**
 * Cooperation between a direct task hand-over (team-leader delegate-task:
 * `/task-pool/add`, then `/terminal/:s/deliver` with the full brief) and the
 * WorkItem dispatcher's `workitem:queued` push, so a task reaches its agent
 * once and the fresh-conversation clear happens once, before that delivery.
 */
export const DIRECT_DELIVERY_CONSTANTS = {
	/** WorkItem metadata flag set by callers that deliver the task text themselves */
	METADATA_FLAG: 'directDelivery',
	/**
	 * How long the dispatcher holds off a `workitem:queued` push for a
	 * direct-delivery WorkItem. Covers the delegate-task ladder: deliver
	 * (15 s ready wait) → force → auto-start + 10 s + deliver (30 s). After
	 * this, if nobody delivered it, the dispatcher pushes its brief.
	 */
	GRACE_MS: 90_000,
} as const;

/**
 * Codes the member-start endpoint answers with when a start gate refuses a
 * wake (`POST /api/teams/:teamId/members/:memberId/start`).
 */
export const AGENT_WAKE_ERROR_CODES = {
	/** Wake gate: no queued/blocked WorkItem for the member */
	NO_POOL_WORK: 'wake_gate_no_pool_work',
	/** Commitment-approval gate: cold launch of a dormant team without the owner's OK */
	OWNER_APPROVAL_REQUIRED: 'commitment_requires_owner_approval',
} as const;

/**
 * Who leads a team — one rule for the whole harness
 * (specs/2026-09-30-team-lead-rule.md, `utils/team.utils.ts`): the team's
 * explicit `leaderIds` (or the deprecated `leaderId`) when set, otherwise
 * the members whose role is one of {@link TEAM_LEAD_CONSTANTS.LEAD_ROLES}.
 */
export const TEAM_LEAD_CONSTANTS = {
	/** Roles that make a member a team lead when the team names no lead explicitly */
	LEAD_ROLES: ['team-leader', 'tech-lead'],
	/** `POST /api/teams/:id/lead` modes: replace the leads, or add one more */
	SET_LEAD_MODES: ['set', 'add'],
} as const;

/**
 * Default model for Claude Code team members that have no `modelId`: members
 * with a reviewer above them run on Sonnet, leads (and anyone without a
 * reviewer) keep Claude Code's own default (Opus). Never the orchestrator.
 */
export const MEMBER_MODEL_DEFAULT_CONSTANTS = {
	/** Model passed to reviewed members when nothing else is set */
	DEFAULT_REVIEWED_MEMBER_MODEL: 'sonnet',
	/** Env override for that model; `''` or `off` disables the default entirely */
	ENV_OVERRIDE: 'CREWLY_MEMBER_DEFAULT_MODEL',
	/** Roles that lead a team and therefore keep the runtime default (same list as {@link TEAM_LEAD_CONSTANTS.LEAD_ROLES}) */
	LEAD_ROLES: TEAM_LEAD_CONSTANTS.LEAD_ROLES,
	/** Rejections of the same task after which the reviewer is told about the upgrade option */
	UPGRADE_HINT_AFTER_REJECTIONS: 2,
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

/**
 * Owner approval of held browser actions (irreversible clicks): Slack
 * decision cards, persistence across restarts, and the answer deadline.
 */
export const BROWSER_APPROVAL_CONSTANTS = {
	/** Pending held actions under CREWLY_HOME */
	STORE_FILENAME: 'browser-pending-actions.json',
	/** The owner has this long to answer; then the answer is No (ms) */
	DEADLINE_MS: 2 * 60 * 60 * 1000,
	/** After a restart, how long a held action may wait for its tab to come back (ms) */
	REBIND_GRACE_MS: 2 * 60 * 1000,
	/** Retry / expiry evaluation cadence (ms) */
	TICK_MS: 30 * 1000,
	/** A card that could not be created is retried at most this often (ms) */
	CARD_RETRY_MS: 2 * 60 * 1000,
	/** Settled records are kept this long, then pruned (ms) */
	KEEP_SETTLED_MS: 7 * 24 * 60 * 60 * 1000,
	/** Option labels of the card */
	APPROVE_LABEL: 'Let it',
	REJECT_LABEL: 'No',
	/** What a held agent is told to say — the one place the owner answers is the card */
	AGENT_SAYS: "I've asked the owner with a card in this thread; wait for their answer.",
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

/**
 * Owner input into a browser session the owner has taken over
 * (`POST /api/browser/sessions/:id/input`). The owner is usually on a phone,
 * tapping a picture of the page, so every limit here is about keeping one tap
 * or one "Send" a single bounded action.
 */
export const BROWSER_OWNER_INPUT_CONSTANTS = {
	/** Longest text one `type` may carry (characters) */
	MAX_TEXT_LENGTH: 2_000,
	/** Longest URL one `navigate` may carry (characters) */
	MAX_URL_LENGTH: 4_096,
	/** Largest single scroll step either way (CSS px) */
	MAX_SCROLL_PX: 5_000,
	/**
	 * How long a measured viewport is trusted before a tap measures again
	 * (ms). Each measurement is a round trip to the extension, which over the
	 * relay is the slowest part of a tap.
	 */
	VIEWPORT_CACHE_MS: 15_000,
	/** Keys the owner can press from the control bar */
	KEYS: ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown'] as const,
	/** How far an arrow key scrolls when focus is not in a text field (CSS px) */
	ARROW_SCROLL_PX: 40,
	/** Command timeout for one owner action (ms) */
	COMMAND_TIMEOUT_MS: 15_000,
	/**
	 * Pause after a tap, key or Back before the fresh frame is captured (ms),
	 * so the picture sent back shows what the action did rather than the
	 * instant before it. Navigation needs none: it waits for the page load.
	 */
	SETTLE_BEFORE_FRAME_MS: 350,
	/**
	 * Page-quiet wait before a tap is clicked (ms). The extension's click
	 * waits for the page to go idle (default up to 2 s) because an agent
	 * clicks blind; the owner is looking at the page, so a tap should land
	 * when they tapped.
	 */
	TAP_IDLE_QUIET_MS: 50,
	/** Longest the extension may wait for that quiet before clicking (ms) */
	TAP_IDLE_MAX_WAIT_MS: 300,
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
	 * How many earlier transcripts of a session keep their read offset.
	 * A session that switches between the owner's Claude Code accounts, or
	 * gets a new conversation, can come back to a transcript it already
	 * read; the remembered offset keeps it from being counted twice.
	 */
	MAX_REMEMBERED_TRANSCRIPTS: 8,
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
 * - Antigravity CLI: none (it compacts by itself)
 */
export const RUNTIME_COMPACT_COMMANDS: Record<RuntimeType, string> = {
	'claude-code': '/compact',
	'gemini-cli': '/compress',
	'codex-cli': '/compact',
	'opencode-cli': '/compact',
	// Antigravity compacts on its own ("Conversation compacted") and has no
	// compact slash command; its context use is not painted on screen either.
	'antigravity-cli': '',
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
 * Keyed by runtime: a session is only checked against its own runtime's
 * sign-in screens (unknown runtime → every set). Incident 2026-09-29: a
 * Claude Code agent summarising OpenAI news wrote "…Sign in with ChatGPT…"
 * in its reply and the Codex pattern paged the owner.
 *
 * Each entry is a set of substrings that must ALL be present (AND logic,
 * case-insensitive) in the recent screen text. Plain string matching — no
 * regex — to stay ReDoS-free.
 */
export const LOGIN_REQUIRED_PATTERN_SETS: Readonly<Record<string, readonly (readonly string[])[]>> = {
	'codex-cli': [
		// Device-code flow (headless-friendly)
		['auth.openai.com/codex/device'],
		// Default sign-in menu: both options, so a sentence naming one is not a screen
		['sign in with chatgpt', 'provide your own api key'],
	],
	'claude-code': [
		['claude.ai/oauth/authorize'],
		['use the url below to sign in'],
		['paste code here if prompted'],
		['please run /login'],
	],
	'gemini-cli': [
		['login with google'],
	],
	'opencode-cli': [
		// `/connect` provider dialog and the "no provider yet" footer
		['connect a provider'],
		['get started', '/connect'],
	],
};

/**
 * Where on a captured screen a sign-in prompt can actually be. A sign-in
 * screen is the runtime's own UI at the bottom of the terminal, never a line
 * of the agent's transcript and never shown while a turn is running.
 */
export const LOGIN_SCREEN_REGION = {
	/** Trailing non-empty lines inspected for a sign-in prompt */
	TAIL_LINES: 15,
	/**
	 * Line starts that open a block of the agent's own transcript (Claude's
	 * `⏺` reply / `⎿` tool result, Codex's `•` / `└`, Gemini's `✦`). The
	 * block continues over blank lines and lines indented by at least
	 * {@link LOGIN_SCREEN_REGION.TRANSCRIPT_INDENT} spaces.
	 */
	TRANSCRIPT_MARKERS: ['⏺', '⎿', '•', '└', '✦'] as readonly string[],
	/** Indent of a transcript block's continuation lines */
	TRANSCRIPT_INDENT: 2,
	/**
	 * Lower-case footer text of a runtime that is busy or sitting at its chat
	 * prompt; a sign-in screen shows neither, so any of these vetoes a match.
	 */
	NOT_SIGN_IN_MARKERS: ['esc to interrupt', 'working (', 'ask codex to do anything', '? for shortcuts'] as readonly string[],
} as const;

/**
 * Screen text that means the runtime has just *finished* signing in. The
 * capture window can still hold the earlier sign-in screen above it, so
 * these veto a {@link LOGIN_REQUIRED_PATTERN_SETS} match and let the
 * "Sign-in needed" flag clear. Lower-case substrings.
 */
export const LOGIN_COMPLETED_MARKERS: readonly string[] = [
	// Codex 0.158 post-login notice ("✓ Signed in with your ChatGPT account … Press enter to continue")
	'signed in with your chatgpt account',
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
	ANTIGRAVITY_CLI: {
		/**
		 * Antigravity (`agy` 1.2.x) keeps its `>` input box painted while the
		 * model runs, and echoes every submitted message as `> text`, so the
		 * idle signal is the `? for shortcuts` footer (see isPromptLine) and
		 * these markers veto it: the busy footer / spinner label, the
		 * double-press exit hint, tool-approval dialogs, and the first-run,
		 * folder-trust and account sign-in screens. Captured from agy 1.2.11
		 * in a PTY (2026-09-25); the approval and sign-in strings come from
		 * the agy binary because they cannot be shown without a model turn or
		 * an account login.
		 */
		NOT_READY_MARKERS: [
			'esc to cancel',
			'generating...',
			'press ctrl+c again to exit',
			'press ctrl+d again to exit',
			'run this command?',
			'accept this file edit?',
			'do you trust the contents of this project?',
			'choose your color scheme',
			'terms of service & data use',
			'select login method',
			'you are currently not signed in',
			'waiting for authentication',
		],
	},
} as const;

/** Reasoning-effort levels `agy --effort` accepts (from `agy --help`, 1.2.11). */
export const ANTIGRAVITY_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'max'];

/**
 * Facts about Google Antigravity CLI (`agy`) that Crewly relies on.
 *
 * Sources: https://antigravity.google/docs/cli/install/ and
 * https://antigravity.google/docs/cli/headless/ (read 2026-09-25), plus the
 * screens of agy 1.2.11 captured in a PTY with a sandboxed HOME and a dummy
 * key. See specs/antigravity-runtime.md.
 *
 * Policy: Google prohibits third-party tools from using Antigravity (or
 * Gemini CLI) product OAuth, so Crewly only ever runs agy with a Gemini API
 * key: `modelProvider: "gemini"` in agy's settings file plus
 * `GEMINI_API_KEY` in the environment. With that provider agy "never
 * establishes an account session", even when the machine has an account
 * login in its keyring.
 */
export const ANTIGRAVITY_CONSTANTS = {
	/** Binary name on PATH (the installer puts it in ~/.local/bin) */
	BINARY: 'agy',
	/**
	 * Default launch command. `--dangerously-skip-permissions` approves tool
	 * calls (shell commands included); `--mode=accept-edits` approves file
	 * edits, which the docs govern separately from tool permissions.
	 */
	LAUNCH_COMMAND: 'agy --dangerously-skip-permissions --mode=accept-edits',
	/** The only env var agy reads a Gemini key from (not GOOGLE_API_KEY, not .env) */
	API_KEY_ENV: 'GEMINI_API_KEY',
	/** Stops agy's background self-updater from replacing the binary mid-task */
	DISABLE_AUTO_UPDATE_ENV: 'AGY_CLI_DISABLE_AUTO_UPDATE',
	DISABLE_AUTO_UPDATE_VALUE: 'true',
	/** agy's config dir, relative to $HOME */
	CONFIG_DIR_SEGMENTS: ['.gemini', 'antigravity-cli'] as readonly string[],
	/** agy's user settings file inside the config dir */
	SETTINGS_FILE: 'settings.json',
	/** Mode agy itself writes its settings file with */
	SETTINGS_FILE_MODE: 0o600,
	/** Settings key + the only accepted value that selects the Gemini API key provider */
	MODEL_PROVIDER_KEY: 'modelProvider',
	MODEL_PROVIDER_GEMINI: 'gemini',
	/** Settings key listing folders the user trusted (skips the folder-trust screen) */
	TRUSTED_WORKSPACES_KEY: 'trustedWorkspaces',
	/** One `<conversation id>.db` per conversation, created at the first prompt */
	CONVERSATIONS_DIR: 'conversations',
	CONVERSATION_FILE_EXT: '.db',
	/** Workspace path → most recent conversation id (what `agy -c` reads) */
	LAST_CONVERSATIONS_FILE_SEGMENTS: ['cache', 'last_conversations.json'] as readonly string[],
	/** Resume flag: `agy --conversation=<id>` (printed by agy itself on exit) */
	RESUME_FLAG: '--conversation',
	/** Launch flag that adds a folder to the workspace (repeatable) */
	ADD_DIR_FLAG: '--add-dir',
	/** Slash command that adds a folder to a running session's workspace */
	ADD_DIR_COMMAND: '/add-dir',
	/**
	 * How long to look for a fresh agent's conversation id. agy creates the
	 * conversation only when the first prompt (the registration kickoff)
	 * arrives, which can be ~90 s after launch.
	 */
	CONVERSATION_DISCOVERY_TIMEOUT_MS: 5 * 60 * 1000,
	CONVERSATION_DISCOVERY_INTERVAL_MS: 2_000,
	/** Official installer; fetched only from this exact https URL */
	INSTALL_SCRIPT_URL: 'https://antigravity.google/cli/install.sh',
	/** Update subcommand, used when agy is already installed */
	UPDATE_ARGS: ['update'] as readonly string[],
	/** Where users create a Gemini API key */
	API_KEY_CONSOLE_URL: 'https://aistudio.google.com/apikey',
	/** Cheap authenticated call used to check a pasted key (key sent as a header, never in the URL) */
	GEMINI_API: {
		MODELS_URL: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
		KEY_HEADER: 'x-goog-api-key',
		CHECK_TIMEOUT_MS: 10_000,
		/** Statuses that mean the key itself is unusable (400 API_KEY_INVALID, 401, 403 PERMISSION_DENIED) */
		REJECTED_STATUSES: [400, 401, 403] as readonly number[],
	},
	/** Screen text (agy 1.2.11), matched as plain substrings */
	SCREEN: {
		/** Idle footer, shown only while the prompt box is empty and nothing runs */
		IDLE_FOOTER: '? for shortcuts',
		/** Header line when the Gemini API key provider is active (instead of an account email) */
		API_KEY_HEADER: 'Gemini API key',
		/** Placeholder of the empty prompt box in accept-edits mode */
		ACCEPT_EDITS_PLACEHOLDER: 'Accept-edits mode: file edits auto-approved',
		/** Folder-trust screen and its pre-selected "yes" option */
		TRUST_PROMPT: 'Do you trust the contents of this project?',
		TRUST_ACCEPT_OPTION: 'Yes, I trust this folder',
		/** First-run onboarding (colour scheme, then Terms of Service and data use) */
		FIRST_RUN_MARKERS: ['Welcome to Antigravity CLI!', 'Choose your color scheme:', 'Terms of Service & Data Use'] as readonly string[],
		/** Account sign-in screens (from the binary): agy is NOT on the API-key provider */
		ACCOUNT_LOGIN_MARKERS: [
			'Select login method:',
			'Other sign-in options',
			'You are currently not signed in.',
			'Waiting for authentication...',
			'Select Google Cloud sign-in method:',
		] as readonly string[],
		/** agy's own startup refusal when the provider is gemini but the key env var is empty */
		MISSING_KEY_ERROR: 'but the GEMINI_API_KEY environment variable is not set',
		/** A rejected key surfaces on the first turn */
		INVALID_KEY_ERROR: 'API_KEY_INVALID',
		/** Printed on exit, before `agy --conversation=<id>` */
		EXIT_RESUME_HINT: 'Resume with -c (or command below):',
		/** Confirmation of `/add-dir <path>` */
		ADD_DIR_CONFIRMATION: 'to workspace',
	},
	MESSAGES: {
		NO_API_KEY:
			'Antigravity CLI runs in Crewly only with a Gemini API key, and none is saved. Add one in Settings → Runtimes → Antigravity CLI (or run `crewly login antigravity`), then start the agent again. Crewly never uses a Google account login for Antigravity.',
		KEY_NOT_IN_SESSION:
			'Antigravity CLI started without GEMINI_API_KEY in its environment, so it refused to run (Crewly never lets it fall back to a Google account). Save the Gemini API key in Settings → Runtimes → Antigravity CLI (or run `crewly login antigravity`) — a key saved there is given to every Antigravity session at start — then start the agent again.',
		ACCOUNT_LOGIN:
			'Antigravity CLI asked for a Google account sign-in. Crewly does not use Antigravity account (OAuth) login — Google does not allow third-party tools to — so the agent was stopped. Check that a Gemini API key is saved in Settings → Runtimes, then start the agent again.',
		FIRST_RUN:
			'Antigravity CLI has not been set up on this machine yet: it shows its first-run screens (colour scheme, Google\'s Terms of Service and data use), which only you can accept. Crewly has sent you a card in Slack (a DM from this machine\'s Crewly Orc) to agree or not; you can also answer in Settings → Runtimes → Antigravity CLI → Accept terms…. Then start the agent again.',
		SETTINGS_UNREADABLE:
			'Crewly could not switch Antigravity CLI to your Gemini API key because ~/.gemini/antigravity-cli/settings.json is not valid JSON. Fix or remove that file, then start the agent again.',
		SETTINGS_WRITE_FAILED:
			'Crewly could not write ~/.gemini/antigravity-cli/settings.json to switch Antigravity CLI to your Gemini API key, so the agent was not started (it would otherwise fall back to a Google account login). Check that the file and its folder are writable, then start the agent again.',
	},
} as const;

/**
 * Owner consent for a runtime's first-run Terms of Service, asked with a
 * Slack decision card; the harness never accepts third-party terms on its
 * own. specs/2026-10-01-runtime-terms-consent.md
 */
export const RUNTIME_TERMS_CONSTANTS = {
	/** Per-machine consent state under CREWLY_HOME */
	STORE_FILENAME: 'runtime-terms-consent.json',
	/** How long the owner has to answer; then the default (Don't agree) applies */
	DEADLINE_MS: 24 * 60 * 60 * 1000,
	/** Card buttons, in order (the third is the default) */
	OPTIONS: {
		AGREE_NO_DATA: 'Agree, no data sharing',
		AGREE_SHARE_DATA: 'Agree + share data',
		DECLINE: "Don't agree",
	},
	/** Name prefix of the dedicated PTY session the harness drives */
	SESSION_PREFIX: 'crewly-terms-',
	/** Size of that session (wide enough that the screens do not wrap) */
	COLS: 120,
	ROWS: 40,
	/** Driving the first-run screens */
	DRIVE: {
		/** Screen read cadence */
		POLL_MS: 300,
		/** After a key: how long to wait for the screen to change */
		KEY_SETTLE_MS: 3_000,
		/** Waiting for the first screen after launch */
		LAUNCH_TIMEOUT_MS: 60_000,
		/** The same unrecognised screen for this long = abort */
		UNKNOWN_SCREEN_TIMEOUT_MS: 20_000,
		/** After Done: waiting for the main prompt */
		PROMPT_TIMEOUT_MS: 90_000,
		/** Upper bound on keys sent (a loop that does not converge aborts) */
		MAX_KEYS: 60,
		/** Screen lines quoted in the card thread on an abort */
		SCREEN_LINES_IN_THREAD: 40,
	},
	/** Antigravity CLI (agy 1.2.14) first-run screens, matched as text */
	ANTIGRAVITY: {
		WELCOME: 'Welcome to Antigravity CLI!',
		COLOR_SCHEME_TITLE: 'Choose your color scheme:',
		/** Schemes in screen order; the first is the default Crewly keeps */
		COLOR_SCHEMES: [
			'terminal',
			'light',
			'solarized light',
			'colorblind-friendly light',
			'dark',
			'solarized dark',
			'colorblind-friendly dark',
			'tokyo night',
		] as readonly string[],
		DEFAULT_COLOR_SCHEME: 'terminal',
		MIGRATION_TITLE: 'Migration options:',
		IMPORT_ITEM: 'Import extensions from Gemini CLI',
		NEXT_BUTTON: 'Next',
		TERMS_TITLE: 'Terms of Service & Data Use',
		/** Start of the pre-checked data-sharing item */
		DATA_ITEM: 'Yes, I agree to help improve Antigravity CLI',
		DATA_ITEM_FULL:
			'Yes, I agree to help improve Antigravity CLI by allowing Google to collect and use my Interactions data, subject to the Google Antigravity CLI Terms of Service and Google Privacy Policy. I understand I can choose to opt out later whenever I want via my settings.',
		PREVIOUS_BUTTON: 'Previous',
		DONE_BUTTON: 'Done',
		TERMS_URL: 'https://antigravity.google/terms',
		PRIVACY_URL: 'https://policies.google.com/privacy',
		SECURITY_NOTE:
			'AI coding agents can run code on their own, leak data, follow injected prompts and pull in compromised packages, so their actions should be watched.',
	},
	MESSAGES: {
		DECLINED_BY_OWNER: "You chose Don't agree",
		DECLINED_BY_DEADLINE: "No answer within 24 h, so the default (Don't agree) applied",
		PENDING: 'Waiting for you to accept its Terms of Service (Slack card, or Settings → Runtimes → Accept terms…)',
		DECLINED_SUFFIX: 'Terms not accepted',
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
		/** GET ?token=&returnUrl=&products=&loginHint=&authorizedBy= → 302 to Google consent */
		START: '/start',
		/** POST { email, authorizedBy?, sharing? } → { authorizedBy, sharing } — who owns a grant and who it is shared with (issue #968) */
		SHARING: '/sharing',
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
		/** POST { authorizedBy?, sharing? } → { authorizedBy, sharing } — who owns the grant and who it is shared with (issue #968) */
		SHARING: '/sharing',
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
		/** POST { authorizedBy?, sharing? } → { authorizedBy, sharing } — who owns the grant and who it is shared with (issue #968) */
		SHARING: '/sharing',
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
	/** Most steps (Graph `checklistItems`) one call may add to a task (#835) */
	STEPS_MAX_PER_CALL: 50,
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
 * Daily owner receipt (#828): one phone-readable message every evening with
 * every ask of the window, its outcome and link, what waits on the owner, and
 * what it cost. See specs/owner-receipt.md.
 */
export const OWNER_RECEIPT_CONSTANTS = {
	/** Default local send time (HH:MM, 24h) */
	DEFAULT_TIME: '21:00',
	/** Default owner time zone (same default as team-health off-hours) */
	DEFAULT_TIMEZONE: 'America/New_York',
	/** How often the scheduler checks whether it is time (ms) */
	TICK_INTERVAL_MS: 60 * 1000,
	/** Settings + last-sent state, under ~/.crewly */
	STATE_FILENAME: 'owner-receipt.json',
	/** An ask is shortened to this many characters (CJK count double) */
	MAX_ASK_WEIGHTED_LENGTH: 56,
	/** A waiting-on-you question is shortened to this many characters */
	MAX_QUESTION_WEIGHTED_LENGTH: 90,
	/** Ask lines in the Slack message before "另有 N 件" (phone length) */
	MAX_ASK_LINES: 30,
	/** Waiting-on-you lines before "另有 N 件" */
	MAX_WAITING_LINES: 12,
	/** 「可能漏记」 lines: appended messages that still read like a request (#828 coverage) */
	MAX_POSSIBLY_MISSED: 5,
	/** Team label for a ticket nobody is assigned to */
	UNASSIGNED_TEAM: 'Unassigned',
	/**
	 * The redesigned receipt (owner, 2026-09-28: 14 asks + 17 「等你拍板」 with
	 * ticket numbers was overwhelming): at most this many 「今天做完的」 lines…
	 */
	MAX_HIGHLIGHTS: 3,
	/** …and this many 「需要你决定的」 lines; the rest is 「另有 N 件，在看板上」 */
	MAX_DECISIONS: 3,
	/** A deliverable older than this is no longer put in front of the owner (ms) */
	DECISION_MAX_AGE_MS: 3 * 24 * 60 * 60 * 1000,
	/** One receipt line is cut (at a phrase boundary) to this weighted length */
	MAX_LINE_WEIGHTED_LENGTH: 64,
	/** A summary line shorter than this (weighted) says nothing; the next line is used */
	MIN_SUMMARY_WEIGHTED_LENGTH: 12,
	/** How the orchestrator is named on the receipt (it is in no team) */
	ORCHESTRATOR_LABEL: 'Orc',
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
	/**
	 * #828 coverage: one JSON line per owner message intake handled
	 * (created / appended / ignored + reason), next to the Request files. The
	 * first line records when counting started, so a window that begins
	 * earlier is reported as unknown (不详), never as 0.
	 */
	INTAKE_LOG_FILENAME: '.intake-outcomes.jsonl',
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
	/** Tag on a ticket an agent split out of another (#827) */
	SPLIT_TAG: 'split',
	/** A bare "don't track" reply dismisses the ticket it answers */
	DISMISS_PATTERN: /^\s*(不用记|别记|不用记录|不要记|取消记录|don'?t track|do not track|no ticket)\s*[。.!！]*\s*$/i,
	/**
	 * Ask classifier (#827): is an owner message a new ask, or a follow-up on
	 * the thread's current deliverable? Deterministic, text only. Every
	 * pattern below was taken from real owner messages of 2026-09-25/26 — see
	 * ticket-ask-classifier.test.ts for the labelled set. Scoring and the
	 * tie rule live in ticket-ask-classifier.ts.
	 */
	ASK: {
		/** A request verb: something to go and do (+2 ask) */
		REQUEST_VERB: /(研究|调研|查一下|查查|搜一下|搜索一下|搜搜|搜一搜|找一下|找找|(看看|看一下|看下)(?!上面|这个|吧|吗|嘛|呢|[？?。!！~]|\s*$)|了解一下|分析一下|深挖|挖一下|总结|汇总|对比|比较一下|开\s*(个|一个|几个)?\s*issues?|提\s*(个|一个)?\s*issues?|发给|发到|做成|生成|加到|添加|帮我|帮忙|给我(讲讲|发|找|整理|列)|给我看看\S|告诉我|按\s*\S{1,12}\s*(分组|归类|group)|\bgroup\b|让\S{1,12}去|monitor|盯一下|提醒我|跑一下|部署|\bresearch\b|look into|dig into|find out|summari[sz]e|\bcompare\b|(open|file|create)\s+(the\s+\S+\s+to\s+)?(an?\s+|github\s+)?issues?|github issues?|write (up|a |an )|\bdraft\b|tell me|explain)/i,
		/**
		 * An explicit request construction (+3 ask instead of +2). Survives the
		 * long-discussion damping: 「你能不能帮我…总结成一个MD文档」 inside a
		 * voice transcript is still an ask.
		 */
		STRONG_REQUEST: /(你能不能帮我|能不能帮我|你能帮我|我希望你|希望.{0,4}你们?(能|可以)|我建议你|需要你去|(?<!谢谢)你帮我(?!\s*draft)|帮我把|创建对应的|创建一个)/,
		/** A question that asks for information (+1 ask; on its own, a question ticket) */
		INFO_QUESTION: /(是什么|什么意思|是讲什么|讲的是什么|是啥|怎么回事|区别|有什么值得|有什么可以|能有什么|有哪些|都有什么|有几个|有多少|有没有|what is|what's|what does|what even|how does|how do)/i,
		/** The message points at something to look at: a link, an image, a file path */
		REFERENCE: /(https?:\/\/|\[Slack (Image|File):|[\w-]+\/[\w./-]+\.(md|pdf|png|jpe?g))/i,
		/** A bare 「看看」 (look) — an ask only when it has a reference to look at */
		LOOK: /(看看|看一下|看下|看一看)/,
		/** Opens a new topic, near the start (+1 ask) */
		NEW_TOPIC: /^.{0,6}(另外|还有一个|还有个|另一个|新的想法|有一个新的|对了)/,
		/** Suggests something new to do (+1 ask) */
		IDEA: /(我们(crewly)?也可以|我们可以|要不(要)?|不如|可以考虑)/i,
		/** First line is a numbered reply to the agent's list (+3 follow) */
		NUMBERED_REPLY: /^\s*(1[.、)）]|1\s|1和|关于1|①)/,
		/**
		 * How the CURRENT deliverable should be delivered (+3 follow). Needs a
		 * delivery verb: a bare `00-plan.md` path is not an instruction.
		 */
		DELIVERY_FORMAT: /((发|给我|存|转|用|通过|做成).{0,6}(pdf|md|markdown)|存到|写到.{0,20}(md|文档|issue)|放到|preview|文字稿)/i,
		/** Clarifies or corrects the work in progress (+2 follow) */
		CLARIFY: /(我只是|我的意思|我是说|除非你|不是说|不是让你|就是说|没关系|算了|先不|先留|backlog|后面再|以后再|不着急|不用了|不需要|等一下|按你说的|你决定|你来定|你们来定|请你们来|主要是)/,
		/** Feedback on the current draft (+3 follow) */
		FEEDBACK: /(基本上?可以|整体看?可以|还可以再|再斟酌|打磨|少了|多了|改成|改一下|基本对)/,
		/** Asks the agent about its own work or plan (+2 follow) */
		ABOUT_AGENT_WORK: /(你打算|你觉得|你有数|你看到|你去调研的时候|你那边|你有什么想法|你是怎么|你怎么|你有吗|我前面问|之前问|前面说了|再问一次)/,
		/**
		 * Opens by correcting or choosing (+3 follow): 「不对 我要你研究的是…」,
		 * 「不是前面…」, 「方案A」 — a reply to the agent, never a new ask.
		 */
		CORRECTION_OR_CHOICE: /^(不对|不是|不用|sorry|方案\s*[A-Za-z0-9一二三]|选\s*[A-Za-z0-9一二三]|[A-Da-d][。.，,\s]|按推荐|按你推荐)/i,
		/** 「…给我看看吗」: show me the current thing (+3 follow) */
		SHOW_ME_TAIL: /给我看看?[吗嘛呢？?\s]*$/,
		/** Retry / continue the current work (+3 follow): 「你再看看」「按你说的继续挖」 */
		RETRY_CONTINUE: /(再看看|再看一次|再试试|你再|重新|继续|接着)/,
		/** Ends as a suggestion about the current work (+3 follow): 「…添加一些截图吧？」 */
		SUGGEST_TAIL: /吧[？?]?\s*$/,
		/**
		 * What to do with the thing just discussed (+3 follow, in a thread):
		 * park it, keep it, remind me — 「A 论文那个 开个Issue吧 放到backlog」
		 * 「加到flopost的backlog」「好的 存下来」「提醒我明天做这件事」.
		 * The owner deciding about the agent's output, not a new unit of work
		 * (owner, 2026-09-28: these had become tickets of their own).
		 */
		DISPOSITION: /(backlog|存下来|记下来|记一下|收进|放到|提醒我)/i,
		/** Asks where things stand (+3 follow; top level: not an ask) */
		STATUS_PING: /(在线了吗|好了吗|怎么样了|现在呢|有听吗|进展|进度|到哪了|有数了吗|登陆了吗|登陆过了|在吗|done yet|any update|how'?s it going|\bstatus\b|right now|working on)/i,
		/**
		 * A line that approves what the agent proposed: starts with an ack and
		 * ends in approval ("好的 开issue可以的", "好的 部署吧") (+3 follow)
		 */
		APPROVAL_LINE: /^(好的?|行|可以|ok|okay|嗯+|对|对的|没问题|挺好的?)[\s，,。!！]*(\S.{0,24}?(可以的?|就行|没问题|吧)[\s。!！~]*)?$/i,
		/** A line that is only an acknowledgement (ignored when scoring the rest) */
		ACK_ONLY_LINE: /^(好的?|行|可以|ok|okay|嗯+|对|对的|没问题|挺好的?|收到|谢谢|thx|thanks)[\s，,。!！~]*$/i,
		/**
		 * Weighted length above which a message reads as spoken discussion (a
		 * voice transcript): a follow-up unless it opens a new topic (+2 follow)
		 */
		LONG_DISCUSSION_WEIGHTED_LENGTH: 300,
		/** Ends like a question (a verb-less question in a thread needs one) */
		QUESTION_MARK: /([？?吗呢]|是什么|什么意思|是啥|的区别是什么)\s*$/m,
		/** Quoted text is content, not a request: 接住“能不能帮我做” asks nothing */
		QUOTED: /“[^”]*”|「[^」]*」|"[^"]*"/g,
		/** Minimum ask score for a new ask; it must also beat the follow score (ties append) */
		MIN_ASK_SCORE: 2,
	},
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
		/**
		 * Intent categories whose answer is the whole deliverable — a shared
		 * link, a note, "按你说的来". They close when answered instead of
		 * waiting for an OK (owner, 2026-09-25: 19 tickets sat in 待验收, most
		 * of them "[Message] 看看这个 <link>" already answered).
		 */
		NO_REVIEW_CATEGORIES: ['communication'] as readonly string[],
		/** Tag on a ticket that closed because nobody objected in time */
		AUTO_ACCEPTED_TAG: 'auto_accepted',
		/**
		 * 待验收 this long after the answer with no word from the owner →
		 * accepted (ms). A hard deadline from `submittedAt`, whatever the nudges
		 * did (owner, 2026-09-28: 43 tickets sat in 待验收; the old 24h → nudge →
		 * 24h → nudge → 24h chain took 72h+ and restarted on every re-answer).
		 */
		AUTO_ACCEPT_MS: 24 * 60 * 60 * 1000,
		/**
		 * The agent that answered asks the owner itself (owner, 2026-09-24):
		 * with no word from the owner this long after the answer, the agent is
		 * nudged once to follow up in the thread, before the auto-accept.
		 */
		NUDGE_AFTER_MS: 12 * 60 * 60 * 1000,
		/** Nudges before silence counts as acceptance */
		MAX_NUDGES: 1,
		/** Tag on a ticket closed as soon as it was answered (nothing to review) */
		ANSWERED_TAG: 'answered',
		/**
		 * The owner's ask names a deliverable someone has to look at before it
		 * counts: a document, an email or a reply to send, a draft, a form, code,
		 * a deploy, money, anything sent out in his name. Only these (or an
		 * answer that asks him something) wait in 待验收; a plain answer closes.
		 */
		DELIVERABLE_ASK: /(写|起草|草稿|draft|邮件|email|e-mail|回信|回复他|回复她|回他|回她|文档|\bdoc\b|pdf|ppt|表格|sheet|表单|\bform\b|填|代码|\bcode\b|\bPR\b|pull request|部署|deploy|上线|发布|publish|发出去|发送|发给|发到|寄|付款|支付|转账|报价|合同|申请|提交|实现|implement|修复|\bfix\b|改成|改一下|做一个|做个|做成|建一个|加一个|添加|设置|配置)/i,
		/** Intent categories that always need a look (a change was made) */
		DELIVERABLE_CATEGORIES: ['code_change', 'deployment'] as readonly string[],
		/**
		 * The answer asks the owner something (a decision or an OK) — then the
		 * ticket is waiting on him even without a deliverable.
		 */
		OWNER_QUESTION: /(行吗|行不行|可以吗|好吗|对吗|要不要[^。！\n]{0,24}[？?]|要吗|需要吗|同意吗|你来定|由你定|你定吧|你定一下|你定[？?]|你选|选哪个|哪个(好|更|现实)[^。！\n]{0,12}[？?]|怎么选|\bOK\b\s*[?？]|sound good|shall I|should I|do you want)/i,
		/**
		 * A plain acknowledgement from the owner in a ticket's thread while the
		 * agent is waiting for their OK counts as the OK (「好的」「可以」「行」).
		 */
		// An @mention or a Latin first name next to it still reads as the OK
		// (「可以 Dana」, 「好的 <@U0C2ZK849ND>」).
		ACK_PATTERN: /^\s*(?:(?:<@[A-Z0-9]+>|@?[A-Za-z]{2,15})\s*[,，]?\s*)?(好的?|好滴|行|可以|可以的|ok|okay|okk|收到|嗯+|对|没问题|谢谢|thanks?|thx|👍|✅|nice|great|perfect)\s*[,，]?\s*(?:<@[A-Z0-9]+>|@?[A-Za-z]{2,15})?\s*[。.!！~～👍✅]*\s*$/iu,
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
	/**
	 * Follow-ups vs new tickets (owner, 2026-09-28): an answer to an agent's
	 * question — 「发了」「是绿卡」「A 论文那个 开个Issue吧」 — belongs to the
	 * conversation it answers, never to a ticket of its own.
	 */
	FOLLOW_UP: {
		/**
		 * A thread whose ticket finished (answered, accepted) this recently
		 * still takes follow-ups into that ticket instead of opening a new one.
		 */
		RECENT_TICKET_MS: 3 * 24 * 60 * 60 * 1000,
		/**
		 * In a DM (every message is top level) a reply this soon after the
		 * conversation's latest ticket activity is a follow-up to that ticket.
		 */
		DM_WINDOW_MS: 2 * 60 * 60 * 1000,
		/** Origins where every message is top level (DM-like conversations) */
		DM_ORIGINS: ['slack-dm', 'chat', 'portal', 'mobile'] as readonly string[],
		/**
		 * A reply this short (weighted, CJK double) is an answer, not a new
		 * ask, unless it says 「帮我…」 outright: 「可以改到10:30吗」.
		 */
		SHORT_REPLY_WEIGHTED_LENGTH: 24,
	},
	/**
	 * Tickets nobody touched for this long are closed as stale (owner,
	 * 2026-09-28): open / running with no activity; the agent reopens one by
	 * answering in its thread.
	 */
	STALE: {
		AFTER_MS: 3 * 24 * 60 * 60 * 1000,
		/** Tag on a ticket closed as stale */
		TAG: 'stale',
		/** Statuses that go stale */
		STATUSES: ['open', 'ready', 'running'] as readonly string[],
		/** Discussion note left on a ticket closed as stale */
		NOTE: 'Closed automatically after 3 days with no activity. The responsible agent can reopen it by replying in the original conversation.',
		/** Author of that note */
		NOTE_AUTHOR: 'crewly',
	},
	/**
	 * WorkItem statuses that no longer hold a ticket open once the ticket is
	 * accepted: a verify that was rejected and superseded by its retry, a
	 * failed attempt. The #467 gate treats them as open, which kept accepted
	 * tickets out of done for good (TKT-017: two `rejected` WorkItems).
	 */
	DEAD_WORK_ITEM_STATUSES: ['rejected', 'failed'] as readonly string[],
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
		ANTIGRAVITY_CLI: 'antigravity-cli',
		GEMINI_CLI: 'gemini-cli',
	},
	/**
	 * Harnesses kept working for existing and enterprise users but no longer
	 * offered to new users: Gemini CLI stopped serving individual accounts on
	 * 2026-06-18 (Antigravity CLI replaces it). Setup lists them only when
	 * already in use.
	 */
	RETIRED_IDS: ['gemini-cli'] as readonly string[],
	/** Appended to a retired harness's name wherever it is still listed */
	RETIRED_LABEL_SUFFIX: ' (enterprise only)',
	/** Harness the orchestrator uses when the owner does not choose */
	DEFAULT_ORC_HARNESS: 'claude-code',
	/** Short names accepted by `crewly login <name>` / `--harness <name>` */
	CLI_ALIASES: {
		claude: 'claude-code',
		codex: 'codex-cli',
		antigravity: 'antigravity-cli',
		agy: 'antigravity-cli',
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
		/** After a failure line, a self-exiting harness (Codex) gets this long to exit before the session fails */
		FAILURE_EXIT_GRACE_MS: 10_000,
		/** Longest (redacted) failure message written to the log */
		LOG_MESSAGE_MAX_CHARS: 300,
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
		/**
		 * Pause between typing the user's input and pressing Enter (ms). Ink TUIs
		 * (Claude's `setup-token`) read one write of "code + \r" as a paste and
		 * swallow the Enter, leaving the code sitting at the prompt
		 * (iriss-air.lan, 2026-10-01).
		 */
		SUBMIT_DELAY_MS: 300,
		/** If the login printed nothing this long after Enter, press Enter once more (ms) */
		SUBMIT_RETRY_MS: 4000,
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
		/** After a reported "expiry" turned out to be a logged-in harness, ignore reports this long */
		NOT_EXPIRED_QUIET_MS: 30 * 60 * 1000,
		/** A second expiry within this window after a silent API-key recovery falls back to the phone login */
		SILENT_KEY_RETRY_WINDOW_MS: 60 * 60 * 1000,
		/** Bounds for an owner reply that is taken as Claude's authorization code */
		CODE_MIN_LENGTH: 16,
		CODE_MAX_LENGTH: 512,
		/** Longest reply typed into an unrecognised login screen */
		SCREEN_REPLY_MAX_LENGTH: 512,
		/** Owner replies that start the login over (compared trimmed, case-insensitive) */
		RETRY_KEYWORDS: ['relogin', 're-login', '重新登录'] as readonly string[],
		/**
		 * Bare owner replies that start the sign-in of every signed-out harness
		 * (compared trimmed, case-insensitive, trailing punctuation dropped).
		 * Only taken while a harness is known to be signed out.
		 */
		LOGIN_KEYWORDS: [
			'login', 'log in', 'log-in', 'sign in', 'signin', 'sign-in', 'relogin', 're-login', 'reauth',
			'登录', '登陆', '重新登录', '重新登陆', '重登',
		] as readonly string[],
		/** First re-reminder for a harness that stays signed out; doubles each time */
		REMIND_BACKOFF_BASE_MS: 3 * 60 * 60 * 1000,
		/** Longest gap between re-reminders */
		REMIND_BACKOFF_MAX_MS: 24 * 60 * 60 * 1000,
		/** A live sign-in probe result is reused this long */
		PROBE_CACHE_MS: 10 * 60 * 1000,
		/** A harness in use that looks signed in is probed for real this often */
		PROBE_INTERVAL_MS: 60 * 60 * 1000,
		/** Longest a sign-in probe may run */
		PROBE_TIMEOUT_MS: 90_000,
		/** Persisted notice / backoff state under CREWLY_HOME */
		STATE_FILENAME: 'harness-relogin-state.json',
		/** Tail of the (redacted) login screen included in a DM */
		DM_SCREEN_MAX_CHARS: 1500,
		/** Longest broker message quoted in a DM */
		DM_MESSAGE_MAX_CHARS: 300,
		/** Waiting agents named in a DM; the rest are counted */
		DM_MAX_LISTED_AGENTS: 8,
	},
	/**
	 * Owner-requested logins (「重新登录 claude」 in the orc DM, or the orc's
	 * `harness-login` skill). specs/onboarding-harness-login.md "Owner-triggered login".
	 */
	OWNER_LOGIN: {
		/** Longest DM (normalised) the deterministic trigger considers; longer text goes to the orc */
		MAX_TRIGGER_LENGTH: 60,
		/** How far back an owner message may ask for the login the orc's skill starts */
		EVIDENCE_LOOKBACK_MS: 30 * 60 * 1000,
		/** Owner messages read for that evidence */
		EVIDENCE_MAX_MESSAGES: 50,
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
		/**
		 * Live sign-in probe: one tiny print-mode turn. `claude auth status`
		 * only reports whether a credential is *stored* (an expired or revoked
		 * login still says loggedIn), so it cannot see an expiry; a real turn
		 * answers "Not logged in · Please run /login" / "OAuth token revoked"
		 * when the login is gone. No session file is written.
		 */
		PROBE_ARGS: ['-p', 'Reply with the single word OK.', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config'] as readonly string[],
		/**
		 * More of the owner's own Claude Code accounts on this machine, each
		 * with its own config dir (`CLAUDE_CONFIG_DIR`) and login, used as
		 * runtime fallbacks (`claude-code@<name>`). Issue #942.
		 */
		ACCOUNTS: {
			/** Directory under CREWLY_HOME holding one config dir per account */
			DIR: 'claude-accounts',
			/** Separator of a fallback chain entry: `claude-code@work` */
			TARGET_SEPARATOR: '@',
			/** Account names: lower-case letters, digits, `-`, `_` */
			NAME_PATTERN: /^[a-z0-9][a-z0-9_-]{0,31}$/,
			/** Words that cannot be account names (they read as part of "claude code account …") */
			RESERVED_NAMES: ['code', 'cli', 'account', 'accounts', 'default', 'claude'] as readonly string[],
			/** Claude's user settings file, copied from the default login when an account is created */
			SETTINGS_FILE: 'settings.json',
			/** `.claude.json` keys copied from the default login (the owner's own earlier answers) */
			COPIED_CONFIG_KEYS: ['hasCompletedOnboarding', 'bypassPermissionsModeAccepted', 'theme'] as readonly string[],
		},
	},
	/** Codex CLI facts */
	CODEX: {
		HOME_ENV: 'CODEX_HOME',
		HOME_DIR: '.codex',
		AUTH_FILE: 'auth.json',
		/**
		 * Launch flag that keeps a Codex TUI off the shared background
		 * `codex app-server` daemon (0.157+). Without it every Codex agent on a
		 * machine ran its shell commands inside the one daemon the first agent
		 * started, so they all carried that agent's CREWLY_SESSION_NAME.
		 */
		NO_DAEMON_FLAG: '--no-daemon',
		/** Flags that already pick the app server themselves (leave the command alone) */
		APP_SERVER_SELECT_FLAGS: ['--no-daemon', '--remote'] as readonly string[],
		/** Timeout for `codex --help` when checking that the flag exists */
		HELP_PROBE_TIMEOUT_MS: 10_000,
		/** A Codex without the flag is re-checked after this long (it may be upgraded) */
		NO_DAEMON_PROBE_RETRY_MS: 10 * 60 * 1000,
	},
	/** Antigravity CLI facts (API key only; see ANTIGRAVITY_CONSTANTS) */
	ANTIGRAVITY: {
		/** Login source when Crewly holds the key */
		STORED_KEY_SOURCE: 'crewly-api-key',
		/** Longest installer script accepted (the official one is ~8 KB) */
		INSTALL_SCRIPT_MAX_BYTES: 256 * 1024,
		/** Timeout for downloading the installer script */
		INSTALL_SCRIPT_FETCH_TIMEOUT_MS: 30_000,
		/** Shell the official installer is written for */
		INSTALL_SHELL: 'bash',
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
		LABEL: 'Blank',
		TAGLINE: 'Just the Orc (the orchestrator), no team yet. Ask the Orc to put a team together when you need one.',
		SUGGESTIONS: [
			'Help me think: which of the things I repeat every week could an AI team take over?',
			'I want to start a small project. Ask me a few questions first, then suggest the team I need.',
			'Tell me what you can do, with 3 examples I could start today.',
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

/**
 * Unified conversation log (specs/unified-conversations-cloud-store.md §A).
 * Column vocabularies for the first-class copies of what used to live only
 * in `chat_messages.metadata`.
 */
export const CONVERSATION_LOG_CONSTANTS = {
	/** `chat_messages.source` values — which surface a message belongs to. */
	SOURCES: ['slack', 'crewly-chat', 'cloud-talk', 'google-chat', 'telegram', 'whatsapp', 'system', 'runtime'],
	/** `chat_messages.direction` values: to an agent, from an agent, or neither. */
	DIRECTIONS: ['in', 'out', 'internal'],
	/** `chat_messages.sender_kind` values. */
	SENDER_KINDS: ['owner', 'agent', 'human', 'system'],
	/** Channel id prefixes of messenger conversations (legacy rows carry no reliable source tag). */
	CHANNEL_PREFIXES: {
		SLACK: 'slack-',
		WHATSAPP: 'whatsapp-',
		TELEGRAM: 'telegram-',
		GOOGLE_CHAT: 'gchat-',
	},
	/** Rows rewritten per transaction when backfilling legacy rows. */
	BACKFILL_BATCH_SIZE: 2000,
	/** Default / maximum page size of the per-agent timeline. */
	TIMELINE_DEFAULT_LIMIT: 50,
	TIMELINE_MAX_LIMIT: 200,
} as const;

/**
 * Machine → Cloud conversation upload (specs/unified-conversations-cloud-store.md §B).
 * The wire contract itself lives in `services/cloud/conversation-ingest.contract.ts`.
 */
export const CONVERSATION_SYNC_CONSTANTS = {
	/** Kill switch: `CREWLY_CONVERSATION_SYNC=0` (or `off` / `false`) stops uploading. */
	ENV_SWITCH: 'CREWLY_CONVERSATION_SYNC',
	/** The spec's name for the same switch (`CREWLY_CLOUD_CONVERSATIONS=off`); honoured too. */
	ENV_SWITCH_ALT: 'CREWLY_CLOUD_CONVERSATIONS',
	/** Flush when this many messages are waiting. */
	BATCH_MAX_MESSAGES: 50,
	/** Flush when the batch reaches this many bytes of JSON (before gzip). */
	BATCH_MAX_BYTES: 256 * 1024,
	/** Flush a partial batch after it has waited this long (ms). */
	BATCH_MAX_WAIT_MS: 2_000,
	/** Periodic wake-up even without new messages (ms). */
	TICK_INTERVAL_MS: 10_000,
	/** First retry delay after a failure (ms); doubles up to the max. */
	BACKOFF_INITIAL_MS: 1_000,
	/** Longest retry delay after repeated failures (ms) — 5 min. */
	BACKOFF_MAX_MS: 5 * 60 * 1000,
	/** Retry interval while Cloud has no ingest endpoint (404) or refused sync (403) — 1 h. */
	UNAVAILABLE_RETRY_MS: 60 * 60 * 1000,
	/** Rows read from chat_messages per backfill page. */
	BACKFILL_PAGE_SIZE: 500,
	/** Largest backfill request (bytes of JSON before gzip); Cloud accepts 8 MB inflated. */
	BACKFILL_BATCH_MAX_BYTES: 4 * 1024 * 1024,
	/** At most one backfill request per this many ms (live batches go first). */
	BACKFILL_MIN_INTERVAL_MS: 1_000,
	/** Retention assumed until Cloud reports one (days) — the free plan's window. */
	DEFAULT_RETENTION_DAYS: 7,
	/** Largest outbox kept while disconnected; older rows are dropped with a gap marker. */
	OUTBOX_MAX_ROWS: 200_000,
	/** Outbox rows older than this are dropped (ms) — the longest plan window, 90 days. */
	OUTBOX_MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000,
	/** Timeout of one ingest request (ms). */
	REQUEST_TIMEOUT_MS: 30_000,
	/** `cloud_sync_state` keys. */
	STATE_KEYS: {
		ACCOUNT_ID: 'accountId',
		BACKFILL_DONE_AT: 'backfillDoneAt',
		BACKFILL_CURSOR: 'backfillCursor',
		BACKFILL_RETENTION_DAYS: 'backfillRetentionDays',
		RETENTION_DAYS: 'retentionDays',
		NOTICE_SENT_AT: 'noticeSentAt',
		GAP_AT: 'gapAt',
		LAST_INGEST_AT: 'lastIngestAt',
	},
	/** One-time owner DM (O1) when history starts syncing. `{device}` is replaced. */
	NOTICE_TEXT:
		'Heads up: your conversations with agents on {device} now also sync to Crewly Cloud, so you can see every machine and every channel from your phone. ' +
		'Free keeps 7 days, Pro keeps 90 days; message text is stored encrypted in Cloud, and files stay on this machine.',
} as const;

/**
 * Cloud Talk (specs/unified-conversations-cloud-store.md §D.3, Phase 3): the
 * owner talks to an agent from the Crewly Cloud portal; Cloud pushes a
 * `talk_message` through the relay and this machine records it in the
 * agent's DM (source `cloud-talk`) and wakes the agent.
 */
export const CLOUD_TALK_CONSTANTS = {
	/** Relay message `type` Cloud pushes for a Talk message. */
	RELAY_MESSAGE_TYPE: 'talk_message',
	/** Capability advertised to Cloud (heartbeat + uploads) once the handler runs. */
	CAPABILITY: 'talk_message',
	/** `GET <path>/:messageId?instanceId=` fetches the text; `POST <path>/:messageId/failed` refuses it. */
	MESSAGE_PATH: '/api/cloud/conversations/talk',
	/** Delays before retrying a failed fetch (ms); Cloud re-pushes after 5 min anyway. */
	FETCH_RETRY_DELAYS_MS: [1_000, 5_000, 15_000],
	/** Timeout of one Cloud call (ms). */
	REQUEST_TIMEOUT_MS: 15_000,
	/** How often the uploader re-sends this machine's agent roster (ms). */
	ROSTER_INTERVAL_MS: 5 * 60 * 1000,
	/** Display name of the orchestrator in the roster (same as its Slack app). */
	ORCHESTRATOR_DISPLAY_NAME: 'Crewly Orc',
	/** Ticket-intake origin for a Talk message (the portal). */
	INTAKE_ORIGIN: 'portal',
} as const;

/**
 * "Waiting on you" synced to Crewly Cloud (specs/unified-conversations-cloud-store.md §F, Phase 5):
 * tickets in 待验收 are uploaded as text snapshots; the owner's accept /
 * send-back from the portal comes back as a `waiting_action` relay push.
 */
export const WAITING_SYNC_CONSTANTS = {
	/** Machine → Cloud snapshot upload. */
	INGEST_PATH: '/api/cloud/conversations/waiting/ingest',
	/** `GET <path>/:actionId?instanceId=` fetches an action; `POST <path>/:actionId/result` reports it. */
	ACTIONS_PATH: '/api/cloud/conversations/waiting/actions',
	/** Relay message `type` Cloud pushes for an owner action. */
	RELAY_MESSAGE_TYPE: 'waiting_action',
	/** Capability advertised to Cloud (heartbeat + uploads) once the action handler runs. */
	CAPABILITY: 'waiting_actions',
	/** Gather ticket changes this long before uploading (ms). */
	DEBOUNCE_MS: 2_000,
	/** Recompute the set this often and upload when it changed (catches WorkItem-driven changes) (ms). */
	CHECK_INTERVAL_MS: 30_000,
	/** Full snapshot (Cloud drops anything not in it) at least this often (ms). */
	FULL_SYNC_INTERVAL_MS: 5 * 60 * 1000,
	/** Backoff after a failed upload: first delay and cap (ms). */
	BACKOFF_INITIAL_MS: 5_000,
	BACKOFF_MAX_MS: 5 * 60 * 1000,
	/** 404 / 503 / 400 from Cloud: try again after this long (ms). */
	UNAVAILABLE_RETRY_MS: 60 * 60 * 1000,
	/** Timeout of one Cloud call (ms). */
	REQUEST_TIMEOUT_MS: 15_000,
	/** Longest title / excerpt sent (chars; Cloud truncates beyond its own limits too). */
	MAX_TITLE_CHARS: 500,
	MAX_EXCERPT_CHARS: 2_000,
	/** Delays before retrying a failed action fetch (ms); Cloud re-pushes after 5 min anyway. */
	FETCH_RETRY_DELAYS_MS: [1_000, 5_000, 15_000],
	/** Actions already carried out are remembered this long, so a re-push only re-reports (ms). */
	DONE_ACTIONS_TTL_MS: 24 * 60 * 60 * 1000,
	/** Most remembered actions. */
	DONE_ACTIONS_MAX: 500,
} as const;

// Type helpers
export type AgentStatus =
	(typeof CREWLY_CONSTANTS.AGENT_STATUSES)[keyof typeof CREWLY_CONSTANTS.AGENT_STATUSES];
export type WorkingStatus =
	(typeof CREWLY_CONSTANTS.WORKING_STATUSES)[keyof typeof CREWLY_CONSTANTS.WORKING_STATUSES];
export type RuntimeType = (typeof RUNTIME_TYPES)[keyof typeof RUNTIME_TYPES];
export type AgentId = string; // Agent identifier type for heartbeat service

/**
 * Secret redaction for persisted terminal output (session logs, scrub of old
 * logs and shell history). See utils/secret-redactor.
 */
export const SECRET_REDACTION_CONSTANTS = {
	/**
	 * Secret variable names masked in `NAME=value` even if the generic suffix
	 * rule (utils/secret-env isSecretEnvKey) ever changed. Upper-case.
	 */
	KNOWN_SECRET_ENV_NAMES: [
		'GEMINI_API_KEY',
		'GOOGLE_GENERATIVE_AI_API_KEY',
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'DEEPSEEK_API_KEY',
		'CLAUDE_CODE_OAUTH_TOKEN',
		'SLACK_BOT_TOKEN',
		'SLACK_APP_TOKEN',
		'SLACK_USER_TOKEN',
		'SLACK_SIGNING_SECRET',
		'CREWLY_API_TOKEN',
	] as readonly string[],
	/** Name families masked in `NAME=value` (tested against the upper-cased name). */
	SECRET_NAME_PATTERNS: [/^SLACK_\w*_TOKEN$/, /^CREWLY_\w*_TOKEN$/, /(?:^|_)PRIVATE_KEY$/] as readonly RegExp[],
	/**
	 * Longest whitespace-free tail the streaming redactor holds back between
	 * chunks before it forces a cut. Far above any credential's length.
	 */
	MAX_CARRY_CHARS: 4096,
	/** Tail kept after a forced cut — above any credential's length (≈250 chars). */
	MIN_FORCED_CARRY_CHARS: 512,
} as const;

/**
 * Shell history is kept off in agent PTYs: whatever an agent shell runs
 * (and anything Crewly types into it) must never land in ~/.bash_history or
 * ~/.zsh_history. Two layers:
 *
 * - SPAWN_ENV is merged into every PTY's spawn environment. It works for a
 *   shell whose rc files leave these alone.
 * - DISABLE_COMMAND is typed (space-prefixed) as the first line of the
 *   runtime init sequence, after the rc files ran — macOS /etc/zshrc
 *   unconditionally sets HISTFILE, which beats the spawn env. `unset HISTFILE`
 *   stops bash and zsh from ever writing a history file; bash additionally
 *   turns history recording off.
 *
 * HISTSIZE / HISTFILESIZE are deliberately NOT set to 0: when a user's
 * ~/.bashrc re-points HISTFILE at ~/.bash_history but leaves HISTFILESIZE
 * alone, bash truncates that file to HISTFILESIZE (defaulting to HISTSIZE)
 * lines — an inherited 0 would wipe the user's own history.
 */
export const SHELL_HISTORY_CONSTANTS = {
	/** Env merged into every PTY spawn (callers' own env still wins). */
	SPAWN_ENV: {
		/** bash + zsh: where history is written — nowhere */
		HISTFILE: '/dev/null',
		/** zsh: number of lines saved to HISTFILE */
		SAVEHIST: '0',
		/** bash: lines starting with a space are not recorded */
		HISTCONTROL: 'ignorespace',
	} as Readonly<Record<string, string>>,
	/** POSIX-shell line typed first into an agent shell (bash, zsh, sh, dash, ksh). */
	DISABLE_COMMAND:
		'unset HISTFILE; if [ -n "$ZSH_VERSION" ]; then setopt HIST_IGNORE_SPACE; SAVEHIST=0; elif [ -n "$BASH_VERSION" ]; then set +o history; fi',
	/** fish: an empty fish_history keeps history in memory only. */
	FISH_DISABLE_COMMAND: "set -g fish_history ''",
	/** Shells that understand DISABLE_COMMAND (basename of $SHELL). */
	POSIX_SHELLS: ['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh'] as readonly string[],
	/** Prefix for every line Crewly types into a shell (kept out of history by ignorespace / HIST_IGNORE_SPACE). */
	TYPED_LINE_PREFIX: ' ',
} as const;

/** One-time scrub of secrets already on disk (`crewly security scrub-logs`). */
export const SECRET_SCRUB_CONSTANTS = {
	/** Shell history files (relative to the user's home) that are scrubbed */
	SHELL_HISTORY_FILES: ['.bash_history', '.zsh_history', '.sh_history', '.history'] as readonly string[],
	/** settings.json under CREWLY_HOME, whose apiKeys are masked by exact value */
	SETTINGS_FILE: 'settings.json',
} as const;

/**
 * Owner-facing Upgrade / Restart controls in the dashboard
 * (specs/2026-10-01-upgrade-restart-controls.md).
 */
export const SYSTEM_CONTROL_CONSTANTS = {
	/** Progress / outcome of the last upgrade or restart, under CREWLY_HOME */
	STATE_FILE: 'system-action.json',
	/** Log file under `<crewlyHome>/logs/` written by the detached replacement launcher */
	REPLACEMENT_LOG_FILE: 'restart-replacement.log',
	/** "When idle": longest wait for agents to finish their turns before going ahead anyway (ms) — 30 min */
	IDLE_WAIT_CAP_MS: 30 * 60 * 1000,
	/** "When idle": how often the busy check runs while waiting (ms) */
	IDLE_POLL_MS: 15 * 1000,
	/** Pause before shutting down so the HTTP answer reaches the dashboard (ms) */
	RESPONSE_FLUSH_MS: 500,
	/** A registry answer older than this is re-fetched when the owner asks to upgrade (ms) */
	REGISTRY_MAX_AGE_MS: 60 * 1000,
	/** Registry answer age accepted for the status read (ms) — matches auto-update */
	STATUS_REGISTRY_MAX_AGE_MS: 30 * 60 * 1000,
	/** Replacement launcher: how often it checks whether the old process is gone (ms) */
	REPLACEMENT_PID_POLL_MS: 500,
	/** Replacement launcher: give up waiting for the old process after this long (ms) — drain is ≤ 2 min */
	REPLACEMENT_MAX_WAIT_MS: 10 * 60 * 1000,
	/** Replacement launcher: grace before checking the port when nothing is expected to relaunch us (ms) */
	REPLACEMENT_PORT_GRACE_MS: 3 * 1000,
	/** Replacement launcher: grace when an unknown supervisor might relaunch us first (ms) */
	REPLACEMENT_PORT_GRACE_UNKNOWN_MS: 20 * 1000,
	/** Login item script that keeps `crewly start` running on the owner's Mac */
	LOGIN_WRAPPER_SCRIPT: 'crewly-start.command',
	/** systemd unit `crewly service install` writes */
	SYSTEMD_UNIT: 'crewly.service',
	/** Accepted values of the `when` body field */
	WHEN_VALUES: ['idle', 'now'] as const,
	/** Refusal codes returned with 4xx/5xx answers */
	CODES: {
		OWNER_ONLY: 'owner-only',
		DEV_CHECKOUT: 'dev-checkout',
		NOT_NPM_GLOBAL: 'not-npm-global',
		UP_TO_DATE: 'up-to-date',
		IN_PROGRESS: 'in-progress',
		RESTART_IN_PROGRESS: 'restart-in-progress',
		REGISTRY_UNREACHABLE: 'registry-unreachable',
		UNAVAILABLE: 'unavailable',
		BAD_REQUEST: 'bad-request',
	},
	/** Owner-facing messages (the dashboard shows these as-is; English only) */
	MESSAGES: {
		OWNER_ONLY: 'Only the owner can upgrade or restart Crewly. Agents cannot trigger this.',
		DEV_CHECKOUT: 'This machine runs Crewly from a source checkout — update it with git (git pull, npm run build), then restart.',
		NOT_NPM_GLOBAL: 'This copy of Crewly is not a global npm install, so it cannot upgrade itself. Update it the way it was installed.',
		UNAVAILABLE: 'Upgrade and restart controls are not ready yet — Crewly is still starting. Try again in a minute.',
		REGISTRY_UNREACHABLE: 'Could not reach the npm registry to find the latest version. Try again later.',
		RESTART_IN_PROGRESS: 'Crewly is already shutting down or restarting.',
	},
} as const;

/**
 * Decision cards (specs/2026-10-01-decision-cards.md): structured owner
 * questions posted by the responsible agent's own Slack bot as a Block Kit
 * card, answered with a button, a reaction or a thread reply.
 */
export const DECISION_CONSTANTS = {
	/**
	 * Layout revision of the card blocks. Bump whenever the card layout changes
	 * (buttons added/removed): open cards drawn with an older revision are
	 * redrawn once at startup so they get the new controls (e.g. Skip, 1.20.185).
	 */
	CARD_RENDER_REV: 3,
	/** Delay after startup before stale open cards are redrawn (ms) */
	STALE_CARD_REFRESH_DELAY_MS: 15_000,
	/** Gap between two card redraws, to stay under Slack's chat.update rate limit (ms) */
	STALE_CARD_REFRESH_GAP_MS: 1_200,
	/** Persisted decisions under CREWLY_HOME */
	STORE_FILENAME: 'owner-decisions.json',
	/** Persisted ticket → Slack thread map under CREWLY_HOME */
	TICKET_THREADS_FILENAME: 'ticket-slack-threads.json',
	/** Id prefix of a decision (`D-<n>`) */
	ID_PREFIX: 'D-',
	/** Max characters of the question (one line) */
	QUESTION_MAX_CHARS: 280,
	/** Min characters of the question */
	QUESTION_MIN_CHARS: 8,
	/** Allowed option count */
	MIN_OPTIONS: 2,
	MAX_OPTIONS: 3,
	/** Max characters of an option label (Slack button text max is 75) */
	OPTION_LABEL_MAX_CHARS: 40,
	/** Max characters of an option's optional detail line */
	OPTION_DETAIL_MAX_CHARS: 150,
	/** The `default` value meaning "do nothing until the owner answers" */
	WAIT_DEFAULT: 'wait',
	/** Local hour of the default deadline: the next day at this hour */
	DEFAULT_DEADLINE_HOUR_LOCAL: 12,
	/** Local hour the "Remind me tomorrow" reminder is posted */
	REMIND_HOUR_LOCAL: 9,
	/** After "Remind me tomorrow" the deadline is at least this long after the reminder (ms) */
	REMIND_GRACE_MS: 24 * 60 * 60 * 1000,
	/** Sensitive asks: re-asked once this long after the ask (or at the deadline, whichever is later) (ms) */
	SENSITIVE_REASK_AFTER_MS: 24 * 60 * 60 * 1000,
	/** Sensitive asks: parked this long after the re-ask (ms) */
	SENSITIVE_PARK_AFTER_REASK_MS: 24 * 60 * 60 * 1000,
	/** Deadline / reminder evaluation cadence (ms) */
	TICK_MS: 60 * 1000,
	/** A card Slack refused to post is retried at most this often (ms) */
	POST_RETRY_MS: 5 * 60 * 1000,
	/** Resolved decisions are kept this long, then pruned (ms) */
	RESOLVED_KEEP_MS: 30 * 24 * 60 * 60 * 1000,
	/** Sensitive categories (never auto-applied) */
	SENSITIVE_KINDS: ['email', 'publish', 'deploy', 'spend'] as readonly string[],
	/** Block Kit action ids: `decision:<optionKey>` and the remind button */
	ACTION_PREFIX: 'decision:',
	REMIND_ACTION_ID: 'decision:remind',
	/** The "Skip" button (`decision:skip`, button value option `skip`) */
	SKIP_ACTION_ID: 'decision:skip',
	SKIP_OPTION: 'skip',
	/** Reactions: ✅ = default (or first) option, ❌ = a "no" option, ⏰ = remind tomorrow */
	REACTION_ACCEPT: ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1'] as readonly string[],
	REACTION_REJECT: ['x', 'negative_squared_cross_mark', '-1'] as readonly string[],
	/** Reactions that skip a card: 🚫 and ⏭️ */
	REACTION_SKIP: ['no_entry_sign', 'black_right_pointing_double_triangle_with_vertical_bar', 'next_track_button', 'track_next'] as readonly string[],
	REACTION_REMIND: ['alarm_clock', 'clock9', 'hourglass'] as readonly string[],
	/** Option labels that read as "no" (lower-cased, matched on the whole label or its first word) */
	NO_WORDS: ['no', 'nope', "don't", 'dont', 'not now', 'skip', 'cancel', 'stop', 'reject', 'decline', 'hold', '不', '不行', '不要', '不用', '不可以', '别', '别点', '取消', '算了', '拒绝'] as readonly string[],
	/** Free-text replies that accept the default (or first) option */
	YES_WORDS: ['yes', 'y', 'ok', 'okay', 'sure', 'go', 'go ahead', 'do it', 'approved', 'approve', 'lgtm', '好', '好的', '可以', '行', '同意', '批准', '没问题', '👍', '✅'] as readonly string[],
	/** Free-text replies that skip a card (checked before NO_WORDS) */
	SKIP_WORDS: ['skip', 'skip it', 'skip this', 'skipped', "don't care", 'dont care', 'never mind', 'nevermind', 'drop it', 'not needed', 'no longer needed', '不用了', '算了', '不管了', '跳过', '不需要了', '无所谓了'] as readonly string[],
	/** A skipped question is not asked again in the same request / ticket for this long (ms) */
	SKIP_DEDUPE_MS: 30 * 24 * 60 * 60 * 1000,
	/** Two questions at least this similar (character bigrams) in the same scope are the same skipped question */
	SKIP_SAME_QUESTION_SIMILARITY: 0.8,
	/** A `reply_question` card created this long after the agent asked is a backfilled card (legacy cards without `source`) (ms) */
	BACKFILL_CARD_MIN_LAG_MS: 30 * 60 * 1000,
	/** Free-text replies that snooze to tomorrow */
	REMIND_WORDS: ['remind me tomorrow', 'tomorrow', 'later', 'not today', '明天', '明天再说', '稍后', '晚点'] as readonly string[],
	/** Questions too vague to put in front of the owner (whole question, lower-cased, trailing ?! stripped) */
	VAGUE_QUESTIONS: [
		'thoughts', 'any thoughts', 'what do you think', 'please advise', 'advise', 'let me know', 'ok', 'okay',
		'proceed', 'continue', 'should i continue', 'should i proceed', 'what next', "what's next", 'next steps', 'any ideas',
		'yes or no', 'approve', 'approval', 'is this ok', 'is this okay', 'sound good', 'sounds good', 'can i', 'ready',
		'怎么样', '你觉得呢', '可以吗', '行吗', '继续吗', '要继续吗', '下一步', '下一步呢',
	] as readonly string[],
	/** Max decisions listed by the API at once */
	MAX_LISTED: 200,
	/**
	 * `wait` default: the one "Still waiting on you" reminder is posted this long after
	 * the asker was told the deadline passed — time for it to withdraw a moot card first
	 * (specs/2026-10-02-decision-card-thread-answers.md §2) (ms)
	 */
	WAIT_REMINDER_DELAY_MS: 30 * 60 * 1000,
	/** Max characters of a withdrawn card's reason ("Closed — <reason>") */
	CLOSED_REASON_MAX_CHARS: 120,
	/** Withdraw reasons the harness itself uses (cancelWhere notes) */
	CLOSED_REASONS: {
		TICKET_DONE: 'ticket done',
		TICKET_CANCELLED: 'ticket cancelled',
		HANDLED_IN_THREAD: 'already handled in this thread',
	},
} as const;

/**
 * Open items: commitments and questions agents put in their replies to the
 * owner (specs/2026-10-01-reply-open-items.md).
 */
export const OPEN_ITEMS_CONSTANTS = {
	/** Local hour a commitment that only says "tomorrow" is due */
	DEFAULT_DUE_HOUR_LOCAL: 12,
	/** A commitment with no time is due this long after it was made (ms) */
	DEFAULT_DUE_MS: 24 * 60 * 60 * 1000,
	/** The same words by the same agent this close together are one item (a reply recorded twice) (ms) */
	DUPLICATE_WINDOW_MS: 10 * 60 * 1000,
	/** The same agent's two promises this close together, about the same deliverable, are one (the newer stands) (ms) */
	PROMISE_DUPLICATE_WINDOW_MS: 30 * 60 * 1000,
	/** Max commitments and max questions taken from one reply */
	MAX_ITEMS_PER_REPLY: 3,
	/** Max characters stored for an item's text */
	TEXT_MAX_CHARS: 300,
	/** Max characters of a question (the card's one line) */
	QUESTION_MAX_CHARS: 280,
	/** Child WorkItems created this long before the promise still count as what it waits on (ms) */
	CHILD_LOOKBACK_MS: 30 * 60 * 1000,
	/** ...and this long after it — the agent promises, then delegates (ms). Later work is a new topic. */
	CHILD_LOOKAHEAD_MS: 15 * 60 * 1000,
	/** With no child work, a later reply by the agent counts as the delivery only after this (ms) */
	MIN_DELIVERY_GAP_MS: 2 * 60 * 1000,
	/** A plain promise is delivered only by a post at least this long (characters) — not an ack */
	MIN_DELIVERY_CHARS: 12,
	/** After the overdue nudge, the owner is told when it is still undelivered this long later (ms) */
	OWNER_NOTE_AFTER_NUDGE_MS: 2 * 60 * 60 * 1000,
	/** An item still active this long after it was made is expired (ms) */
	EXPIRE_AFTER_MS: 7 * 24 * 60 * 60 * 1000,
	/** Requests looked at by the sweep and the backfill: updated within (ms) */
	LOOKBACK_MS: 7 * 24 * 60 * 60 * 1000,
	/** The backfill only looks at promises and questions made within this long before it runs (ms) */
	BACKFILL_MAX_AGE_MS: 24 * 60 * 60 * 1000,
	/**
	 * A post made up to this long before the child work's recorded finish still delivers it: a verify
	 * pass overwrites `completedAt` after the agent has already posted (ms)
	 */
	DELIVERY_FINISH_GRACE_MS: 10 * 60 * 1000,
	/** Sweep cadence (ms) */
	SWEEP_INTERVAL_MS: 60 * 1000,
	/** An ask-owner decision this close in time to the reply, by the same agent, is the same question (ms) */
	ASK_OWNER_DEDUPE_WINDOW_MS: 2 * 60 * 60 * 1000,
	/** Two questions with at least this character-bigram overlap are the same question */
	SAME_QUESTION_SIMILARITY: 0.5,
	/** Option labels of a derived card */
	YES_LABEL: 'Yes',
	NO_LABEL: 'No',
	REPLY_LABEL: 'Reply in thread',
	/** `WorkItem.metadata` key of a follow-up WorkItem */
	FOLLOW_UP_METADATA_KEY: 'openItemFollowUp',
	/** The one line every agent prompt carries */
	PROMPT_LINE:
		'If you promise the owner something or ask them a question, say it plainly; Crewly tracks it. Use `ask-owner` for real decisions.',
	/** Max characters of the quoted context a question card carries when its question points back at earlier text */
	CONTEXT_EXCERPT_MAX_CHARS: 300,
	/**
	 * Words that make a question point back at earlier text ("这样安排行不行？", "Does this plan work?"):
	 * such a card carries a quoted context block (specs/2026-10-02-decision-card-thread-answers.md §5)
	 */
	REFERS_BACK_PATTERNS: [
		/这样(?:安排|做|处理|弄|改|搞|分工|设置|配置)?/u,
		/(?:这个|那个|上述|上面的?|以上的?|刚才的?|前面的?|之前说的|上次说的)(?:方案|安排|计划|做法|思路|建议|办法|想法|改动|版本|设计|方向)/u,
		/如上|上面(?:说|讲|列|提)的|以上|上述|刚才说的|前面说的|上次说的|之前说的/u,
		/\b(?:this|that|these|those) (?:plan|arrangement|approach|proposal|setup|change|idea|option|draft|version|layout)\b/i,
		/\b(?:the above|as above|above plan|as discussed|as described|what i (?:said|described|proposed))\b/i,
	] as readonly RegExp[],
} as const;

/**
 * Where an agent's answer goes, by the work item it is doing
 * (specs/2026-10-01-decision-cards.md §6).
 */
export const WORK_ITEM_DESTINATION_CONSTANTS = {
	/** `WorkItem.metadata` key holding the work item's origin */
	METADATA_KEY: 'origin',
	/** An owner turn origin newer than this (ms) still counts as the current work when no work item is running */
	OWNER_ORIGIN_FRESH_MS: 2 * 60 * 60 * 1000,
	/** Max characters of the topic line of a new top-level post */
	TOPIC_MAX_CHARS: 120,
	/** The one line every prompt carries about where to answer */
	PROMPT_LINE: 'Answer where you were asked; a new topic goes in a new thread.',
} as const;

/**
 * Harness-owned reply routing (specs/2026-10-02-harness-owned-routing.md).
 */
export const REPLY_ROUTING_CONSTANTS = {
	/** A `[FOLLOW-UP]` / `[DECISION]` prompt reference steers a bare `reply` for this long (ms) */
	PROMPT_REFERENCE_FRESH_MS: 6 * 60 * 60 * 1000,
	/** chat-v2 message metadata: the harness posted this as the delivery of a ticket follow-up (`reply --ticket`) */
	DELIVERS_TICKET_METADATA_KEY: 'deliversTicket',
	/** The Slack DM mirror keeps reply affinity to another surface only while the owner's turn there is this recent (ms) */
	DM_AFFINITY_FRESH_MS: 30 * 60 * 1000,
	/** Request ticket ids (`TKT-187`) */
	REQUEST_TICKET_PATTERN: /^TKT-(\d+)$/i,
	/** Project ticket ids (`CE-7`, `APP-12`) */
	PROJECT_TICKET_PATTERN: /^[A-Z][A-Z0-9]{0,9}-\d+$/,
	/** Decision ids (`D-12`) */
	DECISION_PATTERN: /^D-\d+$/i,
} as const;

/**
 * Daily token caps with a hard stop, team caps and temporary boosts
 * (specs/2026-10-02-spend-cap.md). The unit is TOKENS, not dollars (owner,
 * 2026-10-02): total tokens = input (fresh + cached) + output — see
 * `eventTokens` in token-usage.service. Caps are OFF until the owner sets
 * one. All owner-facing text is English.
 */
export const SPEND_CAP_CONSTANTS = {
	/** Caps + boosts + today's bookkeeping, under CREWLY_HOME (tokens) */
	STORE_FILE: 'usage-caps.json',
	/** The pre-token (USD) store; migrated once with USAGE_CONSTANTS.TOKENS_PER_USD */
	LEGACY_USD_STORE_FILE: 'spend-caps.json',
	/** Default / max window of GET /api/system/usage and /api/system/spend */
	DEFAULT_DAYS: 7,
	MAX_DAYS: 31,
	/** Fraction of a cap that sends the one heads-up */
	WARN_FRACTION: 0.8,
	/** Enforcement tick */
	TICK_MS: 60_000,
	/** How long the all-agents total is cached for the delivery gate */
	TOTAL_CACHE_MS: 15_000,
	/** How often the orc's held message queue re-checks the cap */
	QUEUE_RECHECK_MS: 60_000,
	/** The "Boost +X today" card offers the cap times this (rounded to a whole million) */
	BOOST_FACTOR: 1,
	/** Target key of the all-agents total cap / an everyone boost */
	TOTAL_TARGET: '*',
	/** Prefix of a team target (`team:<teamId>`) */
	TEAM_TARGET_PREFIX: 'team:',
	/** Error code of a refused wake */
	ERROR_CODE: 'SPEND_CAP_REACHED',
	/** Queued-delivery marker in sendMessageToAgent results */
	QUEUED_MARKER: '[SPEND_CAP]',
	/** Decision kind of the "cap reached" card */
	DECISION_KIND: 'spend_cap',
	/**
	 * Why an open "cap reached" card was withdrawn when its stop lifted
	 * without it (cap removed or raised, boost from elsewhere) — shown on the
	 * card as "Closed — <note>" (#939)
	 */
	CARD_WITHDRAWN_NOTE: 'no longer needed: the cap was removed, raised or boosted, so the stop has lifted',
	/** Why an open "cap reached" card was withdrawn when a newer card for the same target (a changed cap) replaced it */
	CARD_SUPERSEDED_NOTE: 'replaced by a newer card: the cap changed',
	OPTIONS: {
		KEEP: 'Keep stopped',
		UNLIMITED: 'Unlimited today',
	},
} as const;

/**
 * Token usage: the unit, the stats endpoint, and the Codex / Antigravity
 * ledgers (specs/2026-10-02-spend-cap.md).
 */
export const USAGE_CONSTANTS = {
	/**
	 * Tokens per US dollar, used ONCE to convert settings written in USD
	 * (the ticket autopilot's `dailyBudgetUsd`, pre-token spend caps) to
	 * tokens; each conversion is logged. A round migration default, not a
	 * price: the owner's Mac blended ~0.66M tokens per API-equivalent $ in the
	 * 7 days to 2026-10-01 (Opus 0.51M/$, Sonnet 2–3M/$, DeepSeek ~11M/$;
	 * cache reads are >99% of the tokens), so a converted budget is within
	 * 1.5× of what the dollar figure bought.
	 */
	TOKENS_PER_USD: 1_000_000,
	/** groupBy values of GET /api/system/usage */
	GROUP_BY: ['agent', 'team', 'project', 'workItem', 'runtime', 'day', 'model'] as readonly string[],
	/** Row key / label of usage whose model the source did not record (or recorded as a `<runtime>-default` placeholder) */
	UNKNOWN_MODEL_KEY: '(unknown-model)',
	UNKNOWN_MODEL_LABEL: 'Unknown model',
	/** Rows returned for groupBy=workItem (highest first) */
	MAX_WORK_ITEM_ROWS: 50,
	/** Row key / label (groupBy=workItem) of usage while the agent had no work item running */
	NO_WORK_ITEM_KEY: '(no-work-item)',
	NO_WORK_ITEM_LABEL: '(no work item)',
	/** Label of usage no team / project / work item can be attributed to */
	UNATTRIBUTED: '(unattributed)',
} as const;

/** Codex rollout usage sync (`~/.codex/sessions/**\/rollout-*.jsonl`). */
export const CODEX_USAGE_SYNC_CONSTANTS = {
	/** Poll interval (ms) */
	SYNC_INTERVAL_MS: 60_000,
	/** Cursor file under CREWLY_HOME */
	CURSOR_FILE: 'codex-rollout-cursors.json',
	/** Model recorded when a rollout names none */
	DEFAULT_MODEL: 'codex-cli-default',
	/** Directory entries visited when looking a rollout up by id */
	MAX_SCAN_ENTRIES: 20_000,
} as const;

/** Antigravity (`agy`) usage sync — best effort, see the spec. */
export const ANTIGRAVITY_USAGE_SYNC_CONSTANTS = {
	/** Poll interval (ms) */
	SYNC_INTERVAL_MS: 60_000,
	/** Cursor file under CREWLY_HOME */
	CURSOR_FILE: 'antigravity-usage-cursors.json',
	/** Model recorded (agy stores its model as an enum, not a name) */
	MODEL: 'antigravity-cli-default',
	/**
	 * Protobuf path of the usage message in a `steps.metadata` blob (field 9),
	 * and its input / output token fields. Undocumented — read from agy 1.x
	 * conversation databases; a blob without them is skipped, never guessed.
	 */
	USAGE_FIELD: 9,
	INPUT_FIELD: 2,
	OUTPUT_FIELD: 3,
} as const;

/**
 * Runtime fallback: switch an agent to another runtime when its runtime runs
 * out of usage, and back when the limit resets.
 * specs/2026-10-01-runtime-fallback.md
 */
/**
 * A planned relaunch (the runtime fallback moving an agent to another
 * runtime and back) is not a crash or a hang: the restart / heartbeat / hung
 * monitors ignore the session for this long and send no alarm.
 */
export const PLANNED_RELAUNCH_CONSTANTS = {
	/** How long a session counts as "being relaunched on purpose" */
	WINDOW_MS: 5 * 60_000,
} as const;

export const RUNTIME_FALLBACK_CONSTANTS = {
	/** State + settings file under CREWLY_HOME */
	STATE_FILE: 'runtime-fallback.json',
	/** Default global fallback chain */
	DEFAULT_CHAIN: ['claude-code', 'crewly-agent', 'antigravity-cli'] as readonly string[],
	/** Model a Crewly Agent fallback runs (provider/model) */
	DEFAULT_CREWLY_AGENT_MODEL: 'deepseek/deepseek-chat',
	/** Default switch-back probe cadence */
	DEFAULT_PROBE_INTERVAL_MINUTES: 15,
	/** Bounds of the probe cadence setting */
	MIN_PROBE_INTERVAL_MINUTES: 5,
	MAX_PROBE_INTERVAL_MINUTES: 240,
	/** Main tick (switch-back checks, idle-boundary reverts) */
	TICK_MS: 30_000,
	/** Poll while waiting for an agent's safe point */
	SAFE_POINT_POLL_MS: 5_000,
	/** Longest wait for a safe point before switching anyway (a limit ends the turn) */
	SAFE_POINT_MAX_WAIT_MS: 3 * 60_000,
	/** Wait after the first switch of an event before the owner DM (so the count means something) */
	NOTICE_DELAY_MS: 45_000,
	/** Probe again this long after a parsed reset time */
	RESET_GRACE_MS: 2 * 60_000,
	/**
	 * Out of money/credit (DeepSeek 402 "Insufficient Balance", "credit
	 * balance is too low"): no reset time and no timed retry — only a probe,
	 * at most this often, can bring the runtime back.
	 */
	BILLING_PROBE_INTERVAL_MS: 6 * 60 * 60_000,
	/** A limit seen again this soon after a switch-back counts as a failed switch-back */
	FAILED_REVERT_WINDOW_MS: 30 * 60_000,
	/** Each failed switch-back doubles the probe interval, up to this */
	MAX_PROBE_BACKOFF_MS: 24 * 60 * 60_000,
	/** Where the owner tops up, by billing provider */
	TOP_UP_URLS: {
		deepseek: 'platform.deepseek.com',
		anthropic: 'console.anthropic.com/settings/billing',
		openai: 'platform.openai.com/settings/organization/billing',
	} as Readonly<Record<string, string>>,
	/** A probe that says "fine" mutes detection for this long (false positive) */
	FALSE_POSITIVE_MUTE_MS: 10 * 60_000,
	/** Transient rate limits on one session that escalate to a usage limit */
	TRANSIENT_ESCALATE_COUNT: 4,
	TRANSIENT_WINDOW_MS: 10 * 60_000,
	/** Horizon of an escalated transient limit */
	TRANSIENT_ESCALATED_HORIZON_MS: 30 * 60_000,
	/** A revert is not attempted while the PTY wrote within this window */
	IDLE_QUIET_MS: 20_000,
	/** Smoke tests */
	SMOKE: {
		TEAM_PREFIX: 'zz-runtime-smoke-',
		MEMBER_NAME: 'smoke',
		MEMBER_ROLE: 'developer',
		TIMEOUT_MS: 5 * 60_000,
		POLL_MS: 3_000,
		/** Keep finished jobs this long for GET */
		JOB_TTL_MS: 60 * 60_000,
		/** Lines read from the agent's screen / log while waiting */
		CAPTURE_LINES: 200,
		/** Screen lines kept in a failure report */
		SCREEN_LINES: 60,
	},
	/** Display names used in owner messages and badges */
	LABELS: {
		'claude-code': 'Claude Code',
		'codex-cli': 'Codex',
		'antigravity-cli': 'Antigravity',
		'gemini-cli': 'Gemini CLI',
		'opencode-cli': 'OpenCode',
		'crewly-agent': 'Crewly Agent',
	} as Readonly<Record<string, string>>,
	/** Short names for "(Claude limit)" */
	SHORT_LABELS: {
		'claude-code': 'Claude',
		'codex-cli': 'Codex',
		'antigravity-cli': 'Antigravity',
		'gemini-cli': 'Gemini',
		'opencode-cli': 'OpenCode',
		'crewly-agent': 'Crewly Agent',
	} as Readonly<Record<string, string>>,
} as const;

/**
 * Per-person access (issue #968, epic #967): the people directory, the person
 * each agent turn acts for, and grant sharing. specs/per-person-access.md
 */
export const PEOPLE_CONSTANTS = {
	/** People directory under CREWLY_HOME */
	STORE_FILE: 'people.json',
	/** Who each agent session acts for, under CREWLY_HOME */
	ACTING_FOR_FILE: 'acting-for.json',
	/** Person id of the instance owner when their Slack user id is not known (dashboard, terminal) */
	OWNER_ID: 'owner',
	/** Roles a person can have */
	ROLES: ['owner', 'member', 'guest'] as readonly string[],
	/** Role a newly seen Slack user gets */
	DEFAULT_ROLE: 'member',
	/** Headers the backend sends Cloud with each credential request (never taken from an agent) */
	ACTING_FOR_HEADER: 'X-Crewly-Acting-For',
	ACTING_FOR_ROLE_HEADER: 'X-Crewly-Acting-For-Role',
	/** Cloud's refusal code when the person may not use a grant */
	NOT_PERMITTED_CODE: 'not_permitted',
	/** What an agent is told to do with that refusal */
	NOT_PERMITTED_HINT: 'Tell the person you are working for exactly this, in one line. Do not retry, and do not use another account or connector to get around it.',
	/** Grant sharing modes: only the person who authorized it, named people, or every member (not guests) */
	SHARING_MODES: ['owner', 'people', 'members'] as readonly string[],
	/** Longest display name kept */
	MAX_NAME_LENGTH: 80,
	/** Slack user ids (`U…` / `W…`) */
	SLACK_USER_ID_PATTERN: /^[UW][A-Z0-9]{2,30}$/,
} as const;
