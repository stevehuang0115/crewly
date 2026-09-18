/**
 * API Token Constants
 *
 * Wire-level names the dashboard uses to present the server's API token
 * when it is opened from a non-loopback address. Mirrors
 * `API_SECURITY_CONSTANTS` in `config/constants.ts` (the frontend bundle
 * does not import the shared config file).
 *
 * @module constants/api-token.constants
 */

/** localStorage key holding the API token. */
export const API_TOKEN_STORAGE_KEY = 'crewly_api_token';

/** Request header the backend accepts the token on. */
export const API_TOKEN_HEADER = 'X-Crewly-Token';

/** Cookie name — lets `<img>`/asset/WebSocket requests carry the token. */
export const API_TOKEN_COOKIE = 'crewly_token';

/** Query parameter for WebSocket handshakes and the `crewly token --url` deep link. */
export const API_TOKEN_QUERY_PARAM = 'token';

/** `WWW-Authenticate` scheme the backend sends on a token challenge. */
export const API_TOKEN_AUTH_SCHEME = 'Crewly-Token';

/** `error` value in the 401 JSON body on a token challenge. */
export const API_TOKEN_UNAUTHORIZED_ERROR = 'unauthorized';

/** DOM event dispatched on `window` when a request was refused for lack of a token. */
export const API_TOKEN_REQUIRED_EVENT = 'crewly:api-token-required';

/** Path prefix whose `?token=` belongs to the Cloud OAuth callback, not to us. */
export const API_TOKEN_URL_EXCLUDED_PREFIX = '/auth/';

/** Cookie lifetime (one year) — the token is long-lived by design. */
export const API_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
