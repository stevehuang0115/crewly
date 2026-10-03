/**
 * Caller Identity Constants
 *
 * The dashboard marks owner-initiated actions with `X-Crewly-Caller:
 * dashboard`. Since #999 the backend no longer TRUSTS this header — any
 * process can send it. Owner identity comes from the owner session cookie
 * plus the CSRF token (services/owner-session.service). The marker is kept
 * as a harmless label for older backends during the rollout.
 *
 * Mirrors `API_SECURITY_CONSTANTS.CALLER_HEADER` / `DASHBOARD_CALLER` in
 * `config/constants.ts` (the frontend bundle does not import the shared
 * config file).
 *
 * @module constants/caller.constants
 */

/** Request header naming who initiated the action. */
export const CALLER_HEADER = 'X-Crewly-Caller';

/** {@link CALLER_HEADER} value for actions taken in the dashboard. */
export const DASHBOARD_CALLER = 'dashboard';

/** Headers to spread into a dashboard request that performs an owner action. */
export const DASHBOARD_CALLER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [CALLER_HEADER]: DASHBOARD_CALLER,
});
