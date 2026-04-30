/**
 * Browser Instance Status Helper
 *
 * Pure mapping from a browser-extension instance's `lastSeenAt` timestamp
 * to a visual status used by the Cloud Portal Browser Extensions panel.
 *
 * The relay reports `lastSeenAt` per instance; without a threshold, every
 * instance is rendered as "Online" forever even when the extension has
 * gone away. This helper applies the spec'd thresholds so the UI flips
 * green → amber → gray as activity ages.
 *
 * Spec: `.crewly/specs/browser-ext-stale-status-fix-2026-04-30.md`
 *
 * @module utils/browser-instance-status
 */

import { BROWSER_EXT_STATUS } from '../constants/browser-ext-status.constants';

/**
 * Possible visual states for a browser-extension instance.
 *
 * - `online`  — recently active; full color (emerald).
 * - `stale`   — recent activity, but past the live window; amber.
 * - `offline` — no recent activity, or `lastSeenAt` missing/unparseable; gray.
 */
export type BrowserInstanceStatus = 'online' | 'stale' | 'offline';

/**
 * Determine the visual status of a browser-extension instance based on how
 * recently the relay reported activity.
 *
 * Boundary semantics:
 * - Age `≤ ONLINE_THRESHOLD_MS` → `'online'`.
 * - Age `≤ STALE_THRESHOLD_MS` (and past ONLINE) → `'stale'`.
 * - Otherwise → `'offline'`.
 * - Missing or unparseable `lastSeenAt` → `'offline'`.
 *
 * The function is pure and side-effect free; the `now` parameter is
 * injectable so tests can pin a deterministic clock.
 *
 * @param lastSeenAt - ISO timestamp string from `/api/browser/instances`,
 *   or `undefined` when the relay has never reported activity for the
 *   instance.
 * @param now - Optional reference time. Defaults to `new Date()`.
 * @returns One of `'online' | 'stale' | 'offline'`.
 *
 * @example
 * ```ts
 * getInstanceStatus(undefined);                 // 'offline'
 * getInstanceStatus(new Date().toISOString());  // 'online'
 * ```
 */
export function getInstanceStatus(
  lastSeenAt: string | undefined,
  now: Date = new Date(),
): BrowserInstanceStatus {
  if (!lastSeenAt) {
    return 'offline';
  }

  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) {
    return 'offline';
  }

  const ageMs = now.getTime() - lastSeenMs;

  // Future timestamps (clock skew) are treated as fresh — the relay clock
  // advancing past us is benign; rendering 'online' is the safe default.
  if (ageMs <= BROWSER_EXT_STATUS.ONLINE_THRESHOLD_MS) {
    return 'online';
  }

  if (ageMs <= BROWSER_EXT_STATUS.STALE_THRESHOLD_MS) {
    return 'stale';
  }

  return 'offline';
}
