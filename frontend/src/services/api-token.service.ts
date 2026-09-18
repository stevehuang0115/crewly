/**
 * API Token Service
 *
 * The backend lets loopback callers in without credentials but requires a
 * shared API token from every other address. When the dashboard is opened
 * from a LAN/VPN address every `/api` call comes back `401
 * {error:'unauthorized'}` with a `WWW-Authenticate: Crewly-Token` challenge.
 *
 * This module:
 *  - keeps the token in localStorage (`crewly_api_token`) and mirrors it
 *    into the `crewly_token` cookie so images, static assets and WebSocket
 *    upgrades carry it automatically;
 *  - consumes a one-time `?token=` from the dashboard URL (printed by
 *    `crewly token --url`) and strips it from the address bar;
 *  - installs an axios interceptor and a `fetch` wrapper that add
 *    `X-Crewly-Token` to same-origin requests and raise a
 *    `crewly:api-token-required` window event on a token challenge so
 *    `ApiTokenPrompt` can ask the user for it.
 *
 * On loopback none of this is exercised — no 401 is ever produced.
 *
 * @module services/api-token.service
 */

import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  API_TOKEN_STORAGE_KEY,
  API_TOKEN_HEADER,
  API_TOKEN_COOKIE,
  API_TOKEN_QUERY_PARAM,
  API_TOKEN_AUTH_SCHEME,
  API_TOKEN_UNAUTHORIZED_ERROR,
  API_TOKEN_REQUIRED_EVENT,
  API_TOKEN_URL_EXCLUDED_PREFIX,
  API_TOKEN_COOKIE_MAX_AGE_SECONDS,
} from '../constants/api-token.constants';

/**
 * Read the stored API token.
 *
 * @returns Token or null when none is stored / storage is unavailable
 */
