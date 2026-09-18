/**
 * Mission Paths
 *
 * Single source of truth for WHERE Mission and Key Result documents live on
 * disk. Before this module existed, seven services and controllers each
 * carried their own `getMissionsDir()` and resolved the project root
 * differently (`process.cwd()` here, `CREWLY_PROJECT_PATH` there,
 * `CREWLY_MISSIONS_DIR` in exactly one place). Any deployment where those
 * three disagree would have the reminder sweep, the review service and the
 * REST controller reading three different stores — which is one of the
 * reasons the OKR loop never closed at runtime.
 *
 * Precedence (highest first):
 *   1. `CREWLY_MISSIONS_DIR`  — absolute override of the store itself
 *      (used by tests to isolate a temp dir; may also be used by ops).
 *   2. `CREWLY_PROJECT_PATH`  — project root; store is `<root>/.crewly/missions`.
 *   3. `process.cwd()`        — legacy default; store is `<cwd>/.crewly/missions`.
 *
 * Every function here re-reads the environment on each call (no module-level
 * caching) so tests that override `process.cwd` / env in `beforeEach` see the
 * change without a module reload.
 *
 * @module services/v3/mission-paths
 */

import * as path from 'path';
import { CREWLY_CONSTANTS, ENV_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var that overrides the missions store directory outright. */
export const MISSIONS_DIR_ENV = 'CREWLY_MISSIONS_DIR';

/** Folder under `.crewly` that holds one JSON file per Mission. */
export const MISSIONS_FOLDER = 'missions';

/** Folder under `<missionsDir>/<missionId>/` that holds one JSON per KR. */
export const KEY_RESULTS_FOLDER = 'key-results';

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve the project root the mission store hangs off.
 *
 * @returns `CREWLY_PROJECT_PATH` when set, otherwise `process.cwd()`
 */
export function getMissionProjectPath(): string {
  const fromEnv = process.env[ENV_CONSTANTS.CREWLY_PROJECT_PATH];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return process.cwd();
}

/**
 * Resolve the absolute missions directory.
 *
 * @param projectPath - Optional explicit project root. When given it is used
 *   instead of `CREWLY_PROJECT_PATH` / `process.cwd()`, but the
 *   `CREWLY_MISSIONS_DIR` override still wins so a test-isolated store is
 *   honoured by every caller (including services constructed with an
 *   explicit project path such as {@link EscalationService}).
 * @returns Absolute path to the directory holding `<missionId>.json` files
 *
 * @example
 * ```ts
 * getMissionsDir(); // "/repo/.crewly/missions"
 * ```
 */
export function getMissionsDir(projectPath?: string): string {
  const override = process.env[MISSIONS_DIR_ENV];
  if (override && override.length > 0) return override;
  const root = projectPath && projectPath.length > 0 ? projectPath : getMissionProjectPath();
  return path.join(root, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, MISSIONS_FOLDER);
}

/**
 * Absolute path of a single mission document.
 *
 * @param missionId - Mission id
 * @param projectPath - Optional explicit project root (see {@link getMissionsDir})
 * @returns `<missionsDir>/<missionId>.json`
 */
export function getMissionPath(missionId: string, projectPath?: string): string {
  return path.join(getMissionsDir(projectPath), `${missionId}.json`);
}

/**
 * Absolute path of the directory holding a mission's Key Result documents.
 *
 * @param missionId - Mission id
 * @param projectPath - Optional explicit project root (see {@link getMissionsDir})
 * @returns `<missionsDir>/<missionId>/key-results`
 */
export function getKeyResultsDir(missionId: string, projectPath?: string): string {
  return path.join(getMissionsDir(projectPath), missionId, KEY_RESULTS_FOLDER);
}
