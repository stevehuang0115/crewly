/**
 * Owner Session Constants (#999, specs/2026-10-03-owner-auth.md).
 *
 * The dashboard proves it is the owner with an HttpOnly session cookie (set
 * by the backend on page load and by `GET /api/auth/session`) plus a CSRF
 * token it sends on every write. Mirrors `OWNER_AUTH_CONSTANTS` in
 * `config/constants.ts` (the frontend bundle does not import the shared
 * config file).
 *
 * @module constants/owner-session.constants
 */

/** Endpoint that issues / confirms the owner session and returns the CSRF token. */
export const OWNER_SESSION_ENDPOINT = '/api/auth/session';

/** Request header carrying the CSRF token. */
export const CSRF_HEADER = 'X-Crewly-CSRF';

/** `error` of the backend's 401 when a request has no owner credential. */
export const OWNER_AUTH_REQUIRED_ERROR = 'owner_auth_required';

/** HTTP methods that change state (need the CSRF header). */
export const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