export function getApiToken(): string | null {
  try {
    const value = localStorage.getItem(API_TOKEN_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Mirror the token into the `crewly_token` cookie (or clear it).
 *
 * @param token - Token to set, or null to clear
 */
function writeCookie(token: string | null): void {
  try {
    const maxAge = token ? API_TOKEN_COOKIE_MAX_AGE_SECONDS : 0;
    document.cookie = `${API_TOKEN_COOKIE}=${encodeURIComponent(token ?? '')}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  } catch {
    // document may be unavailable (SSR/tests) — the header path still works.
  }
}

/**
 * Store the API token and mirror it into the cookie.
 *
 * @param token - Token to persist
 */
export function setApiToken(token: string): void {
  const trimmed = token.trim();
  try {
    localStorage.setItem(API_TOKEN_STORAGE_KEY, trimmed);
  } catch {
    // Storage blocked — the cookie still carries it for this session.
  }
  writeCookie(trimmed);
}

/**
 * Forget the stored token (storage + cookie).
 */
export function clearApiToken(): void {
  try {
    localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  writeCookie(null);
}

/**
 * Accept a one-time `?token=` from the dashboard URL, store it and strip
 * it from the address bar. Skipped on the Cloud OAuth callback route, whose
 * `?token=` is a Cloud JWT.
 *
 * @param loc - Location to inspect (defaults to `window.location`)
 * @param hist - History used to rewrite the URL (defaults to `window.history`)
 * @returns True when a token was consumed
 */
export function consumeTokenFromUrl(
  loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  hist: Pick<History, 'replaceState'> = window.history,
): boolean {
  if (loc.pathname.startsWith(API_TOKEN_URL_EXCLUDED_PREFIX)) return false;
  const params = new URLSearchParams(loc.search);
  const token = params.get(API_TOKEN_QUERY_PARAM);
  if (!token) return false;
  setApiToken(token);
  params.delete(API_TOKEN_QUERY_PARAM);
  const rest = params.toString();
  const cleaned = `${loc.pathname}${rest ? `?${rest}` : ''}${loc.hash ?? ''}`;
  try {
    hist.replaceState(null, '', cleaned);
  } catch {
    // Non-fatal: the token is stored either way.
  }
  return true;
}

/**
 * Whether a response is the backend's API-token challenge.
 *
 * @param status - HTTP status
 * @param wwwAuthenticate - `WWW-Authenticate` header value, if any
 * @param body - Parsed JSON body, if available
 * @returns True for a 401 carrying the Crewly-Token scheme or `error:'unauthorized'`
 */
export function isTokenChallenge(
  status: number,
  wwwAuthenticate?: string | null,
  body?: unknown,
): boolean {
  if (status !== 401) return false;
  if (wwwAuthenticate && wwwAuthenticate.startsWith(API_TOKEN_AUTH_SCHEME)) return true;
  const error = (body as { error?: unknown } | null | undefined)?.error;
  return error === API_TOKEN_UNAUTHORIZED_ERROR;
}

/**
 * Tell the UI a token is required (the `ApiTokenPrompt` listens for this).
 */
export function requestApiToken(): void {
  try {
    window.dispatchEvent(new CustomEvent(API_TOKEN_REQUIRED_EVENT));
  } catch {
    // ignore
  }
}

/**
 * Whether a request URL targets this dashboard's own backend (relative or
 * same-origin absolute). The token must never be sent to third parties
 * such as the Cloud API.
 *
 * @param url - Request URL
 * @returns True when the token may be attached
 */
export function isSameOriginRequest(url: string | undefined): boolean {
  if (!url) return true;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Append the token as a `token` query parameter to a WebSocket / Socket.IO
 * URL when one is stored.
 *
 * @param url - Base URL
 * @returns URL with `?token=` (or unchanged when no token is stored)
 */
export function withTokenQuery(url: string): string {
  const token = getApiToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${API_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Socket.IO `query` option carrying the token (empty when none is stored).
 *
 * @returns Query object for `io(url, { query })`
 */
export function getSocketTokenQuery(): Record<string, string> {
  const token = getApiToken();
  return token ? { [API_TOKEN_QUERY_PARAM]: token } : {};
}

/**
 * Install the axios interceptors: attach `X-Crewly-Token` to same-origin
 * requests, and raise the token-required event on a challenge.
 *
 * @param instance - Axios instance (defaults to the global one)
 */
export function installAxiosTokenInterceptors(instance: AxiosInstance = axios): void {
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = getApiToken();
    if (token && isSameOriginRequest(config.url)) {
      config.headers.set(API_TOKEN_HEADER, token);
    }
    return config;
  });
  instance.interceptors.response.use(
    (response) => {
      // Callers using `validateStatus: () => true` see the 401 here.
      if (isTokenChallenge(response.status, response.headers?.['www-authenticate'] as string | undefined, response.data)) {
        requestApiToken();
      }
      return response;
    },
    (error: AxiosError) => {
      const res = error.response;
      if (res && isTokenChallenge(res.status, res.headers?.['www-authenticate'] as string | undefined, res.data)) {
        requestApiToken();
      }
      return Promise.reject(error);
    },
  );
}

/**
 * Wrap `window.fetch` so same-origin calls carry the token header and a
 * challenge raises the token-required event. Many components call `fetch`
 * directly rather than going through axios.
 *
 * @param win - Window whose `fetch` to wrap (defaults to `window`)
 */
export function installFetchTokenGuard(win: Pick<Window, 'fetch'> = window): void {
  const original = win.fetch.bind(win);
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const token = getApiToken();
    let nextInit = init;
    if (token && isSameOriginRequest(url)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has(API_TOKEN_HEADER)) headers.set(API_TOKEN_HEADER, token);
      nextInit = { ...init, headers };
    }
    const response = await original(input, nextInit);
    if (isTokenChallenge(response.status, response.headers?.get?.('www-authenticate'))) {
      requestApiToken();
    }
    return response;
  };
  win.fetch = wrapped;
}

/**
 * One-shot bootstrap for `main.tsx`: consume `?token=`, re-sync the cookie
 * from storage, and install both interceptors.
 */
export function bootstrapApiToken(): void {
  consumeTokenFromUrl();
  const existing = getApiToken();
  if (existing) writeCookie(existing);
  installAxiosTokenInterceptors();
  installFetchTokenGuard();
}
