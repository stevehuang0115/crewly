/**
 * Owner Session Service (#999, specs/2026-10-03-owner-auth.md §3).
 *
 * The backend no longer treats "no agent header" as the owner. The
 * dashboard proves it is the owner with:
 *  - an HttpOnly, SameSite=Strict session cookie the backend sets on page
 *    load and on `GET /api/auth/session` (the browser sends it by itself);
 *  - a CSRF token from `GET /api/auth/session`, sent as `X-Crewly-CSRF` on
 *    every same-origin `/api` write.
 *
 * This module installs a `fetch` wrapper and an axios interceptor (the
 * dashboard uses the default axios instance only) that:
 *  - wait for the session bootstrap before a write and attach the CSRF header;
 *  - on `401 owner_auth_required` (the session ended — e.g. a backend
 *    restart while this tab stayed open) refresh the session once and retry
 *    the request once.
 *
 * Installed after the API-token interceptors, so a dashboard opened from
 * another machine bootstraps its session with the API token.
 *
 * @module services/owner-session.service
 */

import axios, { type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { isSameOriginRequest } from './api-token.service';
import { DASHBOARD_BUILD_HEADER, noteServerBuild } from './dashboard-build.service';
import { CSRF_HEADER, OWNER_AUTH_REQUIRED_ERROR, OWNER_SESSION_ENDPOINT, WRITE_METHODS } from '../constants/owner-session.constants';

let csrfToken: string | null = null;
let pending: Promise<string | null> | null = null;
let bootstrapFetch: typeof fetch | null = null;

/**
 * The path of a request URL, or null when it is not same-origin.
 *
 * @param url - Request URL
 * @returns Pathname or null
 */
function sameOriginPath(url: string | undefined): string | null {
  if (!url || !isSameOriginRequest(url)) return null;
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a request goes to this dashboard's own `/api` (and is not the
 * session bootstrap itself).
 *
 * @param url - Request URL
 * @returns True for a same-origin API call
 */
export function isOwnApiRequest(url: string | undefined): boolean {
  const path = sameOriginPath(url);
  return path !== null && path.startsWith('/api/') && path !== OWNER_SESSION_ENDPOINT;
}

/**
 * Whether a method changes state.
 *
 * @param method - HTTP method (default GET)
 * @returns True for POST / PUT / PATCH / DELETE
 */
export function isWriteMethod(method: string | undefined): boolean {
  return WRITE_METHODS.includes((method ?? 'GET').toUpperCase());
}

/**
 * Whether a response is the backend's "no owner credential" answer.
 *
 * @param status - HTTP status
 * @param body - Parsed body, if any
 * @returns True for 401 owner_auth_required
 */
export function isOwnerAuthChallenge(status: number, body: unknown): boolean {
  if (status !== 401) return false;
  const b = body as { error?: unknown; code?: unknown } | null | undefined;
  // `error` holds a human message for a browser without a session (what an
  // old tab shows); `code` always carries the machine-readable reason.
  return b?.error === OWNER_AUTH_REQUIRED_ERROR || b?.code === OWNER_AUTH_REQUIRED_ERROR;
}

/**
 * The current CSRF token (null until the session is bootstrapped).
 *
 * @returns Token or null
 */
export function getCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Get (or refresh) the owner session and its CSRF token. Concurrent callers
 * share one request.
 *
 * @param force - Refresh even when a token is held
 * @returns The CSRF token, or null when the backend refused a session
 */
export function ensureOwnerSession(force = false): Promise<string | null> {
  if (!force && csrfToken) return Promise.resolve(csrfToken);
  if (pending) return pending;
  const doFetch = bootstrapFetch ?? window.fetch.bind(window);
  pending = doFetch(OWNER_SESSION_ENDPOINT, { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      const body = (await res.json().catch(() => null)) as { data?: { csrfToken?: unknown } } | null;
      const token = res.ok && typeof body?.data?.csrfToken === 'string' ? body.data.csrfToken : null;
      csrfToken = token;
      return token;
    })
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * Wrap `window.fetch`: CSRF on same-origin API writes, and one refresh +
 * retry on `401 owner_auth_required`.
 *
 * @param win - Window whose fetch to wrap (defaults to `window`)
 */
export function installOwnerSessionFetch(win: Pick<Window, 'fetch'> = window): void {
  const inner = win.fetch.bind(win);
  bootstrapFetch = inner;
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!isOwnApiRequest(url)) return inner(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const write = isWriteMethod(method);
    // A Request body can be read once; keep a copy for the retry.
    const spare = input instanceof Request ? input.clone() : input;

    const withCsrf = (token: string | null): RequestInit | undefined => {
      if (!write || !token) return init;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set(CSRF_HEADER, token);
      return { ...init, headers };
    };

    const first = await inner(input, withCsrf(write ? await ensureOwnerSession() : null));
    noteServerBuild(first.headers?.get?.(DASHBOARD_BUILD_HEADER));
    if (first.status !== 401) return first;
    const body = await first.clone().json().catch(() => null);
    if (!isOwnerAuthChallenge(first.status, body)) return first;
    const token = await ensureOwnerSession(true);
    if (!token) return first;
    return inner(spare, withCsrf(token));
  };
  win.fetch = wrapped;
}

/** Marks a request config that was already retried once. */
type RetriableConfig = InternalAxiosRequestConfig & { __crewlyOwnerRetry?: boolean };

/**
 * Install the axios side: CSRF on same-origin API writes, one refresh +
 * retry on `401 owner_auth_required`.
 *
 * @param instance - Axios instance (defaults to the global one)
 */
export function installOwnerSessionAxios(instance: AxiosInstance = axios): void {
  instance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    if (isOwnApiRequest(config.url) && isWriteMethod(config.method)) {
      const token = await ensureOwnerSession();
      if (token) config.headers.set(CSRF_HEADER, token);
    }
    return config;
  });

  const retry = async (config: RetriableConfig | undefined, status: number, data: unknown): Promise<AxiosResponse | null> => {
    if (!config || config.__crewlyOwnerRetry || !isOwnApiRequest(config.url) || !isOwnerAuthChallenge(status, data)) return null;
    const token = await ensureOwnerSession(true);
    if (!token) return null;
    config.__crewlyOwnerRetry = true;
    if (isWriteMethod(config.method)) config.headers.set(CSRF_HEADER, token);
    return instance.request(config);
  };

  instance.interceptors.response.use(
    async (response) => {
      const served = (response.headers as Record<string, unknown> | undefined)?.[DASHBOARD_BUILD_HEADER.toLowerCase()];
      noteServerBuild(typeof served === 'string' ? served : undefined);
      return (await retry(response.config as RetriableConfig, response.status, response.data)) ?? response;
    },
    async (error) => {
      const res = error?.response as AxiosResponse | undefined;
      const retried = res ? await retry(error.config as RetriableConfig, res.status, res.data) : null;
      if (retried) return retried;
      return Promise.reject(error);
    },
  );
}

/**
 * One-shot bootstrap for `main.tsx` (after `bootstrapApiToken`): install
 * both sides and fetch the session right away so the first click is fast.
 */
export function bootstrapOwnerSession(): void {
  installOwnerSessionFetch();
  installOwnerSessionAxios();
  void ensureOwnerSession();
}

/**
 * Forget the session state (tests).
 */
export function resetOwnerSessionForTesting(): void {
  csrfToken = null;
  pending = null;
  bootstrapFetch = null;
}
