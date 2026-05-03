/**
 * Orchestrator Status Service
 *
 * Provides utilities to check the status of the orchestrator.
 * Used by Chat and Slack services to provide appropriate feedback
 * when the orchestrator is not running.
 *
 * @module services/orchestrator/orchestrator-status.service
 */

import { StorageService } from '../core/storage.service.js';
import { CREWLY_CONSTANTS, WEB_CONSTANTS } from '../../../../config/index.js';
import { getSessionBackendSync } from '../session/index.js';
import { isInProcessRuntimeActive } from '../agent/crewly-agent/in-process-runtime-registry.js';
import { RUNTIME_TYPES } from '../../constants.js';

/** Dashboard URL for user-facing messages */
const DASHBOARD_URL = `http://localhost:${WEB_CONSTANTS.PORTS.FRONTEND}`;

/**
 * Result of an orchestrator status check
 */
export interface OrchestratorStatusResult {
  /** Whether the orchestrator is active and ready to receive messages */
  isActive: boolean;
  /** The current agent status of the orchestrator */
  agentStatus: string | null;
  /** Human-readable status message */
  message: string;
}

/**
 * Check if the orchestrator is currently active and ready to receive messages.
 *
 * @returns Promise resolving to true if orchestrator is active
 *
 * @example
 * ```typescript
 * if (await isOrchestratorActive()) {
 *   // Safe to send message to orchestrator
 * } else {
 *   // Show user-friendly offline message
 * }
 * ```
 */
export async function isOrchestratorActive(): Promise<boolean> {
  const status = await getOrchestratorStatus();
  return status.isActive;
}

/**
 * Get detailed orchestrator status information.
 *
 * Uses the storageService.getOrchestratorStatus() method which reads the
 * orchestrator data directly from storage (not from the teams array).
 *
 * @returns Promise resolving to status details including active state and message
 *
 * @example
 * ```typescript
 * const status = await getOrchestratorStatus();
 * if (!status.isActive) {
 *   showError(status.message);
 * }
 * ```
 */
