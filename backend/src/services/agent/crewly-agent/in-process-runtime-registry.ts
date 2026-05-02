/**
 * In-Process Runtime Registry
 *
 * Module-level registry that tracks active in-process Crewly Agent runtimes
 * by session name. Provides a lightweight lookup mechanism for callers (such
 * as `orchestrator-status.service.ts`) that need to determine whether an
 * in-process runtime is alive without holding a reference to the
 * `AgentRegistrationService` instance.
 *
 * Why this exists (B0 hot-fix):
 * The PTY-based `sessionExists()` check returns `false` for in-process
 * Crewly Agent runtimes because they have no PTY session. Before this
 * registry, the orchestrator-status service had no runtime-aware fallback,
 * so `isActive` would report `false` for healthy in-process orchestrators
 * — causing SlackBridge to incorrectly route messages to the offline path.
 *
 * The `AgentRegistrationService` already maintains an internal
 * `inProcessRuntimes` map for in-process runtime routing. This module
 * mirrors that knowledge at module scope so any caller can probe runtime
 * health without a service-locator dance.
 *
 * @module services/agent/crewly-agent/in-process-runtime-registry
 */

import type { CrewlyAgentRuntimeService } from './crewly-agent-runtime.service.js';

/**
 * Module-level registry of active in-process runtimes keyed by session name.
 *
 * Mirrors `AgentRegistrationService.inProcessRuntimes`. Both maps must stay
 * in sync — `AgentRegistrationService` writes to this registry whenever it
 * registers/unregisters a runtime.
 */
const registry: Map<string, CrewlyAgentRuntimeService> = new Map();

/**
 * Register an in-process Crewly Agent runtime.
 *
 * Called by `AgentRegistrationService` after `initializeInProcess()`
 * succeeds. If a runtime is already registered for the same session, it is
 * replaced — the old reference is discarded but not shut down (the caller
 * is responsible for the lifecycle).
 *
 * @param sessionName - Session name owning the runtime (e.g. 'crewly-orc')
 * @param runtime - The initialized CrewlyAgentRuntimeService instance
 *
 * @example
 * ```typescript
 * registerInProcessRuntime('crewly-orc', crewlyRuntime);
 * ```
 */
export function registerInProcessRuntime(
  sessionName: string,
  runtime: CrewlyAgentRuntimeService,
): void {
  registry.set(sessionName, runtime);
}

/**
 * Unregister an in-process runtime by session name.
 *
 * Called when a runtime is shut down or the session is destroyed.
 * Idempotent — safe to call when the session is not registered.
 *
 * @param sessionName - Session name to remove
 * @returns True if a runtime was removed, false if none was registered
 */
export function unregisterInProcessRuntime(sessionName: string): boolean {
  return registry.delete(sessionName);
}

/**
 * Look up an in-process runtime by session name.
 *
 * @param sessionName - Session name to look up
 * @returns The CrewlyAgentRuntimeService if registered, undefined otherwise
 */
export function getInProcessRuntime(
  sessionName: string,
): CrewlyAgentRuntimeService | undefined {
  return registry.get(sessionName);
}

/**
 * Check whether an in-process runtime exists and is ready to handle
 * messages for the given session.
 *
 * Returns `true` only when both:
 * - A runtime is registered for the session
 * - The runtime's `isReady()` returns `true`
 *
 * This is the function callers should use when answering "is this
 * session alive?" — it correctly handles both the worker-process and
 * direct in-process modes of `CrewlyAgentRuntimeService`.
 *
 * @param sessionName - Session name to check
 * @returns True when the runtime exists and is ready
 */
export function isInProcessRuntimeActive(sessionName: string): boolean {
  const runtime = registry.get(sessionName);
  if (!runtime) {
    return false;
  }
  try {
    return runtime.isReady();
  } catch {
    // Defensive: a misbehaving isReady() must not break callers.
    return false;
  }
}

/**
 * Reset the registry. Test-only helper.
 *
 * Leaves any actually-running runtimes untouched — only clears the
 * registry's bookkeeping. Production code must never call this.
 *
 * @internal
 */
export function _resetInProcessRuntimeRegistryForTesting(): void {
  registry.clear();
}

/**
 * Get the current registry size. Test-only helper.
 *
 * @returns Number of registered runtimes
 * @internal
 */
export function _getInProcessRuntimeRegistrySize(): number {
  return registry.size;
}
