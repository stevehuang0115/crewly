/**
 * The CLI is the owner (#999, specs/2026-10-03-owner-auth.md §4).
 *
 * Owner-only backend routes no longer treat "no agent header" as the owner,
 * so the CLI's calls to its own local backend (`crewly onboard`, `crewly
 * bundle`, harness logins, `crewly desktop`, …) present the owner API token.
 * It is read without being created (`CREWLY_API_TOKEN`, else
 * `<CREWLY_HOME>/api-token`), and only ever sent to this machine's backend.
 *
 * The same CLI run by an agent sends the same token, and the backend refuses
 * it: the client process descends from the backend (process-tree check).
 *
 * @module cli/utils/owner-token-fetch
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { readExistingApiToken } from '../../../backend/src/services/core/api-token.service.js';

/** Header the backend reads the owner API token from. */
const TOKEN_HEADER = 'X-Crewly-Token';

/** Hostnames that are this machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether a URL points at a backend on this machine.
 *
 * @param url - Request URL
 * @returns True for http(s)://localhost / 127.0.0.1 / [::1]
 */
export function isLocalBackendUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Axios instances already intercepted. */
const intercepted = new WeakSet<AxiosInstance>();

/** Options (tests). */
export interface OwnerTokenFetchOptions {
  /** Token source; defaults to {@link readExistingApiToken} */
  readToken?: () => string | null;
  /** Object whose `fetch` to wrap; defaults to globalThis */
  target?: { fetch: typeof fetch };
  /** Axios instance to intercept; defaults to the global one */
  axiosInstance?: AxiosInstance;
}

/**
 * Add the owner API token to every fetch / axios request the CLI makes to
 * its local backend. Idempotent per target.
 *
 * @param options - Injectable sources (tests)
 */
export function installOwnerTokenForLocalBackend(options: OwnerTokenFetchOptions = {}): void {
  const readToken = options.readToken ?? (() => {
    try {
      return readExistingApiToken();
    } catch {
      return null;
    }
  });
  const target = options.target ?? (globalThis as { fetch: typeof fetch });
  const marker = target as { __crewlyOwnerToken?: boolean };
  if (!marker.__crewlyOwnerToken && typeof target.fetch === 'function') {
    marker.__crewlyOwnerToken = true;
    const original = target.fetch.bind(target);
    target.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const token = isLocalBackendUrl(url) ? readToken() : null;
      if (!token) return original(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has(TOKEN_HEADER) && !headers.has('authorization')) headers.set(TOKEN_HEADER, token);
      return original(input, { ...init, headers });
    }) as typeof fetch;
  }
  const instance = options.axiosInstance ?? axios;
  if (intercepted.has(instance)) return;
  intercepted.add(instance);
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const url = config.baseURL && config.url && !/^https?:/i.test(config.url) ? `${config.baseURL}${config.url}` : config.url;
    const token = isLocalBackendUrl(url) ? readToken() : null;
    if (token && !config.headers.has(TOKEN_HEADER)) config.headers.set(TOKEN_HEADER, token);
    return config;
  });
}
