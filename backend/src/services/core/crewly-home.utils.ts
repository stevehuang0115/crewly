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

import * as fs from 'fs';
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

/**
 * Whether a directory is an installed package tree — anything under a
 * `node_modules` segment. `npm install` replaces such a tree wholesale, so
 * nothing the user owns may live inside it.
 *
 * @param dir - Absolute path
 * @returns True when the path contains a `node_modules` segment
 */
export function isInsidePackageTree(dir: string): boolean {
  return dir.split(/[\\/]/).includes('node_modules');
}

/**
 * The `.crewly` data directory for a project path.
 *
 * Normally `<projectPath>/.crewly`. When the "project" is really the npm
 * package directory — the cwd of a globally installed `crewly` service —
 * the Crewly home directory is returned instead, because anything written
 * under the package tree is deleted by the next `npm i -g crewly` (observed
 * on a production server on 2026-09-18: every mission, escalation, trigger
 * and request vanished on upgrade). Every per-project store that falls back
 * to `process.cwd()` must resolve its root through this helper.
 *
 * @param projectPath - Resolved project root (often `process.cwd()`)
 * @returns Absolute directory that holds the project's `.crewly` state
 *
 * @example
 * ```ts
 * resolveProjectDataDir('/repo');                            // "/repo/.crewly"
 * resolveProjectDataDir('/usr/lib/node_modules/crewly');     // "~/.crewly"
 * ```
 */
export function resolveProjectDataDir(projectPath: string): string {
  if (isInsidePackageTree(projectPath)) return getCrewlyHomePath();
  return path.join(projectPath, '.crewly');
}

/**
 * Per-project stores that older versions wrote under `<cwd>/.crewly` even
 * when cwd was the npm package directory. Listed so the boot-time rescue
 * knows what to carry over; anything else under the package tree is
 * regenerable.
 */
export const PACKAGE_TREE_STORES = [
  'missions',
  'escalations',
  'requests',
  'task-records',
  'triggers',
  'knowledge',
  'tasks',
  'agents-index.json',
] as const;

/**
 * One-time rescue for installs whose per-project state still lives inside
 * the npm package tree: copy each known store to the safe data directory
 * when the safe copy does not exist yet (or is an empty directory). Safe to
 * call at every boot — a no-op once the safe location is populated or the
 * legacy directory is gone. Never deletes the source.
 *
 * @param legacyDir - `<package>/.crewly`
 * @param safeDir - The directory returned by {@link resolveProjectDataDir}
 * @returns Names of the stores copied
 */
export function migrateLegacyProjectData(legacyDir: string, safeDir: string): string[] {
  if (path.resolve(legacyDir) === path.resolve(safeDir) || !fs.existsSync(legacyDir)) return [];
  const copied: string[] = [];
  for (const name of PACKAGE_TREE_STORES) {
    const from = path.join(legacyDir, name);
    const to = path.join(safeDir, name);
    if (!fs.existsSync(from)) continue;
    const fromIsDir = fs.statSync(from).isDirectory();
    if (fromIsDir && fs.readdirSync(from).length === 0) continue;
    if (fs.existsSync(to)) {
      if (!fs.statSync(to).isDirectory() || fs.readdirSync(to).length > 0) continue;
    }
    fs.mkdirSync(safeDir, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    copied.push(name);
  }
  return copied;
}
