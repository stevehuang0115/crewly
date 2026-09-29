/**
 * Sign-in Needed Constants
 *
 * Tunables for the "Sign-in needed" chip / panel / banner that surface a
 * runtime OAuth sign-in (URL + device code) captured from an agent's
 * terminal by the backend's OAuth re-login monitor.
 *
 * @module constants/sign-in.constants
 */

export const SIGN_IN_CONSTANTS = {
  /** Backend endpoint listing every session waiting on a sign-in */
  PENDING_ENDPOINT: '/api/oauth/pending',
  /** How often the global banner re-polls the pending list */
  PENDING_POLL_INTERVAL_MS: 60_000,
  /** Request timeout for the pending poll */
  PENDING_REQUEST_TIMEOUT_MS: 5_000,
  /** How long the copy button shows "Copied" before reverting */
  COPIED_FEEDBACK_MS: 2_000,
  /** Chip label */
  CHIP_LABEL: 'Sign-in needed',
  /** How often the banner re-checks harness login state (and the pending list) */
  HARNESS_RECHECK_INTERVAL_MS: 30_000,
  /** localStorage key: dismissed pending-login set (dismissal lasts until the set changes) */
  DISMISSED_STORAGE_KEY: 'crewly.pendingLogins.dismissedKey',
  /** localStorage key: per-harness "a login completed at" marks */
  LOGIN_MARKS_STORAGE_KEY: 'crewly.harnessLogin.completedAt',
  /** localStorage key: last harness login states this browser saw */
  LAST_STATES_STORAGE_KEY: 'crewly.harnessLogin.lastStates',
} as const;
