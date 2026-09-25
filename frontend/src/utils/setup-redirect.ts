/**
 * First-run Setup Redirect
 *
 * Decides whether the app should send the user to `/setup` on load, and
 * manages the "稍后再说 / Skip for now" flag that stops the redirect from
 * looping. localStorage access is wrapped because it throws in private
 * modes / sandboxed iframes.
 *
 * @module utils/setup-redirect
 */

import type { HarnessOverview } from '../types/harness.types';
import { SETUP_REDIRECT_EXEMPT_PREFIXES, SETUP_SKIP_STORAGE_KEY } from '../constants/harness.constants';

/**
 * Whether the harness setup is incomplete: no orc harness chosen, the orc
 * harness isn't installed, or it is known to be logged out. An `unknown`
 * login state does not count as incomplete.
 *
 * @param overview - Harness overview from `GET /api/harness`
 * @returns True when setup still needs the user
 */
export function needsHarnessSetup(overview: HarnessOverview): boolean {
  if (!overview.orcHarness) return true;
  const orc = overview.harnesses.find((h) => h.id === overview.orcHarness);
  // An orc on a runtime outside the harness list (crewly-agent, opencode…)
  // is configured elsewhere — setup has nothing to offer it.
  if (!orc) return false;
  if (!orc.installed) return true;
  return orc.loginState === 'logged_out';
}

/**
 * Whether the redirect may fire from this path (never from setup or auth pages).
 *
 * @param pathname - Current location pathname
 * @returns True when the path is not exempt
 */
export function isSetupRedirectAllowedFrom(pathname: string): boolean {
  return !SETUP_REDIRECT_EXEMPT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Read the skip flag.
 *
 * @returns True when the user chose "Skip for now" (false if storage is unavailable)
 */
export function isSetupSkipped(): boolean {
  try {
    return window.localStorage.getItem(SETUP_SKIP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Set or clear the skip flag. Storage failures are ignored.
 *
 * @param skipped - True to set, false to clear
 */
export function setSetupSkipped(skipped: boolean): void {
  try {
    if (skipped) {
      window.localStorage.setItem(SETUP_SKIP_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(SETUP_SKIP_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable: the redirect will simply fire again next load.
  }
}
