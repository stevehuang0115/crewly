/**
 * Browser Extension Status Constants
 *
 * Time thresholds used to map a browser-extension instance's `lastSeenAt`
 * timestamp to a visual status (Online / Stale / Offline) on the Cloud
 * Portal Browser Extensions panel.
 *
 * Spec: `.crewly/specs/browser-ext-stale-status-fix-2026-04-30.md`
 *
 * @module constants/browser-ext-status.constants
 */

/**
 * Thresholds (in milliseconds) for browser-extension liveness rendering.
 *
 * - `ONLINE_THRESHOLD_MS` — last seen within this window is rendered as
 *   "Online" (emerald).
 * - `STALE_THRESHOLD_MS` — last seen within this window (but past
 *   ONLINE_THRESHOLD_MS) is rendered as "Stale" (amber).
 *
 * Beyond `STALE_THRESHOLD_MS`, or when `lastSeenAt` is missing/unparseable,
 * the instance is rendered as "Offline" (gray).
 */
export const BROWSER_EXT_STATUS = {
  ONLINE_THRESHOLD_MS: 30_000,
  STALE_THRESHOLD_MS: 60_000,
} as const;
