/**
 * Eval Framework - Adapter Exports
 *
 * Re-exports all adapter implementations and the factory function
 * for creating adapters by runtime ID.
 *
 * @module eval/adapters
 */

import type { RuntimeAdapter, RuntimeId } from '../eval-types.js';
import { CrewlyAgentAdapter } from './crewly-agent-adapter.js';
import { CLIAdapter } from './cli-adapter.js';

export { CrewlyAgentAdapter } from './crewly-agent-adapter.js';
export { CLIAdapter, type CLIAdapterConfig, CLI_DEFAULTS } from './cli-adapter.js';

/**
 * Factory function to create a RuntimeAdapter for a given runtime.
 *
 * Supports:
 * - `crewly-agent` — uses the in-process AgentRunnerService
 * - `claude-code`  — spawns `claude --print` as a subprocess
 * - `codex-cli`    — spawns `codex --quiet` as a subprocess
 * - `gemini-cli`   — spawns `gemini --sandbox=none` as a subprocess
 *
 * @param runtimeId - identifier of the runtime to create an adapter for
 * @returns a new, uninitialized RuntimeAdapter instance
 * @throws Error if the runtime is not recognized
 *
 * @example
 * ```typescript
 * const adapter = createAdapter('claude-code');
 * await adapter.initialize(config);
 * ```
 */
export function createAdapter(runtimeId: RuntimeId): RuntimeAdapter {
  switch (runtimeId) {
    case 'crewly-agent':
      return new CrewlyAgentAdapter();
    case 'claude-code':
    case 'codex-cli':
    case 'gemini-cli':
      return new CLIAdapter();
    default: {
      const _exhaustive: never = runtimeId;
      throw new Error(`Unknown runtime: ${_exhaustive}`);
    }
  }
}
