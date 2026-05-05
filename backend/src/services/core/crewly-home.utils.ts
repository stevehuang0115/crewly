/**
 * Crewly home directory resolution utility.
 *
 * Single source of truth for resolving the path the Crewly backend
 * should treat as `~/.crewly` for the current process. Honours the
 * `CREWLY_HOME` environment variable so test profiles, dry-run kits,
 * and ESTestNode acceptance harnesses can isolate their state from a
 * developer's real home directory.
 *
 * Why this exists
 * ---------------
 * Several callers used to inline `path.join(os.homedir(), '.crewly')`
 * directly. That pattern silently ignores `CREWLY_HOME`, so a test
 * harness that exports `CREWLY_HOME=/tmp/...` would still write into
 * the developer's real `~/.crewly`. That broke:
 *   - ESTestNode acceptance path
 *   - Mia's KR3 walkthrough on a `/tmp/...` profile (P0 surfaced
 *     2026-05-05 during the live walk-through pre-flight)
 *
 * Use this helper everywhere the backend needs the Crewly home path.
 * Do NOT re-implement the env read inline — that is the same
 * anti-pattern the bug above targeted.
 *
 * @module services/core/crewly-home.utils
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the Crewly home directory for the current process.
 *
 * Priority order:
 * 1. `process.env.CREWLY_HOME` (highest — for test profiles, dry-run
 *    kits, and ESTestNode acceptance harnesses).
 * 2. `path.join(os.homedir(), '.crewly')` (default for normal
 *    developer / production usage).
 *
 * An empty-string `CREWLY_HOME` is treated as unset (returns the
 * default). A whitespace-only value is treated as set (returned as-is)
 * — callers that care about that should validate the path themselves.
 *
 * @returns Absolute path to the Crewly home directory.
 *
 * @example
 * ```ts
 * import { getCrewlyHomePath } from './crewly-home.utils.js';
 *
 * const teamsDir = path.join(getCrewlyHomePath(), 'teams');
 * // CREWLY_HOME=/tmp/foo  → /tmp/foo/teams
 * // CREWLY_HOME unset      → /Users/<user>/.crewly/teams
 * ```
 */
export function getCrewlyHomePath(): string {
  const envValue = process.env.CREWLY_HOME;
  if (envValue && envValue.length > 0) {
    return envValue;
  }
  return path.join(os.homedir(), '.crewly');
}