export async function getOrchestratorStatus(): Promise<OrchestratorStatusResult> {
  try {
    const storageService = StorageService.getInstance();

    // Use getOrchestratorStatus which reads the orchestrator data directly
    // The orchestrator is stored separately from the teams array
    const orchestratorStatus = await storageService.getOrchestratorStatus();

    // Also check if the PTY session exists - this provides a real-time view
    // of whether the orchestrator is actually running.
    // Use the well-known constant as fallback when sessionName isn't stored,
    // aligning with how the teams controller checks session existence.
    let sessionExists = false;
    let sessionCheckPerformed = false;
    const sessionName = orchestratorStatus?.sessionName || CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;
    try {
      const sessionBackend = getSessionBackendSync();
      if (sessionBackend && sessionName) {
        sessionExists = sessionBackend.sessionExists(sessionName);
        sessionCheckPerformed = true;
      }
    } catch {
      // Ignore session check errors - fall back to storage-based status
    }

    // Runtime-aware fallback (B0 hot-fix):
    // The PTY-based `sessionExists()` returns false for in-process Crewly
    // Agent runtimes because they have no PTY session. Treat the session as
    // alive when the runtime type is `crewly-agent` AND the in-process
    // registry confirms a ready runtime is registered. The PTY path is
    // untouched for `claude-code` / other runtimes.
    if (!sessionExists
      && orchestratorStatus?.runtimeType === RUNTIME_TYPES.CREWLY_AGENT
      && sessionName
      && isInProcessRuntimeActive(sessionName)
    ) {
      sessionExists = true;
      sessionCheckPerformed = true;
    }

    if (!orchestratorStatus) {
      return {
        isActive: false,
        agentStatus: null,
        message: 'Orchestrator not configured. Please set up the orchestrator from the Dashboard.',
      };
    }

    const agentStatus = orchestratorStatus.agentStatus || CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;

    // Orchestrator is active when fully registered via MCP AND the session is
    // confirmed alive (or the session backend was unavailable to check).
    // If the session backend confirmed the session is dead, treat as not active.
    const isRegisteredActive = agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
      && (!sessionCheckPerformed || sessionExists);

    // Also treat as active when the PTY session exists and the runtime is running
    // ("started" means Claude Code is running). This aligns with the teams controller
    // which uses session existence as ground truth for status.
    const isSessionActive = sessionExists && agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTED;

    if (isRegisteredActive || isSessionActive) {
      return {
        isActive: true,
        agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
        message: 'Orchestrator is active and ready.',
      };
    }

    // Proactive cleanup: if the session backend confirmed the session is dead
    // but stored status says active, update storage to prevent repeated stale checks
    // from other callers (QueueProcessor, dashboard).
    if (sessionCheckPerformed && !sessionExists && agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) {
      try {
        const storageServiceForCleanup = StorageService.getInstance();
        await storageServiceForCleanup.updateAgentStatus(
          sessionName,
          CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
        );
      } catch {
        // Best-effort cleanup — don't let it break the status check
      }
    }

    // Provide context-appropriate message based on status
    // Note: STARTED without a live session falls here (session died or config is stale)
    if (agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING ||
        agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTING ||
        agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTED) {
      return {
        isActive: false,
        agentStatus,
        message: 'Orchestrator is starting up. Please wait a moment and try again.',
      };
    }

    // Self-healing: if the session is alive AND has a running child process
    // (e.g. claude), but status says inactive, restore to active.
    // This handles cases where the status got stale due to a transient false
    // positive in exit detection while the runtime was actually still running.
    if (sessionExists && sessionCheckPerformed) {
      let childProcessAlive = false;
      try {
        const sessionBackend = getSessionBackendSync();
        childProcessAlive = !!sessionBackend?.isChildProcessAlive?.(sessionName);
      } catch {
        // Ignore check errors
      }

      if (childProcessAlive) {
        // Best-effort: persist the recovered status but return active regardless
        try {
          const storageServiceForRecovery = StorageService.getInstance();
          await storageServiceForRecovery.updateAgentStatus(
            sessionName,
            CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
          );
        } catch {
          // Best-effort — don't let persist failure block recovery
        }
        return {
          isActive: true,
          agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
          message: 'Orchestrator is active and ready (status recovered).',
        };
      }
    }

    // If session exists but status is not active/started, it may be initializing
    if (sessionExists) {
      return {
        isActive: false,
        agentStatus,
        message: 'Orchestrator is starting up. Please wait a moment and try again.',
      };
    }

    return {
      isActive: false,
      agentStatus,
      message: 'Orchestrator is not running. Please start the orchestrator from the Dashboard.',
    };
  } catch (error) {
    return {
      isActive: false,
      agentStatus: null,
      message: `Unable to check orchestrator status: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Check if a specific agent is currently active by verifying its PTY session exists
 * and has a running child process.
 *
 * @param sessionName - The agent's session name to check
 * @returns Promise resolving to true if the agent's session is alive
 */
export async function isAgentActive(sessionName: string): Promise<boolean> {
  try {
    const sessionBackend = getSessionBackendSync();
    if (!sessionBackend) {
      return false;
    }
    if (!sessionBackend.sessionExists(sessionName)) {
      return false;
    }
    // Session exists — check if child process (the AI runtime) is alive
    return !!sessionBackend.isChildProcessAlive?.(sessionName);
  } catch {
    return false;
  }
}

/**
 * Get a user-friendly message for when the orchestrator is offline.
 * Useful for Slack and Chat responses.
 *
 * @param includeUrl - Whether to include the dashboard URL in the message
 * @returns A user-friendly offline message
 */
export function getOrchestratorOfflineMessage(includeUrl = true): string {
  const baseMessage = 'The orchestrator is currently offline.';
  if (includeUrl) {
    return `${baseMessage} Please start it from the Crewly dashboard at ${DASHBOARD_URL}`;
  }
  return `${baseMessage} Please start it from the Crewly dashboard.`;
}
