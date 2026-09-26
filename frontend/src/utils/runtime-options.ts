/**
 * Runtime picker options
 *
 * Which AI runtimes a picker offers, in which order, and under which label.
 * New choices never include a retired runtime (Gemini CLI, which stopped
 * serving individual accounts on 2026-06-18; Antigravity CLI replaces it).
 * A member, template or setting that already uses one keeps it: the picker
 * then lists it, marked "(enterprise only)", so it is neither lost nor
 * silently switched.
 *
 * @module utils/runtime-options
 */

import { RETIRED_AI_RUNTIMES, RETIRED_RUNTIME_LABEL_SUFFIX, type AIRuntime } from '../types/settings.types';

/** Order runtimes are offered in (retired ones last). */
export const RUNTIME_PICKER_ORDER: readonly AIRuntime[] = [
  'claude-code',
  'codex-cli',
  'antigravity-cli',
  'opencode-cli',
  'crewly-agent',
  'gemini-cli',
];

/** Labels used by the team-member runtime pickers. */
export const MEMBER_RUNTIME_LABELS: Record<AIRuntime, string> = {
  'claude-code': 'Claude CLI',
  'codex-cli': 'Codex CLI',
  'antigravity-cli': 'Antigravity CLI',
  'opencode-cli': 'OpenCode CLI',
  'crewly-agent': 'Crewly Agent',
  'gemini-cli': 'Gemini CLI',
};

/**
 * Whether a runtime is retired (kept for existing users only).
 *
 * @param runtime - Runtime id
 * @returns True for a retired runtime
 */
export function isRetiredRuntime(runtime: string | undefined | null): boolean {
  return typeof runtime === 'string' && (RETIRED_AI_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * The runtimes a picker should offer.
 *
 * @param current - The value currently selected (a retired one is kept on the list)
 * @returns Runtime ids in display order
 *
 * @example
 * ```typescript
 * getSelectableRuntimes('gemini-cli'); // [..., 'gemini-cli'] — existing member keeps it
 * getSelectableRuntimes('claude-code'); // no 'gemini-cli'
 * ```
 */
export function getSelectableRuntimes(current?: string | null): AIRuntime[] {
  return RUNTIME_PICKER_ORDER.filter((runtime) => !isRetiredRuntime(runtime) || runtime === current);
}

/**
 * Label for a runtime in a picker; a retired one is marked "(enterprise only)".
 *
 * @param runtime - Runtime id
 * @param labels - Label map (defaults to the member picker labels)
 * @returns Display label
 */
export function runtimeOptionLabel(runtime: AIRuntime, labels: Record<AIRuntime, string> = MEMBER_RUNTIME_LABELS): string {
  const base = labels[runtime] ?? runtime;
  return isRetiredRuntime(runtime) ? `${base}${RETIRED_RUNTIME_LABEL_SUFFIX}` : base;
}
