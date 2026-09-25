/**
 * Which runtime a bundle's agents run on.
 *
 * The bundle recommends one (e.g. `crewly-agent` + DeepSeek for marketing,
 * `claude-code` / `codex-cli` for development). On the owner's own machine,
 * though, only the orchestrator's harness is known to be installed and
 * logged in; on a hosted server the DeepSeek key is set. The rule:
 *
 * 1. an explicit runtime (API `runtime`, CLI `--runtime`) wins;
 * 2. the recommended runtime when this machine can run it: `crewly-agent`
 *    with a DeepSeek key, or a coding harness equal to the orchestrator's;
 * 3. otherwise the orchestrator's harness;
 * 4. otherwise the recommended runtime.
 *
 * @module services/bundle/bundle-runtime
 */

import { RUNTIME_TYPES } from '../../constants.js';

/** Inputs of {@link resolveBundleRuntime}. */
export interface RuntimeResolutionInput {
  recommended: string;
  requested?: string;
  /** The orchestrator's harness on this machine, if recorded */
  orcHarness: string | null;
  /** Whether a DeepSeek API key is configured (crewly-agent can run) */
  hasDeepseekKey: boolean;
}

/**
 * Pick the runtime for a bundle's members.
 *
 * @param input - Recommended / requested runtime and machine facts
 * @returns Runtime id
 *
 * @example
 * resolveBundleRuntime({ recommended: 'crewly-agent', orcHarness: 'claude-code', hasDeepseekKey: false }) // 'claude-code'
 */
export function resolveBundleRuntime(input: RuntimeResolutionInput): string {
  if (input.requested) return input.requested;
  if (input.recommended === RUNTIME_TYPES.CREWLY_AGENT && input.hasDeepseekKey) return input.recommended;
  if (input.orcHarness && input.recommended === input.orcHarness) return input.recommended;
  if (input.orcHarness) return input.orcHarness;
  return input.recommended;
}
