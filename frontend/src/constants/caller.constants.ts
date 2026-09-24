/**
 * Caller Identity Constants
 *
 * The dashboard marks owner-initiated actions with `X-Crewly-Caller:
 * dashboard` so the backend can tell a human click from an agent skill
 * (which sends `X-Agent-Session`) or an internal server-to-server call
 * (which sends neither). The per-member Start button relies on it: the
 * orchestrator's cold-launch approval gate applies to agents, not to the
 * owner starting their own agent (issue #775).
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
