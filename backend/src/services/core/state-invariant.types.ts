/**
 * State Invariant Types
 *
 * Error types and helpers for boot-time state invariant checks (C1 of the
 * 2026-05-03 persistence-fix spec). The invariant is: a backend MUST NOT
 * start serving traffic if its on-disk state has been silently wiped while
 * a healthy backup snapshot exists. Booting in that condition would let
 * the UI present an "empty teams" page that the user might "fix" by
 * re-creating teams against the wiped state — destroying recovery options.
 *
 * @module services/core/state-invariant.types
 */

/**
 * Environment variable that operators can set to force-boot past an
 * invariant violation. Used for legitimate first-boot / explicit reset
 * scenarios where the empty state is intentional.
 *
 * Example: `CREWLY_FORCE_EMPTY_BOOT=1 npm start`
 */
export const FORCE_EMPTY_BOOT_ENV = 'CREWLY_FORCE_EMPTY_BOOT';

/**
 * Thrown when the boot-time state invariant check detects a mismatch
 * between live state (empty) and backup state (populated).
 *
 * Caller (boot sequence) should catch this and exit before HTTP server
 * starts, surfacing a clear remediation message.
 */
export class StateInvariantViolation extends Error {
  /** Number of teams found in the live state (typically 0 when this fires) */
  public readonly currentTeamCount: number;
  /** Number of teams found in the most-recent backup snapshot */
  public readonly backupTeamCount: number;
  /** ISO timestamp of the backup snapshot, if known */
  public readonly backupTimestamp: string | null;

  /**
   * Construct a StateInvariantViolation.
   *
   * @param message - Human-readable description with remediation hint
   * @param details - Counts and metadata for structured logging
   */
  constructor(
    message: string,
    details: {
      currentTeamCount: number;
      backupTeamCount: number;
      backupTimestamp: string | null;
    }
  ) {
    super(message);
    this.name = 'StateInvariantViolation';
    this.currentTeamCount = details.currentTeamCount;
    this.backupTeamCount = details.backupTeamCount;
    this.backupTimestamp = details.backupTimestamp;
  }
}

/**
 * Whether the current process has the FORCE_EMPTY_BOOT override active.
 *
 * @returns true when the env var is set to a truthy value ('1', 'true', 'yes')
 */
export function isForceEmptyBootActive(): boolean {
  const v = process.env[FORCE_EMPTY_BOOT_ENV];
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}
