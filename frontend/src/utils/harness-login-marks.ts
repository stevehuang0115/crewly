/**
 * Harness login marks
 *
 * Remembers, in this browser, when each harness (claude-code, codex-cli, …)
 * was last seen to finish a login — either a login-broker session reaching
 * `succeeded`, or the harness status flipping from not-logged-in to
 * `logged_in`. The "Sign-in needed" banner uses it to drop pending sign-ins
 * detected *before* that moment, so the banner clears itself after the
 * owner logs in instead of waiting for the next backend sweep.
 *
 * A blanket "harness says logged_in → hide" rule is deliberately not used:
 * harness status reads credential files, which still exist when a token has
 * expired, so it would hide a real sign-in prompt.
 *
 * Storage is best-effort (private windows, blocked storage): every access is
 * wrapped and the functions degrade to "no mark".
 *
 * @module utils/harness-login-marks
 */

import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';

/** Harness login state as reported by `GET /api/harness`. */
export type ObservedLoginState = 'logged_in' | 'logged_out' | 'unknown';

/**
 * Read a JSON object from localStorage.
 *
 * @param key - Storage key
 * @returns Parsed object, or an empty one
 */
function readMap(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Write a JSON object to localStorage (best-effort).
 *
 * @param key - Storage key
 * @param value - Object to store
 */
function writeMap(key: string, value: Record<string, string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: marks only live for this call.
  }
}

/**
 * Record that a harness finished logging in.
 *
 * @param harnessId - Harness / runtime id (e.g. `codex-cli`)
 * @param at - When (defaults to now)
 */
export function markHarnessLoggedIn(harnessId: string, at: Date = new Date()): void {
  const marks = readMap(SIGN_IN_CONSTANTS.LOGIN_MARKS_STORAGE_KEY);
  marks[harnessId] = at.toISOString();
  writeMap(SIGN_IN_CONSTANTS.LOGIN_MARKS_STORAGE_KEY, marks);
}

/**
 * When a harness last finished logging in, as seen by this browser.
 *
 * @param harnessId - Harness / runtime id
 * @returns Epoch ms, or null when never seen
 */
export function getHarnessLoggedInAt(harnessId: string): number | null {
  const iso = readMap(SIGN_IN_CONSTANTS.LOGIN_MARKS_STORAGE_KEY)[harnessId];
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Feed the latest harness login states; a harness that was last seen not
 * logged in and is now `logged_in` gets a login mark (now).
 *
 * @param states - Current state per harness id
 * @returns Ids that just transitioned to `logged_in`
 */
export function recordHarnessLoginStates(states: Record<string, ObservedLoginState>): string[] {
  const last = readMap(SIGN_IN_CONSTANTS.LAST_STATES_STORAGE_KEY);
  const transitioned: string[] = [];
  for (const [id, state] of Object.entries(states)) {
    const previous = last[id];
    if (state === 'logged_in' && previous !== undefined && previous !== 'logged_in') {
      markHarnessLoggedIn(id);
      transitioned.push(id);
    }
    last[id] = state;
  }
  writeMap(SIGN_IN_CONSTANTS.LAST_STATES_STORAGE_KEY, last);
  return transitioned;
}

/**
 * Whether a pending sign-in is already resolved: its harness is logged in
 * now and finished a login after the sign-in screen was detected.
 *
 * @param runtimeType - Pending entry's runtime (a harness id), or null
 * @param detectedAt - Pending entry's detection time (ISO)
 * @param currentState - Harness login state right now, if known
 * @returns True when the entry should be hidden
 */
export function isPendingLoginResolved(
  runtimeType: string | null,
  detectedAt: string,
  currentState: ObservedLoginState | undefined,
): boolean {
  if (!runtimeType || currentState !== 'logged_in') return false;
  const loggedInAt = getHarnessLoggedInAt(runtimeType);
  const detected = Date.parse(detectedAt);
  if (loggedInAt === null || Number.isNaN(detected)) return false;
  return loggedInAt >= detected;
}
