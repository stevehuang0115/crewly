/**
 * Lazy singleton accessor for the {@link AgentBehaviorLogService}.
 *
 * Why a separate file: F14 wires callsites across the codebase (prompt
 * builder, slack adapter, deliver endpoint, escalation router) and they
 * all need a shared, lazily-opened DB handle. The service itself is kept
 * pure — `agent-behavior-log.service.ts` is intentionally NOT modified
 * (its constructor surface is the public contract), so this thin wrapper
 * owns lifecycle (open-on-first-use) and provides a `reset` hook for
 * tests.
 *
 * Best-effort by design: `getAgentBehaviorLogService()` swallows any
 * construction failure and returns `null`. Callers MUST treat a `null`
 * result the same way they treat a logged-but-failed `record()` call —
 * silently continue. Observability writes never break the request path.
 *
 * @module services/observability/agent-behavior-log.singleton
 */

import { LoggerService } from '../core/logger.service.js';
import {
  AgentBehaviorLogService,
  type AgentBehaviorLogServiceOptions,
} from './agent-behavior-log.service.js';

let instance: AgentBehaviorLogService | null = null;
/**
 * Tracks whether the singleton has been initialised (either via lazy
 * construction or a test override). Distinguishes "first call, no
 * instance yet" from "explicitly set to null" so a test that simulates
 * DB-unavailable does not silently re-open the real on-disk DB.
 */
let initialized = false;

/**
 * Lazily obtain the shared {@link AgentBehaviorLogService} instance.
 *
 * The first caller triggers DB open via the service constructor's
 * default opener options. Subsequent callers receive the same handle.
 *
 * Returns `null` if the underlying open failed — callers MUST be
 * resilient to this and skip the record() call when null.
 *
 * @returns The shared service instance or `null` if open failed
 *
 * @example
 * ```ts
 * const log = getAgentBehaviorLogService();
 * log?.record({
 *   type: 'agent.action',
 *   agent: 'crewly-orc',
 *   actionType: 'delegate',
 * });
 * ```
 */
export function getAgentBehaviorLogService(): AgentBehaviorLogService | null {
  if (initialized) return instance;
  try {
    instance = new AgentBehaviorLogService();
    initialized = true;
    return instance;
  } catch (err) {
    // Lazily-loaded logger so unit tests that don't initialise the
    // logger system don't crash here.
    const logger = LoggerService.getInstance().createComponentLogger(
      'AgentBehaviorLogSingleton',
    );
    logger.warn('Failed to construct AgentBehaviorLogService — telemetry disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    instance = null;
    initialized = true;
    return null;
  }
}

/**
 * Override the singleton with a caller-provided service. Used by tests
 * that need an in-memory DB or a custom time source.
 *
 * Calling this with a fresh service replaces the previous one without
 * closing it — the test owner is responsible for lifecycle. Passing
 * `null` simulates a DB-unavailable scenario; subsequent `get` calls
 * return null without attempting to construct a real on-disk service.
 *
 * @param svc - Pre-constructed service to install (or `null`)
 */
export function setAgentBehaviorLogServiceForTesting(
  svc: AgentBehaviorLogService | null,
): void {
  instance = svc;
  initialized = true;
}

/**
 * Construct a fresh in-memory service and install it as the singleton.
 * Convenience for tests that just want a working logger without caring
 * about disk persistence.
 *
 * @param options - Forwarded to the service constructor; defaults to
 *   `{ openOptions: { dbPath: ':memory:' } }`
 * @returns The newly installed service instance
 */
export function createInMemoryAgentBehaviorLogServiceForTesting(
  options: AgentBehaviorLogServiceOptions = {},
): AgentBehaviorLogService {
  const merged: AgentBehaviorLogServiceOptions = {
    ...options,
    openOptions: options.openOptions ?? { inMemory: true, skipIntegrityCheck: true },
  };
  const svc = new AgentBehaviorLogService(merged);
  instance = svc;
  initialized = true;
  return svc;
}

/**
 * Reset the singleton — closes the current handle (if any) and clears
 * the cache so the next `getAgentBehaviorLogService()` call constructs
 * a fresh instance.
 */
export function resetAgentBehaviorLogServiceForTesting(): void {
  if (instance) {
    try {
      instance.close();
    } catch {
      /* best-effort */
    }
  }
  instance = null;
  initialized = false;
}
