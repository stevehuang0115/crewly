/**
 * Crewly Constants - Centralized Export
 * 
 * This file provides a single import point for all Crewly constants across domains.
 * 
 * Usage examples:
 * ```typescript
 * // Cross-domain constants
 * import { CREWLY_CONSTANTS, WEB_CONSTANTS } from '../config';
 * 
 * // Backend-specific constants  
 * import { BACKEND_CONSTANTS } from '../config';
 * 
 * // All constants
 * import * as CONFIG from '../config';
 * ```
 */

// ========================= CROSS-DOMAIN CONSTANTS =========================

import {
  // Core system constants
  CREWLY_CONSTANTS,
  WEB_CONSTANTS,
  TIMING_CONSTANTS,
  MESSAGE_CONSTANTS,
  ENV_CONSTANTS,
  BACKEND_CONSTANTS,
  AGENT_IDENTITY_CONSTANTS,
  MEMORY_CONSTANTS,
  CONTINUATION_CONSTANTS,
  VERSION_CHECK_CONSTANTS,
  MARKETPLACE_CONSTANTS,
  TEMPLATE_MARKETPLACE_CONSTANTS,
  PROCESS_EXIT_CODES,
  SERVER_CONSTANTS,
  EVENT_DEBOUNCE_MS,

  // Type helpers
  type AgentStatus,
  type WorkingStatus,
  type AgentRole,
  type AgentId,
  type MessageType,
  type OrchestratorCommand,
  type HTTPStatusCode,
} from './constants.js';

export {
  // Core system constants
  CREWLY_CONSTANTS,
  WEB_CONSTANTS,
  TIMING_CONSTANTS,
  MESSAGE_CONSTANTS,
  ENV_CONSTANTS,
  BACKEND_CONSTANTS,
  AGENT_IDENTITY_CONSTANTS,
  MEMORY_CONSTANTS,
  CONTINUATION_CONSTANTS,
  VERSION_CHECK_CONSTANTS,
  MARKETPLACE_CONSTANTS,
  TEMPLATE_MARKETPLACE_CONSTANTS,
  PROCESS_EXIT_CODES,
  SERVER_CONSTANTS,
  EVENT_DEBOUNCE_MS,

  // Type helpers
  type AgentStatus,
  type WorkingStatus,
  type AgentRole,
  type AgentId,
  type MessageType,
  type OrchestratorCommand,
  type HTTPStatusCode,
};

// All backend constants have been consolidated into the main constants.ts file
// Use BACKEND_CONSTANTS from the main export above

// ========================= DOMAIN-SPECIFIC CONVENIENCE EXPORTS =========================

/**
 * All cross-domain constants grouped for easy access
 */
export const CROSS_DOMAIN_CONSTANTS = {
  CREWLY: CREWLY_CONSTANTS,
  WEB: WEB_CONSTANTS,
  TIMING: TIMING_CONSTANTS,
  MESSAGES: MESSAGE_CONSTANTS,
  ENV: ENV_CONSTANTS,
  BACKEND: BACKEND_CONSTANTS,
  AGENT_IDENTITY: AGENT_IDENTITY_CONSTANTS,
  MEMORY: MEMORY_CONSTANTS,
  CONTINUATION: CONTINUATION_CONSTANTS,
} as const;