/**
 * Crewly CLI Constants
 *
 * This file provides CLI-specific constants and re-exports shared constants
 * from the central config for convenience.
 *
 * For shared constants, use:
 * - CREWLY_CONSTANTS: Core system identifiers and paths
 * - WEB_CONSTANTS: Web server ports and endpoints
 * - TIMING_CONSTANTS: Timeouts and intervals
 * - MESSAGE_CONSTANTS: Message handling configuration
 * - ENV_CONSTANTS: Environment variable names
 * - BACKEND_CONSTANTS: Backend-specific configuration
 */

// Re-export from central config for convenience
export {
  CREWLY_CONSTANTS,
  WEB_CONSTANTS,
  TIMING_CONSTANTS,
  MESSAGE_CONSTANTS,
  ENV_CONSTANTS,
  BACKEND_CONSTANTS,
  VERSION_CHECK_CONSTANTS,
  PROCESS_EXIT_CODES,
  SERVER_CONSTANTS,
} from '../../config/index.js';

// Import for creating convenience aliases
import {
  CREWLY_CONSTANTS,
  WEB_CONSTANTS,
  BACKEND_CONSTANTS,
  ENV_CONSTANTS,
  TIMING_CONSTANTS,
  MESSAGE_CONSTANTS,
  PROCESS_EXIT_CODES,
} from '../../config/index.js';

// ========================= CLI-SPECIFIC CONSTANTS =========================

/**
 * CLI-specific configuration constants
 * These constants are only used within the CLI tool itself
 */
export const CLI_CONSTANTS = {
  /** CLI tool name for display */
  TOOL_NAME: 'crewly',

  /** Default output format */
  DEFAULT_OUTPUT_FORMAT: 'text' as const,

  /** Colors for status display */
  STATUS_COLORS: {
    SUCCESS: 'green',
    ERROR: 'red',
    WARNING: 'yellow',
    INFO: 'blue',
  },

  /** Exit codes */
  EXIT_CODES: {
    SUCCESS: 0,
    ERROR: 1,
    INVALID_ARGS: 2,
  },
} as const;

// ========================= CONVENIENCE ALIASES =========================

/**
 * Convenience aliases for commonly used constants
 * These provide backwards compatibility and shorter imports
 */

// Orchestrator constants
export const ORCHESTRATOR_SESSION_NAME = CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;
export const ORCHESTRATOR_DISPLAY_NAME = CREWLY_CONSTANTS.ORCHESTRATOR.DISPLAY_NAME;
export const ORCHESTRATOR_ROLE = CREWLY_CONSTANTS.ROLES.ORCHESTRATOR;
export const ORCHESTRATOR_WINDOW_NAME = CREWLY_CONSTANTS.ORCHESTRATOR.WINDOW_NAME;

// Timeout constants
export const ORCHESTRATOR_SETUP_TIMEOUT = TIMING_CONSTANTS.TIMEOUTS.ORCHESTRATOR_SETUP;
export const AGENT_INITIALIZATION_TIMEOUT = TIMING_CONSTANTS.TIMEOUTS.AGENT_SETUP;
export const CLAUDE_INITIALIZATION_TIMEOUT = TIMING_CONSTANTS.TIMEOUTS.CLAUDE_INIT;
export const CLAUDE_READY_TIMEOUT = TIMING_CONSTANTS.TIMEOUTS.CLAUDE_INIT;

// Directory constants
export const CREWLY_HOME_DIR = CREWLY_CONSTANTS.PATHS.CREWLY_HOME;
export const CONFIG_DIR = CREWLY_CONSTANTS.PATHS.CONFIG_DIR;
export const PROMPTS_DIR = CREWLY_CONSTANTS.PATHS.PROMPTS_DIR;
export const TASKS_DIR = CREWLY_CONSTANTS.PATHS.TASKS_DIR;
export const SPECS_DIR = CREWLY_CONSTANTS.PATHS.SPECS_DIR;
export const MEMORY_DIR = CREWLY_CONSTANTS.PATHS.MEMORY_DIR;

// File constants
export const TEAMS_CONFIG_FILE = CREWLY_CONSTANTS.PATHS.TEAMS_FILE;
export const ACTIVE_PROJECTS_FILE = BACKEND_CONSTANTS.FILES.ACTIVE_PROJECTS_FILE;
export const TASK_TRACKING_FILE = BACKEND_CONSTANTS.FILES.TASK_TRACKING_FILE;
export const COMMUNICATION_LOG_FILE = BACKEND_CONSTANTS.FILES.COMMUNICATION_LOG_FILE;

// Port constants
export const DEFAULT_WEB_PORT = WEB_CONSTANTS.PORTS.BACKEND;

// Role constants
export const AGENT_ROLES = CREWLY_CONSTANTS.ROLES;
export const ROLE_DISPLAY_NAMES = CREWLY_CONSTANTS.ROLE_DISPLAY_NAMES;

// Environment constants
export const ENV_VARS = ENV_CONSTANTS;

// Script constants
export const INIT_SCRIPTS = BACKEND_CONSTANTS.INIT_SCRIPTS;

// Detection constants
export const CLAUDE_DETECTION_CACHE_TIMEOUT = CREWLY_CONSTANTS.SESSIONS.CLAUDE_DETECTION_CACHE_TIMEOUT;
export const MEMORY_CLEANUP_INTERVAL = TIMING_CONSTANTS.INTERVALS.MEMORY_CLEANUP;
export const MAX_OUTPUT_BUFFER_SIZE = MESSAGE_CONSTANTS.LIMITS.MAX_BUFFER_SIZE;

// Message constants
export const MESSAGE_CHUNK_SIZE = MESSAGE_CONSTANTS.LIMITS.CHUNK_SIZE;
export const SMALL_CHUNK_SIZE = MESSAGE_CONSTANTS.LIMITS.SMALL_CHUNK_SIZE;

// API endpoints
export const API_ENDPOINTS = BACKEND_CONSTANTS.API_ENDPOINTS;
